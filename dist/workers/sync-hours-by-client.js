import { getTimeLogDatabaseId, getNtnApiToken, extractErrorMessage, queryDatabase } from "../shared/notion-client.js";
const TAG = "[sync-hours-by-client]";
/** Notion property name for the billing rate on Clients and Projects. */
const RATE_PROP = "Effective Rate";
/* ── Property readers ────────────────────────────────────────────────────── */
function readNumber(properties, propName) {
    const p = properties?.[propName];
    if (!p || typeof p !== "object" || !("number" in p))
        return 0;
    const n = p.number;
    return n ?? 0;
}
function readNumberOrNull(properties, propName) {
    const p = properties?.[propName];
    if (!p || typeof p !== "object" || !("number" in p))
        return null;
    const n = p.number;
    return n ?? null;
}
function readCheckbox(properties, propName) {
    const p = properties?.[propName];
    if (!p || typeof p !== "object" || !("checkbox" in p))
        return false;
    return p.checkbox === true;
}
function readRelationIds(properties, propName) {
    const prop = properties?.[propName];
    if (!prop || typeof prop !== "object" || !("relation" in prop))
        return [];
    const rel = prop.relation;
    return (rel ?? []).map((r) => r.id);
}
function readTitle(properties) {
    const t = properties?.["Name"] ?? properties?.["Title"] ?? properties?.["Description"];
    if (!t || typeof t !== "object" || !("title" in t))
        return "";
    const arr = t.title;
    return arr?.map((seg) => seg.plain_text).join("") ?? "";
}
async function queryTimeLog(notion, lookbackDays) {
    const dbId = getTimeLogDatabaseId();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - lookbackDays);
    const cutoffIso = cutoff.toISOString().split("T")[0];
    const filter = {
        property: "Date",
        date: { on_or_after: cutoffIso },
    };
    const rows = [];
    let cursor;
    do {
        const resp = await queryDatabase(notion, dbId, {
            filter: filter,
            start_cursor: cursor,
            page_size: 100,
        });
        for (const page of resp.results) {
            if (!("properties" in page))
                continue;
            const props = page.properties;
            rows.push({
                hours: readNumber(props, "Hours"),
                billable: readCheckbox(props, "Billable"),
                clientIds: readRelationIds(props, "Client"),
                projectIds: readRelationIds(props, "Project"),
            });
        }
        cursor = resp.has_more ? resp.next_cursor ?? undefined : undefined;
    } while (cursor);
    return rows;
}
async function resolveEntities(notion, ids) {
    const map = new Map();
    if (ids.length === 0)
        return map;
    for (const id of ids) {
        try {
            const page = await notion.pages.retrieve({ page_id: id });
            if (!("properties" in page)) {
                map.set(id, { name: `[${id.slice(0, 8)}…]`, rate: null });
                continue;
            }
            const props = page.properties;
            const name = readTitle(props) || `[${id.slice(0, 8)}…]`;
            const rate = readNumberOrNull(props, RATE_PROP);
            map.set(id, { name, rate });
        }
        catch {
            map.set(id, { name: `[${id.slice(0, 8)}…]`, rate: null });
        }
    }
    return map;
}
function aggregate(rows) {
    const clientBuckets = new Map();
    let unlinkedHours = 0;
    let unlinkedCount = 0;
    let totalHours = 0;
    for (const row of rows) {
        totalHours += row.hours;
        if (row.clientIds.length === 0) {
            unlinkedHours += row.hours;
            unlinkedCount++;
            continue;
        }
        // If a row links to multiple clients, split evenly
        const share = row.hours / row.clientIds.length;
        for (const clientId of row.clientIds) {
            let bucket = clientBuckets.get(clientId);
            if (!bucket) {
                bucket = { totalHours: 0, billableHours: 0, entryCount: 0, projects: new Map() };
                clientBuckets.set(clientId, bucket);
            }
            bucket.totalHours += share;
            if (row.billable)
                bucket.billableHours += share;
            bucket.entryCount++;
            // Project breakdown — use first project ID or "__none__" sentinel
            const projectKey = row.projectIds.length > 0 ? row.projectIds[0] : "__none__";
            let projBucket = bucket.projects.get(projectKey);
            if (!projBucket) {
                projBucket = { totalHours: 0, billableHours: 0, entryCount: 0 };
                bucket.projects.set(projectKey, projBucket);
            }
            projBucket.totalHours += share;
            if (row.billable)
                projBucket.billableHours += share;
            projBucket.entryCount++;
        }
    }
    return { clientBuckets, unlinkedHours, unlinkedCount, totalHours, totalEntries: rows.length };
}
/* ── Phase 4: Build output shape with rates ──────────────────────────────── */
function buildClientSummaries(clientBuckets, clientEntities, projectEntities, defaultRate) {
    const summaries = [];
    for (const [clientId, bucket] of clientBuckets) {
        const clientEntity = clientEntities.get(clientId) ?? { name: `[${clientId.slice(0, 8)}…]`, rate: null };
        const clientRate = clientEntity.rate;
        const projects = [];
        let totalBillableValue = null;
        for (const [projectKey, projBucket] of bucket.projects) {
            let projectRate = null;
            let projectName;
            if (projectKey === "__none__") {
                projectName = "(no project)";
            }
            else {
                const projEntity = projectEntities.get(projectKey);
                projectName = projEntity?.name ?? `[${projectKey.slice(0, 8)}…]`;
                projectRate = projEntity?.rate ?? null;
            }
            // Rate cascade: project rate → client rate → default → null
            const effectiveRate = projectRate ?? clientRate ?? defaultRate ?? null;
            const billableValue = effectiveRate !== null ? round2(projBucket.billableHours * effectiveRate) : null;
            if (billableValue !== null) {
                totalBillableValue = round2((totalBillableValue ?? 0) + billableValue);
            }
            projects.push({
                project_name: projectName,
                rate_per_hour: effectiveRate,
                total_hours: round2(projBucket.totalHours),
                billable_hours: round2(projBucket.billableHours),
                non_billable_hours: round2(projBucket.totalHours - projBucket.billableHours),
                billable_value: billableValue,
                entry_count: projBucket.entryCount,
            });
        }
        // Sort projects by total hours descending
        projects.sort((a, b) => b.total_hours - a.total_hours);
        summaries.push({
            client_name: clientEntity.name,
            client_rate_per_hour: clientRate,
            total_hours: round2(bucket.totalHours),
            billable_hours: round2(bucket.billableHours),
            non_billable_hours: round2(bucket.totalHours - bucket.billableHours),
            total_billable_value: totalBillableValue,
            entry_count: bucket.entryCount,
            projects,
        });
    }
    // Sort clients by total hours descending
    summaries.sort((a, b) => b.total_hours - a.total_hours);
    return summaries;
}
function round2(n) {
    return Math.round(n * 100) / 100;
}
/* ── Phase 5: Build markdown + write to Notion page ─────────────────────── */
/** Escape enhanced-markdown special characters in user-provided text. */
function esc(s) {
    return s
        .replace(/\\/g, "\\\\")
        .replace(/\*/g, "\\*")
        .replace(/~/g, "\\~")
        .replace(/`/g, "\\`")
        .replace(/\$/g, "\\$")
        .replace(/\[/g, "\\[")
        .replace(/\]/g, "\\]")
        .replace(/</g, "\\<")
        .replace(/>/g, "\\>")
        .replace(/\{/g, "\\{")
        .replace(/\}/g, "\\}")
        .replace(/\|/g, "\\|")
        .replace(/\^/g, "\\^");
}
/** Format dollar value — escapes $ for enhanced markdown. */
function fmt$(value) {
    if (value === null)
        return "—";
    return `\\$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
/** Format hourly rate — escapes $ for enhanced markdown. */
function fmtRate(rate) {
    if (rate === null)
        return "no rate set";
    return `\\$${rate}/hr`;
}
function buildPageMarkdown(snapshotDate, lookbackDays, totalHours, totalBillable, totalBillableValue, totalEntries, clients, unlinkedHours, unlinkedCount) {
    const lines = [];
    const valueStr = totalBillableValue > 0 ? ` \\| Billable value: ${fmt$(totalBillableValue)}` : "";
    const summary = `Hours by Client — Snapshot: ${snapshotDate} \\| Lookback: ${lookbackDays}d \\| Entries: ${totalEntries} \\| Total: ${totalHours.toFixed(1)}h (${totalBillable.toFixed(1)}h billable)${valueStr}`;
    lines.push(`<callout icon="📊" color="blue_bg">`);
    lines.push(`\t${summary}`);
    lines.push(`</callout>`);
    lines.push("");
    lines.push("---");
    for (const client of clients) {
        const billPct = client.total_hours > 0
            ? Math.round((client.billable_hours / client.total_hours) * 100)
            : 0;
        const valueLabel = client.total_billable_value !== null
            ? ` \\| ${fmt$(client.total_billable_value)} billable`
            : "";
        lines.push("");
        lines.push(`## ${esc(client.client_name)} — ${client.total_hours.toFixed(1)}h (${billPct}% billable, ${client.entry_count} entries)${valueLabel}`);
        if (client.client_rate_per_hour !== null) {
            lines.push(`- Client rate: ${fmtRate(client.client_rate_per_hour)}`);
        }
        for (const proj of client.projects) {
            const projBillPct = proj.total_hours > 0
                ? Math.round((proj.billable_hours / proj.total_hours) * 100)
                : 0;
            const projValueStr = proj.billable_value !== null
                ? ` → ${fmt$(proj.billable_value)} billable value`
                : "";
            const rateNote = proj.rate_per_hour !== null ? ` @ ${fmtRate(proj.rate_per_hour)}` : "";
            lines.push(`- ${esc(proj.project_name)}${rateNote}: ${proj.total_hours.toFixed(1)}h — ${proj.billable_hours.toFixed(1)}h billable (${projBillPct}%)${projValueStr} \\| ${proj.entry_count} entries`);
        }
        lines.push("");
        lines.push("<empty-block/>");
    }
    if (unlinkedHours > 0) {
        lines.push("---");
        lines.push("");
        lines.push(`### ⚠️ Unlinked (no client) — ${unlinkedHours.toFixed(1)}h across ${unlinkedCount} entries`);
        lines.push("");
        lines.push("- These Time Log entries have no Client relation. Link them in the Time Log DB or ensure GitHub Items inherit Client from their parent Repo (sync\\-time\\-log inherit\\_relations: true).");
    }
    return lines.join("\n");
}
/**
 * Replaces the entire page content using the Notion Markdown API (2026-03-11).
 * Much simpler than the old list-delete-append block dance.
 */
async function writeMarkdownToPage(pageId, markdown) {
    const token = getNtnApiToken();
    const res = await fetch(`https://api.notion.com/v1/pages/${pageId}/markdown`, {
        method: "PATCH",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "Notion-Version": "2026-03-11",
        },
        body: JSON.stringify({
            type: "replace_content",
            replace_content: { new_str: markdown },
        }),
    });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Notion Markdown API error ${res.status}: ${body}`);
    }
}
/* ── Main ────────────────────────────────────────────────────────────────── */
export async function executeSyncHoursByClient(input, notion) {
    try {
        const lookbackDays = input.lookback_days ?? 365;
        const dryRun = input.dry_run ?? false;
        const defaultRate = (input.default_rate_per_hour ?? 0) > 0
            ? (input.default_rate_per_hour ?? null)
            : null;
        const snapshotDate = new Date().toISOString().split("T")[0];
        // 1. Query Time Log
        console.log(TAG, `Querying Time Log (lookback: ${lookbackDays}d)...`);
        const rows = await queryTimeLog(notion, lookbackDays);
        console.log(TAG, `  → ${rows.length} entries found`);
        // 2. Aggregate
        const { clientBuckets, unlinkedHours, unlinkedCount, totalHours, totalEntries } = aggregate(rows);
        console.log(TAG, `  → ${clientBuckets.size} clients, ${totalHours.toFixed(1)}h total`);
        // 3. Collect unique IDs for name + rate resolution
        const allClientIds = Array.from(clientBuckets.keys());
        const allProjectIds = new Set();
        for (const bucket of clientBuckets.values()) {
            for (const key of bucket.projects.keys()) {
                if (key !== "__none__")
                    allProjectIds.add(key);
            }
        }
        console.log(TAG, `Resolving ${allClientIds.length} clients, ${allProjectIds.size} projects (names + ${RATE_PROP})...`);
        // Resolve in parallel — clients and projects are independent
        const [clientEntities, projectEntities] = await Promise.all([
            resolveEntities(notion, allClientIds),
            resolveEntities(notion, Array.from(allProjectIds)),
        ]);
        // 4. Build output with rates
        const clients = buildClientSummaries(clientBuckets, clientEntities, projectEntities, defaultRate);
        const totalBillable = clients.reduce((sum, c) => sum + c.billable_hours, 0);
        const totalBillableValue = clients.reduce((sum, c) => sum + (c.total_billable_value ?? 0), 0);
        // 5. Write to page via Markdown API
        if (!dryRun) {
            console.log(TAG, `Writing snapshot to page ${input.target_page_id} (Markdown API)...`);
            const markdown = buildPageMarkdown(snapshotDate, lookbackDays, totalHours, round2(totalBillable), round2(totalBillableValue), totalEntries, clients, unlinkedHours, unlinkedCount);
            await writeMarkdownToPage(input.target_page_id, markdown);
            console.log(TAG, "  → Page updated.");
        }
        else {
            console.log(TAG, "[DRY RUN] Skipping page write.");
        }
        const valueNote = totalBillableValue > 0 ? ` Billable value: ${fmt$(round2(totalBillableValue))}.` : "";
        const summary = `${dryRun ? "DRY RUN — " : ""}Hours by Client: ${clients.length} clients, ${totalHours.toFixed(1)}h total (${round2(totalBillable).toFixed(1)}h billable) across ${totalEntries} entries in last ${lookbackDays}d.${valueNote}${unlinkedHours > 0 ? ` ${unlinkedHours.toFixed(1)}h unlinked.` : ""}`;
        console.log(TAG, summary);
        return {
            success: true,
            snapshot_date: snapshotDate,
            lookback_days: lookbackDays,
            total_entries_scanned: totalEntries,
            total_hours: round2(totalHours),
            total_billable_hours: round2(totalBillable),
            total_billable_value: round2(totalBillableValue),
            client_count: clients.length,
            clients,
            unlinked_hours: round2(unlinkedHours),
            unlinked_entry_count: unlinkedCount,
            page_updated: !dryRun,
            summary,
        };
    }
    catch (e) {
        const message = extractErrorMessage(e);
        console.error(TAG, "error:", message);
        return { success: false, error: message };
    }
}
