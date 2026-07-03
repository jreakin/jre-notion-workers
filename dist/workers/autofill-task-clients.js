import { extractErrorMessage, getTasksDatabaseId, queryDatabase, } from "../shared/notion-client.js";
import { inferTaskClientFromProject } from "../shared/autofill-rules.js";
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
export async function executeAutofillTaskClients(input, notion) {
    const dryRun = input.dry_run ?? false;
    const maxPages = input.max_pages ?? 50;
    try {
        const tasksDbId = getTasksDatabaseId();
        // 1. Load candidate Tasks: Client empty, Project non-empty
        const tasks = [];
        if (input.page_id) {
            const page = (await notion.pages.retrieve({ page_id: input.page_id }));
            tasks.push({
                id: page.id,
                title: readTitle(page.properties),
                projectIds: readRelationIds(page.properties, "Project"),
            });
        }
        else {
            const filter = {
                and: [
                    { property: "Clients", relation: { is_empty: true } },
                    { property: "Project", relation: { is_not_empty: true } },
                ],
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
                    projectIds: readRelationIds(p.properties, "Project"),
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
                summary: "No candidate tasks found (Client empty + Project set).",
            };
        }
        // 2. Resolve Project → Client lookup for every project referenced
        const allProjectIds = [...new Set(tasks.flatMap((t) => t.projectIds))];
        const lookup = {};
        for (const projId of allProjectIds) {
            try {
                const proj = (await notion.pages.retrieve({ page_id: projId }));
                // Projects DB uses singular "Client" (relation); Tasks DB uses plural "Clients".
                lookup[projId] = readRelationIds(proj.properties, "Client");
            }
            catch (e) {
                console.warn("[autofill-task-clients] could not load project", projId, e instanceof Error ? e.message : String(e));
                lookup[projId] = [];
            }
        }
        // 3. Decide + patch
        const results = [];
        let filled = 0;
        let skipped = 0;
        for (const task of tasks) {
            const decision = inferTaskClientFromProject(task.projectIds, lookup);
            if (!decision.fill) {
                skipped++;
                results.push({
                    page_id: task.id,
                    page_title: task.title,
                    filled: false,
                    reason: decision.reason,
                    value: null,
                });
                console.log("[autofill-task-clients] skip", task.title, "→", decision.reason);
                continue;
            }
            if (!dryRun) {
                try {
                    await notion.pages.update({
                        page_id: task.id,
                        properties: {
                            Client: { relation: decision.value.map((id) => ({ id })) },
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
                    console.error("[autofill-task-clients] update error", task.title, msg);
                    continue;
                }
            }
            filled++;
            results.push({
                page_id: task.id,
                page_title: task.title,
                filled: true,
                reason: decision.reason,
                value: decision.value.join(","),
            });
            console.log("[autofill-task-clients] fill", task.title, "→", decision.value.length, "client(s)");
        }
        const summary = `Scanned ${tasks.length} tasks: ${filled} filled, ${skipped} skipped${dryRun ? " (dry run)" : ""}.`;
        return { success: true, scanned: tasks.length, filled, skipped, results, summary };
    }
    catch (e) {
        const message = extractErrorMessage(e);
        console.error("[autofill-task-clients] fatal:", message);
        return { success: false, error: message };
    }
}
