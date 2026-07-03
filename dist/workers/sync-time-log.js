import { executeEstimateGitHubHours } from "./estimate-github-hours.js";
import { getGitHubItemsSyncDatabaseId, getTimeLogDatabaseId, extractErrorMessage, queryDatabase } from "../shared/notion-client.js";
import { parseGitHubUrl } from "../shared/github-url.js";
import { backfillTimeLogRelations } from "../shared/time-log-relations.js";
export { parseGitHubUrl };
const TAG = "[sync-time-log]";
/* ── Helpers ──────────────────────────────────────────────────────────── */
/** Read an array of page IDs from a Notion relation property. */
export function readRelationIds(properties, propName) {
    const prop = properties?.[propName];
    if (!prop || typeof prop !== "object" || !("relation" in prop))
        return [];
    const rel = prop.relation;
    return (rel ?? []).map((r) => r.id);
}
/** Read a plain-text title property. */
export function readTitle(properties) {
    const t = properties?.["Title"] ?? properties?.["Description"];
    if (!t || typeof t !== "object" || !("title" in t))
        return "";
    const arr = t.title;
    return arr?.map((seg) => seg.plain_text).join("") ?? "";
}
/** Read a select property value. */
export function readSelect(properties, propName) {
    const p = properties?.[propName];
    if (!p || typeof p !== "object" || !("select" in p))
        return "";
    const sel = p.select;
    return sel?.name ?? "";
}
/** Read a multi-select property as string array. */
export function readMultiSelect(properties, propName) {
    const p = properties?.[propName];
    if (!p || typeof p !== "object" || !("multi_select" in p))
        return [];
    const arr = p.multi_select;
    return arr?.map((o) => o.name.toLowerCase()) ?? [];
}
/** Read a URL property. */
export function readUrl(properties, propName) {
    const p = properties?.[propName];
    if (!p || typeof p !== "object" || !("url" in p))
        return "";
    return (p.url) ?? "";
}
/** Read a rich-text property as plain text. */
export function readRichText(properties, propName) {
    const p = properties?.[propName];
    if (!p || typeof p !== "object" || !("rich_text" in p))
        return "";
    const arr = p.rich_text;
    return arr?.map((seg) => seg.plain_text).join("") ?? "";
}
/** Read a date property start value. */
export function readDateStart(properties, propName) {
    const p = properties?.[propName];
    if (!p || typeof p !== "object" || !("date" in p))
        return "";
    const d = p.date;
    return d?.start ?? "";
}
/** Determine the description prefix based on item type, status, and confidence. */
export function descriptionPrefix(itemType, status, confidence, isFallback) {
    if (isFallback)
        return "[EST-FALLBACK]";
    if (itemType === "PR" && status === "Merged")
        return "[EST-FINAL]";
    if (confidence === "low")
        return "[EST-LOW]";
    return "[EST]";
}
/** Build the Time Log description line. */
export function buildDescription(prefix, itemType, title, githubUrl, repo) {
    const parsed = parseGitHubUrl(githubUrl);
    const numberStr = parsed ? `#${parsed.number}` : "";
    const shortTitle = title.length > 80 ? title.slice(0, 77) + "..." : title;
    return `${prefix} ${itemType}: ${shortTitle} (${numberStr}) \u2014 ${repo}`;
}
/** Fallback hour estimate when the GitHub API estimator fails. */
export function fallbackEstimate(labels) {
    if (labels.includes("documentation"))
        return 0.5;
    if (labels.includes("bug"))
        return 2;
    if (labels.includes("feature") || labels.includes("enhancement"))
        return 5;
    return 2;
}
/* ── Query helpers ────────────────────────────────────────────────────── */
/** Load GitHub Items (Issues + PRs) from the native Worker.sync() DB.
 *  When fullScan is true, walks every row regardless of date.
 *  Otherwise limits to items created or updated within lookbackDays.
 */
async function loadGitHubItems(notion, lookbackDays, itemTypes, repoFilter, fullScan) {
    const dbId = getGitHubItemsSyncDatabaseId();
    // Build type filter: Issue and/or PR (never Repo)
    const typeOrFilter = itemTypes.length === 1
        ? { property: "Type", select: { equals: itemTypes[0] } }
        : { or: itemTypes.map((t) => ({ property: "Type", select: { equals: t } })) };
    const cutoffIso = (() => {
        const d = new Date();
        d.setDate(d.getDate() - lookbackDays);
        return d.toISOString().split("T")[0];
    })();
    const filter = fullScan
        ? typeOrFilter
        : {
            and: [
                typeOrFilter,
                {
                    or: [
                        { property: "Created", date: { on_or_after: cutoffIso } },
                        { property: "Updated", date: { on_or_after: cutoffIso } },
                    ],
                },
            ],
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
            const title = readTitle(props);
            const type = readSelect(props, "Type");
            const status = readSelect(props, "Status");
            const githubUrl = readUrl(props, "GitHub URL");
            const repo = readRichText(props, "Repo");
            const labels = readMultiSelect(props, "Labels");
            const createdDate = readDateStart(props, "Created");
            const updatedDate = readDateStart(props, "Updated");
            const clientIds = readRelationIds(props, "Client");
            const projectIds = readRelationIds(props, "Project");
            const taskIds = readRelationIds(props, "Task");
            // Read Billable checkbox — set by the inherit phase from the parent Repo row
            const billableProp = props["Billable"];
            const billable = billableProp &&
                typeof billableProp === "object" &&
                "checkbox" in billableProp
                ? billableProp.checkbox === true
                : false;
            // Apply repo filter if set
            if (repoFilter.length > 0) {
                const repoLower = repo.toLowerCase();
                if (!repoFilter.some((r) => repoLower === r.toLowerCase()))
                    continue;
            }
            if (!type || (type !== "Issue" && type !== "PR"))
                continue;
            rows.push({
                id: page.id,
                title,
                type,
                status,
                githubUrl,
                repo,
                createdDate,
                updatedDate,
                labels,
                clientIds,
                projectIds,
                taskIds,
                billable,
            });
        }
        cursor = resp.has_more ? resp.next_cursor ?? undefined : undefined;
    } while (cursor);
    return rows;
}
/** Load existing Time Log entries that have GitHub Item relations set. */
export async function loadExistingTimeLogEntries(notion) {
    const dbId = getTimeLogDatabaseId();
    // Query for entries that have a GitHub Item relation
    const filter = {
        property: "GitHub Item",
        relation: { is_not_empty: true },
    };
    // Map: github_item_page_id → time log entry
    const map = new Map();
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
            const description = readTitle(props);
            const githubItemIds = readRelationIds(props, "GitHub Item");
            const entry = {
                id: page.id,
                description,
                githubItemIds,
                clientIds: readRelationIds(props, "Client"),
                projectIds: readRelationIds(props, "Project"),
                taskIds: readRelationIds(props, "Task"),
            };
            // Index by each linked GitHub Item ID
            for (const ghId of githubItemIds) {
                map.set(ghId, entry);
            }
        }
        cursor = resp.has_more ? resp.next_cursor ?? undefined : undefined;
    } while (cursor);
    return map;
}
/* ── Main ─────────────────────────────────────────────────────────────── */
export async function executeSyncTimeLog(input, notion) {
    try {
        const lookbackDays = input.lookback_days ?? 7;
        const itemTypes = input.item_types ?? ["Issue", "PR"];
        const repoFilter = input.repo_filter ?? [];
        const dryRun = input.dry_run ?? false;
        const inheritRelations = input.inherit_relations ?? false;
        const fullScan = input.full_scan ?? false;
        // 1. Load GitHub Items
        const scanLabel = fullScan ? "full scan (no date filter)" : `lookback: ${lookbackDays}d`;
        console.log(TAG, `Loading GitHub Items (${scanLabel})...`);
        const ghItems = await loadGitHubItems(notion, lookbackDays, itemTypes, repoFilter, fullScan);
        console.log(TAG, `  \u2192 ${ghItems.length} items found`);
        // 2. Load existing Time Log entries
        console.log(TAG, "Loading existing Time Log entries...");
        const existingEntries = await loadExistingTimeLogEntries(notion);
        console.log(TAG, `  \u2192 ${existingEntries.size} existing entries`);
        // 3. Process each item
        let created = 0;
        let updated = 0;
        let tracked = 0;
        let skipped = 0;
        let errors = 0;
        let totalHours = 0;
        const errorDetails = [];
        const entries = [];
        for (const item of ghItems) {
            try {
                const existing = existingEntries.get(item.id);
                if (existing) {
                    // Check if this is a manual entry (no [EST*] prefix)
                    const isEstimateEntry = /^\[EST/.test(existing.description);
                    if (!isEstimateEntry) {
                        // Manual entry — don't touch it
                        entries.push({
                            github_item_id: item.id,
                            github_url: item.githubUrl,
                            title: item.title,
                            type: item.type,
                            action: "skipped",
                            hours: null,
                            confidence: null,
                            description_prefix: "",
                            reason: "Manual entry exists (no [EST*] prefix)",
                        });
                        skipped++;
                        continue;
                    }
                    // Already estimated and not merged — skip
                    if (item.status !== "Merged") {
                        entries.push({
                            github_item_id: item.id,
                            github_url: item.githubUrl,
                            title: item.title,
                            type: item.type,
                            action: "skipped",
                            hours: null,
                            confidence: null,
                            description_prefix: existing.description.split("]")[0] + "]",
                            reason: "Already estimated, not yet merged",
                        });
                        skipped++;
                        continue;
                    }
                    // Merged PR with existing [EST*] entry — update to [EST-FINAL]
                    const result = await estimateItem(item);
                    const prefix = descriptionPrefix(item.type, item.status, result.confidence, result.isFallback);
                    const desc = buildDescription(prefix, item.type, item.title, item.githubUrl, item.repo);
                    if (!dryRun) {
                        await notion.pages.update({
                            page_id: existing.id,
                            properties: {
                                Description: { title: [{ text: { content: desc } }] },
                                Hours: { number: result.hours },
                                Date: { date: { start: item.updatedDate || item.createdDate } },
                            },
                        });
                    }
                    totalHours += result.hours;
                    updated++;
                    entries.push({
                        github_item_id: item.id,
                        github_url: item.githubUrl,
                        title: item.title,
                        type: item.type,
                        action: "updated",
                        hours: result.hours,
                        confidence: result.confidence,
                        description_prefix: prefix,
                    });
                    console.log(TAG, `${dryRun ? "[DRY RUN] " : ""}updated: ${desc} (${result.hours}h)`);
                    continue;
                }
                // No existing entry — create new
                // Only estimate hours if the item is billable (Billable flag inherited from its Repo row)
                if (!item.billable) {
                    const desc = buildDescription("[TRACKED]", item.type, item.title, item.githubUrl, item.repo);
                    if (!dryRun) {
                        const properties = {
                            Description: { title: [{ text: { content: desc } }] },
                            Date: { date: { start: item.createdDate || new Date().toISOString().split("T")[0] } },
                            "GitHub Item": { relation: [{ id: item.id }] },
                            Billable: { checkbox: false },
                        };
                        if (item.clientIds.length) {
                            properties.Client = { relation: item.clientIds.map((id) => ({ id })) };
                        }
                        if (item.projectIds.length) {
                            properties.Project = { relation: item.projectIds.map((id) => ({ id })) };
                        }
                        if (item.taskIds.length) {
                            properties.Task = { relation: item.taskIds.map((id) => ({ id })) };
                        }
                        await notion.pages.create({
                            parent: { database_id: getTimeLogDatabaseId() },
                            properties: properties,
                        });
                    }
                    tracked++;
                    entries.push({
                        github_item_id: item.id,
                        github_url: item.githubUrl,
                        title: item.title,
                        type: item.type,
                        action: "tracked",
                        hours: null,
                        confidence: null,
                        description_prefix: "[TRACKED]",
                        reason: "Non-billable repo — no hours estimated",
                    });
                    console.log(TAG, `${dryRun ? "[DRY RUN] " : ""}tracked (non-billable): ${desc}`);
                    continue;
                }
                // Billable — estimate hours
                const result = await estimateItem(item);
                const prefix = descriptionPrefix(item.type, item.status, result.confidence, result.isFallback);
                const desc = buildDescription(prefix, item.type, item.title, item.githubUrl, item.repo);
                if (!dryRun) {
                    const properties = {
                        Description: { title: [{ text: { content: desc } }] },
                        Hours: { number: result.hours },
                        Date: { date: { start: item.createdDate || new Date().toISOString().split("T")[0] } },
                        "GitHub Item": { relation: [{ id: item.id }] },
                        Billable: { checkbox: true },
                    };
                    // Copy relations from GitHub Item
                    if (item.clientIds.length) {
                        properties.Client = { relation: item.clientIds.map((id) => ({ id })) };
                    }
                    if (item.projectIds.length) {
                        properties.Project = { relation: item.projectIds.map((id) => ({ id })) };
                    }
                    if (item.taskIds.length) {
                        properties.Task = { relation: item.taskIds.map((id) => ({ id })) };
                    }
                    await notion.pages.create({
                        parent: { database_id: getTimeLogDatabaseId() },
                        properties: properties,
                    });
                }
                totalHours += result.hours;
                created++;
                entries.push({
                    github_item_id: item.id,
                    github_url: item.githubUrl,
                    title: item.title,
                    type: item.type,
                    action: "created",
                    hours: result.hours,
                    confidence: result.confidence,
                    description_prefix: prefix,
                });
                console.log(TAG, `${dryRun ? "[DRY RUN] " : ""}created: ${desc} (${result.hours}h)`);
            }
            catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                errorDetails.push(`${item.type} "${item.title}": ${msg}`);
                errors++;
                console.error(TAG, `Error processing ${item.type} "${item.title}":`, msg);
            }
        }
        // 4. Inherit relations from GitHub Items (optional pass)
        let relationsInherited = 0;
        if (inheritRelations) {
            console.log(TAG, "Running relation inherit pass...");
            const backfill = await backfillTimeLogRelations(notion, [...existingEntries.values()], { dryRun });
            relationsInherited = backfill.updated;
            console.log(TAG, `  \u2192 ${relationsInherited} entries updated with inherited relations.`);
        }
        const prefix = dryRun ? "DRY RUN \u2014 " : "";
        const inheritNote = inheritRelations ? ` ${relationsInherited} relations inherited.` : "";
        const summary = `${prefix}Synced Time Log: ${ghItems.length} items scanned. ${created} created (billable), ${tracked} tracked (non-billable), ${updated} updated, ${skipped} skipped, ${errors} errors. Total estimated: ${totalHours}h.${inheritNote}`;
        console.log(TAG, summary);
        return {
            success: true,
            items_scanned: ghItems.length,
            created,
            updated,
            tracked,
            skipped,
            errors,
            total_estimated_hours: totalHours,
            error_details: errorDetails,
            entries,
            relations_inherited: relationsInherited,
            summary,
        };
    }
    catch (e) {
        const message = extractErrorMessage(e);
        console.error(TAG, "error:", message);
        return { success: false, error: message };
    }
}
export async function estimateItem(item) {
    const parsed = parseGitHubUrl(item.githubUrl);
    if (!parsed) {
        // Can't parse URL — use fallback
        return {
            hours: fallbackEstimate(item.labels),
            confidence: "low",
            isFallback: true,
        };
    }
    const result = await executeEstimateGitHubHours({
        owner: parsed.owner,
        repo: parsed.repo,
        number: parsed.number,
        type: parsed.type,
    });
    if (!result.success) {
        // Estimation failed — use fallback
        console.warn(TAG, `Estimation failed for ${item.githubUrl}: ${result.error}. Using fallback.`);
        return {
            hours: fallbackEstimate(item.labels),
            confidence: "low",
            isFallback: true,
        };
    }
    return {
        hours: result.estimatedHours,
        confidence: result.confidence,
        isFallback: false,
    };
}
