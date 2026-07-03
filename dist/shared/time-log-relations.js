import { getClientsDatabaseId, getProjectsDatabaseId, getTimeLogDatabaseId, queryDatabase, } from "./notion-client.js";
const TAG = "[time-log-relations]";
/** Property names on the Time Log entry (write target). */
const TL = {
    client: "Client",
    project: "Project",
    task: "Task",
    githubItem: "GitHub Item",
};
/** Property names on a 🔀 GitHub Items page (Source 1). */
const GH_SRC = { client: "Client", project: "Project", task: "Task" };
/** Property names on a Tasks page (Source 2 — note the plurals). */
const TASK_SRC = {
    client: "Clients",
    project: "Project",
    githubItem: "GitHub Items",
};
/** Read an array of page IDs from a Notion relation property. */
function readRelationIds(properties, propName) {
    const prop = properties?.[propName];
    if (!prop || typeof prop !== "object" || !("relation" in prop))
        return [];
    const rel = prop.relation;
    return (rel ?? []).map((r) => r.id);
}
/** Read the plain-text of a title property (tries "Title" then "Name"). */
function readTitle(properties) {
    const t = properties?.["Title"] ?? properties?.["Name"];
    if (!t || typeof t !== "object" || !("title" in t))
        return "";
    const arr = t.title;
    return arr?.map((seg) => seg.plain_text ?? "").join("") ?? "";
}
/** Format an auto-increment unique_id property as "PREFIX-NUMBER" (e.g. "AD-PROJ-27"). */
function readUniqueId(properties, propName) {
    const p = properties?.[propName];
    if (!p || typeof p !== "object" || !("unique_id" in p))
        return null;
    const uid = p.unique_id;
    if (!uid || uid.number == null)
        return null;
    return uid.prefix ? `${uid.prefix}-${uid.number}` : String(uid.number);
}
/** Extract `[AD-PROJ-27]`-style ID tokens from a title. */
const AD_TOKEN_RE = /\[([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*-\d+)\]/g;
export function parseAdIdTokens(title) {
    const out = [];
    for (const m of title.matchAll(AD_TOKEN_RE))
        out.push(m[1]);
    return out;
}
/**
 * Build lookup maps so a `[AD-CLIENT-N]` / `[AD-PROJ-N]` token from a title can
 * be resolved to the Client/Project page id. Loads the (small) Clients and
 * Projects databases once.
 */
export async function loadUniqueIdMaps(notion) {
    const clientByUid = new Map();
    const projectByUid = new Map();
    const clientByProjectPageId = new Map();
    async function paginate(dbId, onPage) {
        let cursor;
        do {
            const resp = await queryDatabase(notion, dbId, {
                start_cursor: cursor,
                page_size: 100,
            });
            for (const page of resp.results) {
                if (!("properties" in page))
                    continue;
                onPage(page.id, page.properties);
            }
            cursor = resp.has_more ? resp.next_cursor ?? undefined : undefined;
        } while (cursor);
    }
    await Promise.all([
        paginate(getClientsDatabaseId(), (id, props) => {
            const uid = readUniqueId(props, "ID");
            if (uid)
                clientByUid.set(uid, id);
        }),
        paginate(getProjectsDatabaseId(), (id, props) => {
            const uid = readUniqueId(props, "Project ID");
            if (uid)
                projectByUid.set(uid, id);
            const clientIds = readRelationIds(props, "Client");
            if (clientIds.length)
                clientByProjectPageId.set(id, clientIds);
        }),
    ]);
    return { clientByUid, projectByUid, clientByProjectPageId };
}
/**
 * Load Time Log entries that are (a) missing Client or Project AND (b) have a
 * source to inherit from (a GitHub Item or a Task).
 *
 * Candidacy keys on Client/Project only — the billing-critical relations a
 * source can almost always supply — NOT on Task/GitHub Item. Keying on Task or
 * GitHub Item would make entries whose source genuinely lacks those fields into
 * *permanent* candidates: they can never be completed, so they clog the per-run
 * budget and the backlog never converges. Task and GitHub Item are still filled
 * opportunistically when an entry is processed (see backfillTimeLogRelations),
 * but their absence no longer keeps an entry queued forever.
 */
export async function loadTimeLogEntriesNeedingRelations(notion) {
    const dbId = getTimeLogDatabaseId();
    const filter = {
        and: [
            {
                or: [
                    { property: TL.client, relation: { is_empty: true } },
                    { property: TL.project, relation: { is_empty: true } },
                ],
            },
            {
                or: [
                    { property: TL.githubItem, relation: { is_not_empty: true } },
                    { property: TL.task, relation: { is_not_empty: true } },
                ],
            },
        ],
    };
    const out = [];
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
            out.push({
                id: page.id,
                githubItemIds: readRelationIds(props, TL.githubItem),
                clientIds: readRelationIds(props, TL.client),
                projectIds: readRelationIds(props, TL.project),
                taskIds: readRelationIds(props, TL.task),
            });
        }
        cursor = resp.has_more ? resp.next_cursor ?? undefined : undefined;
    } while (cursor);
    return out;
}
/**
 * Backfill empty Client/Project/Task/GitHub Item relations on the given Time
 * Log entries. GitHub Item first, then Task fallback. Idempotent.
 */
export async function backfillTimeLogRelations(notion, entries, opts) {
    // Bound the pass so it can't exceed the worker platform's ~60s hard stop.
    // Each entry costs up to 3 sequential page reads + 1 write; on a large
    // backlog that adds up. The pass is idempotent and runs daily, so a bounded
    // chunk per run converges over a few days without ever timing out.
    const maxEntries = opts.maxEntries ?? Infinity;
    const deadlineMs = opts.deadlineMs ?? Infinity;
    const result = {
        considered: 0,
        updated: 0,
        filled: { client: 0, project: 0, task: 0, githubItem: 0 },
        stillUnlinkedIds: [],
        remaining: 0,
        stoppedEarly: false,
        errors: 0,
    };
    const seen = new Set();
    for (const entry of entries) {
        if (seen.has(entry.id))
            continue;
        seen.add(entry.id);
        const needClient = entry.clientIds.length === 0;
        const needProject = entry.projectIds.length === 0;
        const needTask = entry.taskIds.length === 0;
        const needGithubItem = entry.githubItemIds.length === 0;
        if (!needClient && !needProject && !needTask && !needGithubItem)
            continue;
        // Cap / deadline: stop processing but keep counting how many still need work.
        if (result.considered >= maxEntries || Date.now() >= deadlineMs) {
            result.stoppedEarly = true;
            result.remaining++;
            continue;
        }
        result.considered++;
        const resolved = {};
        try {
            // ── Source 1: GitHub Item first ──
            if (entry.githubItemIds.length > 0 && (needClient || needProject || needTask)) {
                const gh = await notion.pages.retrieve({ page_id: entry.githubItemIds[0] });
                if ("properties" in gh) {
                    const p = gh.properties;
                    if (needClient) {
                        const v = readRelationIds(p, GH_SRC.client);
                        if (v.length)
                            resolved.client = v;
                    }
                    if (needProject) {
                        const v = readRelationIds(p, GH_SRC.project);
                        if (v.length)
                            resolved.project = v;
                    }
                    if (needTask) {
                        const v = readRelationIds(p, GH_SRC.task);
                        if (v.length)
                            resolved.task = v;
                    }
                    // Title-prefix fallback: many GitHub Items carry "[AD-CLIENT-N]" /
                    // "[AD-PROJ-N]" in their title but have empty Client/Project relations
                    // (and may even be trashed). Recover the IDs from the title.
                    if (opts.uidMaps && ((needClient && !resolved.client) || (needProject && !resolved.project))) {
                        const tokens = parseAdIdTokens(readTitle(p));
                        for (const tok of tokens) {
                            if (needClient && !resolved.client) {
                                const id = opts.uidMaps.clientByUid.get(tok);
                                if (id)
                                    resolved.client = [id];
                            }
                            if (needProject && !resolved.project) {
                                const id = opts.uidMaps.projectByUid.get(tok);
                                if (id)
                                    resolved.project = [id];
                            }
                        }
                    }
                }
            }
            // ── Source 2: Task fallback (Clients/Project + the PR/Repo link) ──
            const stillClient = needClient && !resolved.client;
            const stillProject = needProject && !resolved.project;
            if (entry.taskIds.length > 0 && (stillClient || stillProject || needGithubItem)) {
                const tk = await notion.pages.retrieve({ page_id: entry.taskIds[0] });
                if ("properties" in tk) {
                    const p = tk.properties;
                    if (stillClient) {
                        const v = readRelationIds(p, TASK_SRC.client);
                        if (v.length)
                            resolved.client = v;
                    }
                    if (stillProject) {
                        const v = readRelationIds(p, TASK_SRC.project);
                        if (v.length)
                            resolved.project = v;
                    }
                    if (needGithubItem) {
                        const v = readRelationIds(p, TASK_SRC.githubItem);
                        if (v.length)
                            resolved.githubItem = v;
                    }
                }
            }
            // Derive Client from the Project's own Client relation (a project belongs
            // to a client). Covers the residual: entries that have/just-got a Project
            // but whose source/title carries no [AD-CLIENT-N] to recover directly.
            if (needClient && !resolved.client && opts.uidMaps) {
                const projId = resolved.project?.[0] ?? entry.projectIds[0];
                if (projId) {
                    const c = opts.uidMaps.clientByProjectPageId.get(projId);
                    if (c && c.length)
                        resolved.client = c;
                }
            }
            // Report entries that still lack a billing-critical relation
            // (Client/Project) — these are the convergence criteria. Task/GitHub Item
            // are filled opportunistically but don't count toward "still unlinked".
            const gotClient = !needClient || !!resolved.client;
            const gotProject = !needProject || !!resolved.project;
            if (!(gotClient && gotProject)) {
                result.stillUnlinkedIds.push(entry.id);
            }
            if (!resolved.client &&
                !resolved.project &&
                !resolved.task &&
                !resolved.githubItem) {
                continue;
            }
            // Re-read immediately before writing so we never clobber a relation that
            // was set concurrently since the candidate list was loaded.
            const cur = await notion.pages.retrieve({ page_id: entry.id });
            if (!("properties" in cur))
                continue;
            const cp = cur.properties;
            const updates = {};
            if (resolved.client && readRelationIds(cp, TL.client).length === 0) {
                updates[TL.client] = { relation: resolved.client.map((id) => ({ id })) };
            }
            if (resolved.project && readRelationIds(cp, TL.project).length === 0) {
                updates[TL.project] = { relation: resolved.project.map((id) => ({ id })) };
            }
            if (resolved.task && readRelationIds(cp, TL.task).length === 0) {
                updates[TL.task] = { relation: resolved.task.map((id) => ({ id })) };
            }
            if (resolved.githubItem && readRelationIds(cp, TL.githubItem).length === 0) {
                updates[TL.githubItem] = {
                    relation: resolved.githubItem.map((id) => ({ id })),
                };
            }
            if (Object.keys(updates).length === 0)
                continue;
            if (!opts.dryRun) {
                await notion.pages.update({
                    page_id: entry.id,
                    properties: updates,
                });
            }
            result.updated++;
            if (updates[TL.client])
                result.filled.client++;
            if (updates[TL.project])
                result.filled.project++;
            if (updates[TL.task])
                result.filled.task++;
            if (updates[TL.githubItem])
                result.filled.githubItem++;
            console.log(TAG, `${opts.dryRun ? "[DRY RUN] " : ""}filled ${Object.keys(updates).join(", ")} on Time Log ${entry.id}`);
        }
        catch (e) {
            result.errors++;
            console.warn(TAG, `backfill failed for Time Log ${entry.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    return result;
}
