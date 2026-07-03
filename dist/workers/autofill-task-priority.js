import { extractErrorMessage, getTasksDatabaseId, queryDatabase, } from "../shared/notion-client.js";
import { computeTaskPriority, } from "../shared/autofill-rules.js";
function readRelationIds(properties, propName) {
    const prop = properties?.[propName];
    if (!prop || typeof prop !== "object" || !("relation" in prop))
        return [];
    const rel = prop.relation;
    return (rel ?? []).map((r) => r.id);
}
function readTitle(properties, propName = "Task Name") {
    const t = properties?.[propName];
    if (!t || typeof t !== "object" || !("title" in t))
        return "";
    const arr = t.title;
    return arr?.map((seg) => seg.plain_text).join("") ?? "";
}
function readMultiSelect(properties, propName) {
    const p = properties?.[propName];
    if (!p || typeof p !== "object" || !("multi_select" in p))
        return [];
    const arr = p.multi_select;
    return arr?.map((o) => o.name) ?? [];
}
function readDateStart(properties, propName) {
    const p = properties?.[propName];
    if (!p || typeof p !== "object" || !("date" in p))
        return null;
    const d = p.date;
    return d?.start ?? null;
}
function readSelect(properties, propName) {
    const p = properties?.[propName];
    if (!p || typeof p !== "object" || !("select" in p))
        return "";
    const sel = p.select;
    return sel?.name ?? "";
}
function normalizeTier(raw) {
    const v = raw.trim().toLowerCase();
    if (v.startsWith("strateg"))
        return "Strategic";
    if (v.startsWith("maint"))
        return "Maintenance";
    if (v.startsWith("stand"))
        return "Standard";
    return null;
}
function chicagoToday() {
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
export async function executeAutofillTaskPriority(input, notion) {
    const dryRun = input.dry_run ?? false;
    const maxPages = input.max_pages ?? 50;
    try {
        const tasksDbId = getTasksDatabaseId();
        const today = chicagoToday();
        const tasks = [];
        if (input.page_id) {
            const page = (await notion.pages.retrieve({ page_id: input.page_id }));
            tasks.push({
                id: page.id,
                title: readTitle(page.properties),
                dueDate: readDateStart(page.properties, "Due Date"),
                clientIds: readRelationIds(page.properties, "Clients"),
                tags: readMultiSelect(page.properties, "Tags"),
            });
        }
        else {
            const filter = {
                property: "Priority",
                select: { is_empty: true },
            };
            const res = await queryDatabase(notion, tasksDbId, {
                filter: filter,
                page_size: maxPages,
            });
            for (const page of res.results) {
                const p = page;
                tasks.push({
                    id: p.id,
                    title: readTitle(p.properties),
                    dueDate: readDateStart(p.properties, "Due Date"),
                    clientIds: readRelationIds(p.properties, "Clients"),
                    tags: readMultiSelect(p.properties, "Tags"),
                });
            }
        }
        if (tasks.length === 0) {
            return {
                success: true,
                scanned: 0,
                filled: 0,
                skipped: 0,
                results: [],
                summary: "No tasks with empty Priority.",
            };
        }
        // Resolve a Tier per task by looking up the first linked client page.
        const tierByTaskId = new Map();
        const seenClientIds = new Map();
        for (const t of tasks) {
            const firstClient = t.clientIds[0];
            if (!firstClient) {
                tierByTaskId.set(t.id, null);
                continue;
            }
            let tier = seenClientIds.get(firstClient) ?? null;
            if (!seenClientIds.has(firstClient)) {
                try {
                    const client = (await notion.pages.retrieve({ page_id: firstClient }));
                    tier = normalizeTier(readSelect(client.properties, "Tier"));
                }
                catch (e) {
                    console.warn("[autofill-task-priority] could not load client", firstClient, e instanceof Error ? e.message : String(e));
                }
                seenClientIds.set(firstClient, tier);
            }
            tierByTaskId.set(t.id, tier);
        }
        const results = [];
        let filled = 0;
        let skipped = 0;
        for (const task of tasks) {
            const decision = computeTaskPriority({
                dueDate: task.dueDate,
                today,
                clientTier: tierByTaskId.get(task.id) ?? null,
                tags: task.tags,
            });
            // computeTaskPriority always returns fill=true, but guard anyway.
            if (!decision.fill) {
                skipped++;
                results.push({
                    page_id: task.id,
                    page_title: task.title,
                    filled: false,
                    reason: decision.reason,
                    value: null,
                });
                continue;
            }
            const priority = decision.value;
            if (!dryRun) {
                try {
                    await notion.pages.update({
                        page_id: task.id,
                        properties: {
                            Priority: { select: { name: priority } },
                        },
                    });
                }
                catch (e) {
                    skipped++;
                    const msg = e instanceof Error ? e.message : String(e);
                    results.push({
                        page_id: task.id,
                        page_title: task.title,
                        filled: false,
                        reason: `notion error: ${msg}`,
                        value: null,
                    });
                    console.error("[autofill-task-priority] update error", task.title, msg);
                    continue;
                }
            }
            filled++;
            results.push({
                page_id: task.id,
                page_title: task.title,
                filled: true,
                reason: decision.reason,
                value: priority,
            });
            console.log("[autofill-task-priority] fill", task.title, "→", priority);
        }
        const summary = `Scanned ${tasks.length} tasks: ${filled} filled, ${skipped} skipped${dryRun ? " (dry run)" : ""}.`;
        return {
            success: true,
            scanned: tasks.length,
            filled,
            skipped,
            results,
            summary,
        };
    }
    catch (e) {
        const message = extractErrorMessage(e);
        console.error("[autofill-task-priority] fatal:", message);
        return { success: false, error: message };
    }
}
