import { extractErrorMessage, getClientsDatabaseId, getTasksDatabaseId, getTimeLogDatabaseId, queryAllDatabase, } from "../shared/notion-client.js";
import { executeWriteAgentDigest } from "./write-agent-digest.js";
import { backfillTimeLogRelations, loadTimeLogEntriesNeedingRelations, loadUniqueIdMaps, } from "../shared/time-log-relations.js";
function readTitle(properties, propName = "Task Name") {
    const t = properties?.[propName];
    if (!t || typeof t !== "object" || !("title" in t))
        return "";
    const arr = t.title;
    return arr?.map((seg) => seg.plain_text).join("") ?? "";
}
function readRelationIds(properties, propName) {
    const prop = properties?.[propName];
    if (!prop || typeof prop !== "object" || !("relation" in prop))
        return [];
    const rel = prop.relation;
    return (rel ?? []).map((r) => r.id);
}
function readNumber(properties, propName) {
    const p = properties?.[propName];
    if (!p || typeof p !== "object" || !("number" in p))
        return 0;
    const n = p.number;
    return typeof n === "number" ? n : 0;
}
function readStatus(properties) {
    const p = properties?.["Status"];
    if (!p || typeof p !== "object")
        return "";
    if ("status" in p) {
        return (p.status?.name) ?? "";
    }
    if ("select" in p) {
        return (p.select?.name) ?? "";
    }
    return "";
}
function readDateStart(properties, propName) {
    const p = properties?.[propName];
    if (!p || typeof p !== "object" || !("date" in p))
        return null;
    const d = p.date;
    return d?.start ?? null;
}
function readLastEditedTime(page) {
    return page.last_edited_time ?? null;
}
function todayChicago() {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Chicago",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(new Date());
    const y = parts.find((p) => p.type === "year")?.value ?? "";
    const m = parts.find((p) => p.type === "month")?.value ?? "";
    const d = parts.find((p) => p.type === "day")?.value ?? "";
    return `${y}-${m}-${d}`;
}
function startOfMonth(isoDate) {
    return `${isoDate.slice(0, 7)}-01`;
}
const CLOSED_STATUSES = new Set(["Done", "Closed", "Completed", "Resolved", "Shipped", "Released"]);
export async function executeAuditTimeLog(input, notion) {
    const startMs = Date.now();
    const dryRun = input.dry_run ?? false;
    const writeDigest = input.write_digest ?? true;
    const backfillRelations = input.backfill_relations ?? true;
    const today = input.today ?? todayChicago();
    const lookbackDays = input.active_task_lookback_days ?? 7;
    // Keep the whole capability under the ~60s platform hard stop: cap the
    // backfill and stop it at a wall-clock deadline (leaves headroom for the
    // findings scan that already ran + the digest write). Idempotent + daily,
    // so a bounded chunk per run converges over a few days.
    // Cap is a safety backstop; the wall-clock deadline is the real limiter.
    // Keep it high enough that a run processes PAST any prefix of unfillable
    // entries (empty source + no mappable title) to reach fillable ones behind.
    const BACKFILL_MAX_ENTRIES = 250;
    const BACKFILL_DEADLINE_MS = startMs + 50_000;
    try {
        const tasksDbId = getTasksDatabaseId();
        const timeLogDbId = getTimeLogDatabaseId();
        const clientsDbId = getClientsDatabaseId();
        // 1. Pull tasks + time entries + clients in parallel.
        // Time Log can be very large; only scan entries from the current billing
        // period (this month) and the lookback window, whichever is earlier.
        const periodStartEarly = (() => {
            const lookback = new Date(today);
            lookback.setDate(lookback.getDate() - lookbackDays);
            const monthStart = startOfMonth(today);
            const lookbackStr = lookback.toISOString().slice(0, 10);
            return lookbackStr < monthStart ? lookbackStr : monthStart;
        })();
        const [taskPages, timeLogPages, clientPages] = await Promise.all([
            queryAllDatabase(notion, tasksDbId, {}),
            queryAllDatabase(notion, timeLogDbId, {
                filter: { property: "Date", date: { on_or_after: periodStartEarly } },
            }),
            queryAllDatabase(notion, clientsDbId, {}),
        ]);
        // 2. Index time entries by Task + Client, summing hours
        const hoursByTaskId = new Map();
        const hoursByClientThisPeriod = new Map();
        const taskHasEntries = new Set();
        const periodStart = startOfMonth(today);
        for (const page of timeLogPages) {
            const p = page;
            const hours = readNumber(p.properties, "Hours");
            // Time Log has two task-relation columns ("Task" and "✅ Tasks") — read both.
            const taskIds = [
                ...readRelationIds(p.properties, "Task"),
                ...readRelationIds(p.properties, "✅ Tasks"),
            ];
            for (const taskId of taskIds) {
                taskHasEntries.add(taskId);
                hoursByTaskId.set(taskId, (hoursByTaskId.get(taskId) ?? 0) + hours);
            }
            const entryDate = readDateStart(p.properties, "Date");
            if (entryDate && entryDate >= periodStart) {
                for (const clientId of readRelationIds(p.properties, "Client")) {
                    hoursByClientThisPeriod.set(clientId, (hoursByClientThisPeriod.get(clientId) ?? 0) + hours);
                }
            }
        }
        // 3. Missed logging — open task edited within lookbackDays but no entries
        const lookbackCutoff = new Date(today);
        lookbackCutoff.setDate(lookbackCutoff.getDate() - lookbackDays);
        const lookbackCutoffISO = lookbackCutoff.toISOString();
        const missedLogging = [];
        const unbilledTasks = [];
        for (const page of taskPages) {
            const p = page;
            const status = readStatus(p.properties);
            const isClosed = CLOSED_STATUSES.has(status);
            const title = readTitle(p.properties);
            const hasEntries = taskHasEntries.has(p.id);
            const lastEdited = readLastEditedTime(p);
            if (!isClosed && lastEdited && lastEdited >= lookbackCutoffISO && !hasEntries) {
                missedLogging.push({
                    task_id: p.id,
                    task_title: title,
                    last_activity_date: lastEdited.slice(0, 10),
                });
            }
            if (isClosed && !hasEntries) {
                unbilledTasks.push({
                    task_id: p.id,
                    task_title: title,
                    closed_at: lastEdited ? lastEdited.slice(0, 10) : null,
                });
            }
        }
        // 4. Retainer overruns
        // The Clients DB in this workspace doesn't have a "Retainer Hours" column;
        // it stores "Monthly Rate" + "Hourly Rate" instead. When a number column
        // exists, treat it as the cap; otherwise the check is a no-op (overruns
        // stays empty) so the audit still produces a useful digest.
        const overruns = [];
        for (const page of clientPages) {
            const p = page;
            const cap = readNumber(p.properties, "Retainer Hours");
            if (cap <= 0)
                continue;
            const actual = hoursByClientThisPeriod.get(p.id) ?? 0;
            if (actual > cap) {
                overruns.push({
                    client_id: p.id,
                    client_name: readTitle(p.properties, "Client Name"),
                    retainer_cap_hours: cap,
                    actual_hours_this_period: actual,
                    overrun_hours: actual - cap,
                    period_start: periodStart,
                });
            }
        }
        // 4.5 Backfill relations on Time Log entries (GitHub Item first, then Task).
        // Idempotent — fills only empty Client/Project/Task/GitHub Item fields.
        const errorDetails = [];
        let backfill = null;
        if (backfillRelations) {
            const [candidates, uidMaps] = await Promise.all([
                loadTimeLogEntriesNeedingRelations(notion),
                loadUniqueIdMaps(notion),
            ]);
            backfill = await backfillTimeLogRelations(notion, candidates, {
                dryRun,
                maxEntries: BACKFILL_MAX_ENTRIES,
                deadlineMs: BACKFILL_DEADLINE_MS,
                uidMaps,
            });
            console.log("[audit-time-log]", `Backfill: considered ${backfill.considered}, updated ${backfill.updated}, still unlinked ${backfill.stillUnlinkedIds.length}, remaining ${backfill.remaining}${backfill.stoppedEarly ? " (stopped early)" : ""}, errors ${backfill.errors}`);
            if (backfill.errors > 0) {
                errorDetails.push(`Relation backfill: ${backfill.errors} entry error(s)`);
            }
        }
        // 5. Optional digest
        let digestUrl = null;
        if (writeDigest && !dryRun) {
            const summary = `Missed: ${missedLogging.length}; Overruns: ${overruns.length}; Unbilled: ${unbilledTasks.length}`;
            const flagged = [
                ...missedLogging.slice(0, 25).map((m) => ({
                    description: `Missed logging — ${m.task_title} (last activity ${m.last_activity_date})`,
                    task_link: `notion://page/${m.task_id}`,
                })),
                ...overruns.slice(0, 25).map((o) => ({
                    description: `Retainer overrun — ${o.client_name}: ${o.actual_hours_this_period}h vs ${o.retainer_cap_hours}h cap (+${o.overrun_hours}h)`,
                    no_task_reason: "billing review",
                })),
                ...unbilledTasks.slice(0, 25).map((u) => ({
                    description: `Unbilled closed task — ${u.task_title}${u.closed_at ? ` (closed ${u.closed_at})` : ""}`,
                    task_link: `notion://page/${u.task_id}`,
                })),
            ];
            const total = missedLogging.length + overruns.length + unbilledTasks.length;
            const digestResult = await executeWriteAgentDigest({
                agent_name: "Time Log Auditor",
                agent_emoji: "⏱️",
                status_type: "report",
                status_value: total === 0 ? "complete" : "full_report",
                run_time_chicago: new Date().toISOString(),
                scope: `Tasks edited in last ${lookbackDays}d; Time Log YTD; Clients with retainer caps`,
                input_versions: `today=${today} periodStart=${periodStart}`,
                flagged_items: flagged,
                actions_taken: { created_tasks: [], updated_tasks: [] },
                summary,
                needs_review: [],
                escalations: [],
                target_database: "agent_ops",
                doc_type: "Agent Digest",
            }, notion);
            if (digestResult.success) {
                digestUrl = digestResult.page_url;
            }
            else {
                // Surface — do NOT swallow. A failed digest write is what silently
                // froze the audit page before.
                console.error("[audit-time-log] digest write failed:", digestResult.error);
                errorDetails.push(`Digest write failed: ${digestResult.error}`);
            }
        }
        const backfillNote = backfill
            ? ` Relations filled — Client ${backfill.filled.client}, Project ${backfill.filled.project}, Task ${backfill.filled.task}, GitHub Item ${backfill.filled.githubItem}; still unlinked ${backfill.stillUnlinkedIds.length}${backfill.remaining > 0 ? `; ${backfill.remaining} deferred to next run` : ""}.`
            : "";
        const summary = `Missed logging: ${missedLogging.length}; Retainer overruns: ${overruns.length}; Unbilled: ${unbilledTasks.length}.${backfillNote}`;
        console.log("[audit-time-log]", summary);
        return {
            success: true,
            missed_logging: missedLogging,
            retainer_overruns: overruns,
            unbilled_tasks: unbilledTasks,
            digest_page_url: digestUrl,
            relations_filled: backfill?.filled ?? null,
            relations_unlinked_count: backfill?.stillUnlinkedIds.length ?? null,
            relations_deferred_count: backfill?.remaining ?? null,
            error_details: errorDetails,
            summary,
        };
    }
    catch (e) {
        const message = extractErrorMessage(e);
        console.error("[audit-time-log] fatal:", message);
        return { success: false, error: message };
    }
}
