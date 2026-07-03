/**
 * scheduler — single Worker.sync() that fires the 9 net-new tool capabilities
 * on cadence. The Notion Workers SDK ships built-in scheduling only for
 * worker.sync(); this wrapper gives every tool() in the autofill/audit family
 * a native schedule without each tool needing its own managed database.
 *
 * Cadence table (CADENCE) is the source of truth for "how often does X run."
 * Tweak in code, redeploy. Each tick (every 5 minutes) the scheduler:
 *   1. Reads the in-process `lastFire` cursor (carried in nextState).
 *   2. For each capability with a non-"manual" cadence, checks whether
 *      cadence has elapsed since the last attempt.
 *   3. Fires each due capability sequentially, recording start, status,
 *      duration, summary, and error in a managed "Worker Runs" DB.
 *   4. Updates `lastFire` regardless of success — errors retry on their
 *      regular interval, not every 5 minutes.
 *   5. Orders run-fleet-ops-daily before compose-morning-briefing when both
 *      are due so the briefing includes today's Fleet Ops digest.
 */
import * as Schema from "@notionhq/workers/schema";
import * as Builder from "@notionhq/workers/builder";
import { getNotionClient } from "../shared/notion-client.js";
import { executeAutofillTaskClients } from "./autofill-task-clients.js";
import { executeAutofillTaskPriority } from "./autofill-task-priority.js";
import { executeAutofillDocsProjects } from "./autofill-docs-projects.js";
import { executeAutofillMeetingDates } from "./autofill-meeting-dates.js";
import { executeAuditTimeLog } from "./audit-time-log.js";
import { executeAuditDevEnvironment } from "./audit-dev-environment.js";
import { executeRunFleetOpsDaily } from "./run-fleet-ops-daily.js";
import { executeComposeMorningBriefing } from "./compose-morning-briefing.js";
/* ── Cadence table ─────────────────────────────────────────────────
 * Intervals in seconds. "manual" means the scheduler never fires it.
 * Tweak and redeploy. */
const CADENCE_SECONDS = {
    "autofill-task-clients": 5 * 60,
    "autofill-task-priority": 5 * 60,
    "autofill-docs-projects": 5 * 60, // stub today — cheap no-op
    "autofill-meeting-dates": 5 * 60, // stub today — cheap no-op
    "audit-time-log": 24 * 60 * 60,
    "audit-dev-environment": 7 * 24 * 60 * 60,
    "run-fleet-ops-daily": 24 * 60 * 60,
    "compose-morning-briefing": 24 * 60 * 60,
    "route-inbox": "manual", // event-driven, never on a schedule
};
const DISPATCH = {
    "autofill-task-clients": async (notion) => {
        const r = await executeAutofillTaskClients({}, notion);
        return r.success
            ? { success: true, summary: r.summary }
            : { success: false, summary: "", error: r.error };
    },
    "autofill-task-priority": async (notion) => {
        const r = await executeAutofillTaskPriority({}, notion);
        return r.success
            ? { success: true, summary: r.summary }
            : { success: false, summary: "", error: r.error };
    },
    "autofill-docs-projects": async (notion) => {
        const r = await executeAutofillDocsProjects({}, notion);
        return r.success
            ? { success: true, summary: r.summary }
            : { success: false, summary: "", error: r.error };
    },
    "autofill-meeting-dates": async (notion) => {
        const r = await executeAutofillMeetingDates({}, notion);
        return r.success
            ? { success: true, summary: r.summary }
            : { success: false, summary: "", error: r.error };
    },
    "audit-time-log": async (notion) => {
        const r = await executeAuditTimeLog({}, notion);
        return r.success
            ? { success: true, summary: r.summary }
            : { success: false, summary: "", error: r.error };
    },
    "audit-dev-environment": async (notion) => {
        const r = await executeAuditDevEnvironment({}, notion);
        return r.success
            ? { success: true, summary: r.summary }
            : { success: false, summary: "", error: r.error };
    },
    "run-fleet-ops-daily": async (notion) => {
        const r = await executeRunFleetOpsDaily({}, notion);
        return r.success
            ? { success: true, summary: r.summary }
            : { success: false, summary: "", error: r.error };
    },
    "compose-morning-briefing": async (notion) => {
        const r = await executeComposeMorningBriefing({}, notion);
        return r.success
            ? { success: true, summary: r.summary }
            : { success: false, summary: "", error: r.error };
    },
};
/* ── Managed-DB schema ─────────────────────────────────────────────
 * Append-only audit log; PK = synthetic per-fire id (`<cap>@<isoTs>`). */
export const workerRunsSchema = {
    defaultName: "Worker Runs",
    properties: {
        "Run ID": Schema.title(),
        Capability: Schema.richText(),
        Status: Schema.select([
            { name: "Success" },
            { name: "Error" },
        ]),
        "Triggered At": Schema.date(),
        "Duration (ms)": Schema.number(),
        Summary: Schema.richText(),
        Error: Schema.richText(),
    },
};
function parseState(raw) {
    if (raw && typeof raw === "object" && "lastFire" in raw) {
        const lf = raw.lastFire;
        if (lf && typeof lf === "object") {
            return { lastFire: lf };
        }
    }
    return { lastFire: {} };
}
function elapsedSeconds(fromIso, nowMs) {
    if (!fromIso)
        return Number.POSITIVE_INFINITY;
    const t = Date.parse(fromIso);
    if (isNaN(t))
        return Number.POSITIVE_INFINITY;
    return (nowMs - t) / 1000;
}
function truncate(s, max = 1800) {
    if (s.length <= max)
        return s;
    return s.slice(0, max - 12).trimEnd() + "\n…[truncated]";
}
/* ── Execute ───────────────────────────────────────────────────────
 * One tick of the scheduler. Returns one upsert change per fired
 * capability and an updated `lastFire` map. */
export async function executeScheduler(rawState, _context) {
    const state = parseState(rawState);
    const notion = getNotionClient();
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    // 1. Pick due capabilities.
    const due = [];
    for (const [cap, cadence] of Object.entries(CADENCE_SECONDS)) {
        if (cadence === "manual")
            continue;
        if (elapsedSeconds(state.lastFire[cap], nowMs) >= cadence)
            due.push(cap);
    }
    // 2. Order: fleet-ops before briefing so the briefing sees today's Fleet
    //    Ops digest. Stable sort with that one explicit pair.
    due.sort((a, b) => {
        if (a === "run-fleet-ops-daily" && b === "compose-morning-briefing")
            return -1;
        if (a === "compose-morning-briefing" && b === "run-fleet-ops-daily")
            return 1;
        return 0;
    });
    if (due.length === 0) {
        return { changes: [], hasMore: false, nextState: state };
    }
    // 3. Fire each due capability sequentially. Record an audit row per fire.
    // Build each change with `buildChange` so TS infers the strict property
    // shape from the schema rather than widening to Record<string, unknown>.
    const buildChange = (runId, cap, startIso, durationMs, result) => ({
        type: "upsert",
        key: runId,
        properties: {
            "Run ID": Builder.title(runId),
            Capability: Builder.richText(cap),
            Status: Builder.select(result.success ? "Success" : "Error"),
            "Triggered At": Builder.dateTime(startIso),
            "Duration (ms)": Builder.number(durationMs),
            Summary: Builder.richText(truncate(result.summary)),
            Error: Builder.richText(truncate(result.error ?? "")),
        },
    });
    const changes = [];
    const newLastFire = { ...state.lastFire };
    for (const cap of due) {
        const startMs = Date.now();
        const startIso = new Date(startMs).toISOString();
        let result;
        try {
            const dispatcher = DISPATCH[cap];
            if (!dispatcher) {
                result = { success: false, summary: "", error: `No dispatcher registered for ${cap}` };
            }
            else {
                result = await dispatcher(notion);
            }
        }
        catch (e) {
            result = {
                success: false,
                summary: "",
                error: e instanceof Error ? e.message : String(e),
            };
        }
        const durationMs = Date.now() - startMs;
        // Update lastFire regardless of outcome — errors retry on the regular
        // interval, not every 5 minutes.
        newLastFire[cap] = startIso;
        const runId = `${cap}@${startIso}`;
        changes.push(buildChange(runId, cap, startIso, durationMs, result));
        console.log(`[scheduler] ${cap} ${result.success ? "ok" : "ERR"} ${durationMs}ms ${result.success ? result.summary : result.error}`);
    }
    // `nowIso` is captured here so an explicit "tick boundary" exists in logs
    // even when no capability fired (the early return above handles that case).
    void nowIso;
    return {
        changes,
        hasMore: false,
        nextState: { lastFire: newLastFire },
    };
}
