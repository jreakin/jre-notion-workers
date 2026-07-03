import { getGitHubItemsSyncDatabaseId, getGitHubToken, extractErrorMessage, queryDatabase } from "../shared/notion-client.js";
import { classifyGitHubError, GitHubApiError } from "../shared/github-utils.js";
import { parseGitHubUrl } from "../shared/github-url.js";
const TAG = "[sync-github-items]";
/* ── Constants ─────────────────────────────────────────────────── */
const VALID_LABELS = new Set([
    "bug",
    "feature",
    "enhancement",
    "documentation",
    "good first issue",
]);
/* ── URL-based type inference ──────────────────────────────────── */
/**
 * Infers the item type from a GitHub URL pattern.
 *   https://github.com/{owner}/{repo}/issues/{number} → "Issue"
 *   https://github.com/{owner}/{repo}/pull/{number}   → "PR"
 *   https://github.com/{owner}/{repo}                 → "Repo"
 */
export { isNewer };
export function inferTypeFromUrl(url) {
    if (!url)
        return null;
    try {
        const u = new URL(url);
        const parts = u.pathname.split("/").filter(Boolean);
        // /{owner}/{repo}/issues/{number}
        if (parts.length >= 4 && parts[2] === "issues" && /^\d+$/.test(parts[3])) {
            return "Issue";
        }
        // /{owner}/{repo}/pull/{number}
        if (parts.length >= 4 && parts[2] === "pull" && /^\d+$/.test(parts[3])) {
            return "PR";
        }
        // /{owner}/{repo}  (exactly 2 segments)
        if (parts.length === 2) {
            return "Repo";
        }
        return null;
    }
    catch {
        return null;
    }
}
/* ── Helpers ───────────────────────────────────────────────────── */
function truncate(text, maxLen = 2000) {
    if (!text)
        return "";
    return text.length > maxLen ? text.slice(0, maxLen - 3) + "..." : text;
}
function toDateStr(iso) {
    return iso.slice(0, 10);
}
/**
 * Compares two ISO-8601 date/datetime strings by epoch.
 * Returns true when the GitHub timestamp is strictly newer than
 * the stored Notion value.  Handles mixed formats gracefully:
 *   - GitHub: "2026-03-10T15:00:00Z"
 *   - Notion: "2026-03-10" | "2026-03-10T15:00:00.000+00:00"
 */
function isNewer(ghUpdatedAt, existingUpdatedAt) {
    if (!existingUpdatedAt)
        return true;
    const ghTime = new Date(ghUpdatedAt).getTime();
    const exTime = new Date(existingUpdatedAt).getTime();
    if (Number.isNaN(ghTime))
        return false;
    if (Number.isNaN(exTime))
        return true;
    return ghTime > exTime;
}
function mapLabels(labels) {
    return labels
        .filter((l) => VALID_LABELS.has(l.name.toLowerCase()))
        .map((l) => ({ name: l.name.toLowerCase() }));
}
function mapIssueStatus(state) {
    return state === "open" ? "Open" : "Closed";
}
function mapPRStatus(state, mergedAt) {
    if (mergedAt)
        return "Merged";
    return state === "open" ? "Open" : "Closed";
}
/** GitHub issue/PR title max length. */
const GITHUB_PR_TITLE_MAX_LEN = 256;
/**
 * Removes leading Notion-context prefix segments from a GitHub PR title.
 * Handles both legacy format ([P:…] [C:…] [T:…]) and current ID format
 * ([AD-PROJ-6] [AD-CLT-2] [AD-TSK-45]).
 */
export function stripNotionPrTitlePrefix(githubTitle) {
    let rest = githubTitle.trimStart();
    // Legacy: [P:...], [C:...], [T:...]
    // ID-based: [PREFIX-NUMBER] e.g. [AD-PROJ-6], [AD-CLT-2], [AD-TSK-45]
    const re = /^\[(?:(?:P|C|T):[^\]]+|[A-Z][\w-]*-\d+)\]\s*/;
    for (;;) {
        const m = rest.match(re);
        if (!m)
            break;
        rest = rest.slice(m[0].length);
    }
    return rest.trim();
}
/**
 * Builds a prefix from auto_increment_id strings.
 * Order: Project IDs, Client IDs, then Task IDs.
 * Example: "[AD-PROJ-6] [AD-CLT-2] [AD-TSK-45] "
 */
export function buildNotionPrTitlePrefix(projectIds, clientIds, taskIds) {
    const segs = [];
    for (const id of projectIds) {
        if (id)
            segs.push(`[${id}]`);
    }
    for (const id of clientIds) {
        if (id)
            segs.push(`[${id}]`);
    }
    for (const id of taskIds) {
        if (id)
            segs.push(`[${id}]`);
    }
    return segs.length > 0 ? `${segs.join(" ")} ` : "";
}
export function composeGitHubPrTitleWithNotionContext(currentGithubTitle, projectIds, clientIds, taskIds) {
    const prefix = buildNotionPrTitlePrefix(projectIds, clientIds, taskIds);
    const core = stripNotionPrTitlePrefix(currentGithubTitle);
    let out = prefix ? `${prefix}${core}` : core;
    if (out.length > GITHUB_PR_TITLE_MAX_LEN) {
        out = `${out.slice(0, GITHUB_PR_TITLE_MAX_LEN - 1)}…`;
    }
    return out;
}
/* ── GitHub fetch functions ────────────────────────────────────── */
/**
 * Generic paginated GitHub GET. Returns all items across pages.
 */
async function paginatedGitHubGet(baseUrl, token, apiCounter) {
    const items = [];
    let url = baseUrl.includes("?")
        ? `${baseUrl}&per_page=100`
        : `${baseUrl}?per_page=100`;
    while (url) {
        if (apiCounter)
            apiCounter.count++;
        const res = await fetch(url, {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/vnd.github+json",
            },
        });
        if (!res.ok) {
            throw new GitHubApiError(classifyGitHubError(res, url));
        }
        const data = (await res.json());
        items.push(...data);
        // Pagination via Link header
        const linkHeader = res.headers.get("link");
        url = null;
        if (linkHeader) {
            const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
            if (nextMatch)
                url = nextMatch[1];
        }
    }
    return items;
}
/**
 * Fetches the date of the first commit in a repo by peeking at the last
 * page of the commits list (GitHub returns newest-first by default).
 *
 * For forked repos, filters by `authorLogin` so we get the date of the
 * owner's first contribution — not the upstream project's first commit.
 *
 * Returns an ISO-8601 string or null on any failure / empty result.
 */
async function fetchFirstCommitDate(owner, repo, token, options) {
    const apiCounter = options?.apiCounter;
    const authorFilter = options?.isFork && options.authorLogin
        ? `&author=${encodeURIComponent(options.authorLogin)}`
        : "";
    try {
        const url = `https://api.github.com/repos/${owner}/${repo}/commits?per_page=1${authorFilter}`;
        if (apiCounter)
            apiCounter.count++;
        const headers = {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
        };
        const res = await fetch(url, { headers });
        if (!res.ok)
            return null;
        // Check Link header for the last page
        const linkHeader = res.headers.get("link");
        let lastPageUrl = null;
        if (linkHeader) {
            const lastMatch = linkHeader.match(/<([^>]+)>;\s*rel="last"/);
            if (lastMatch)
                lastPageUrl = lastMatch[1];
        }
        if (lastPageUrl) {
            // Fetch the last page to get the first commit
            if (apiCounter)
                apiCounter.count++;
            const lastRes = await fetch(lastPageUrl, { headers });
            if (!lastRes.ok)
                return null;
            const commits = (await lastRes.json());
            if (commits.length > 0) {
                return commits[commits.length - 1].commit.author.date;
            }
        }
        else {
            // Only one page — the single commit on the first request is also the first commit
            const commits = (await res.json());
            if (commits.length > 0) {
                return commits[commits.length - 1].commit.author.date;
            }
        }
        return null;
    }
    catch {
        return null;
    }
}
async function fetchAllRepos(source, token, apiCounter) {
    if (source.type === "org") {
        return paginatedGitHubGet(`https://api.github.com/orgs/${source.name}/repos?type=all`, token, apiCounter);
    }
    // For user sources, use the authenticated /user/repos endpoint
    // so private repos are included. Then filter to only repos owned
    // by the specified user.
    const allUserRepos = await paginatedGitHubGet("https://api.github.com/user/repos?per_page=100", token, apiCounter);
    return allUserRepos.filter((r) => r.owner.login.toLowerCase() === source.name.toLowerCase());
}
async function fetchAllIssues(owner, repo, token, since, apiCounter) {
    let url = `https://api.github.com/repos/${owner}/${repo}/issues?state=all`;
    if (since) {
        url += `&since=${since}`;
    }
    const items = await paginatedGitHubGet(url, token, apiCounter);
    // The issues endpoint includes PRs; filter them out
    return items.filter((i) => !i.pull_request);
}
async function fetchAllPRs(owner, repo, token, since, apiCounter) {
    if (!since) {
        // Full sync — fetch everything
        const url = `https://api.github.com/repos/${owner}/${repo}/pulls?state=all`;
        return paginatedGitHubGet(url, token, apiCounter);
    }
    // Incremental sync — sort by updated desc and stop when we pass the cutoff.
    // The PRs endpoint doesn't support `since`, so we paginate manually.
    const items = [];
    let url = `https://api.github.com/repos/${owner}/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100`;
    while (url) {
        if (apiCounter)
            apiCounter.count++;
        const res = await fetch(url, {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/vnd.github+json",
            },
        });
        if (!res.ok) {
            throw new GitHubApiError(classifyGitHubError(res, url));
        }
        const data = (await res.json());
        let reachedCutoff = false;
        for (const pr of data) {
            if (pr.updated_at < since) {
                reachedCutoff = true;
                break;
            }
            items.push(pr);
        }
        if (reachedCutoff)
            break;
        const linkHeader = res.headers.get("link");
        url = null;
        if (linkHeader) {
            const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
            if (nextMatch)
                url = nextMatch[1];
        }
    }
    return items;
}
/**
 * Pre-load ALL rows from the GitHub Items database into a lookup map
 * keyed by normalised GitHub URL.
 */
async function preloadNotionRows(notion, dbId) {
    const map = new Map();
    let hasMore = true;
    let startCursor;
    while (hasMore) {
        const response = await queryDatabase(notion, dbId, {
            start_cursor: startCursor,
            page_size: 100,
        });
        for (const page of response.results) {
            const p = page;
            let ghUrl = "";
            const urlProp = p.properties?.["GitHub URL"];
            if (urlProp && typeof urlProp === "object" && "url" in urlProp) {
                ghUrl = (urlProp.url ?? "").trim();
            }
            if (!ghUrl)
                continue;
            let updatedAt = "";
            const updProp = p.properties?.["Updated"];
            if (updProp && typeof updProp === "object" && "date" in updProp) {
                const dateObj = updProp.date;
                updatedAt = dateObj?.start ?? "";
            }
            let existingType = "";
            const typeProp = p.properties?.["Type"];
            if (typeProp && typeof typeProp === "object" && "select" in typeProp) {
                const sel = typeProp.select;
                existingType = sel?.name ?? "";
            }
            const projectIds = readRelationIds(p.properties, "Project");
            const clientIds = readRelationIds(p.properties, "Client");
            const taskIds = readRelationIds(p.properties, "Task");
            let billable = false;
            const billableProp = p.properties?.["Billable"];
            if (billableProp && typeof billableProp === "object" && "checkbox" in billableProp) {
                billable = billableProp.checkbox === true;
            }
            map.set(ghUrl.toLowerCase(), {
                id: p.id,
                updatedAt,
                type: existingType,
                projectIds,
                clientIds,
                taskIds,
                billable,
            });
        }
        hasMore = response.has_more;
        startCursor = response.next_cursor ?? undefined;
    }
    return map;
}
/**
 * Extract page IDs from a Notion relation property.
 */
function readRelationIds(properties, propName) {
    const prop = properties?.[propName];
    if (!prop || typeof prop !== "object" || !("relation" in prop))
        return [];
    const rel = prop.relation;
    return (rel ?? []).map((r) => r.id);
}
function readRelationIdsFromProperties(properties, propName) {
    return readRelationIds(properties, propName);
}
function patchExistingRowFromProperties(existing, properties) {
    if ("Project" in properties) {
        existing.projectIds = readRelationIdsFromProperties(properties, "Project");
    }
    if ("Client" in properties) {
        existing.clientIds = readRelationIdsFromProperties(properties, "Client");
    }
    if ("Task" in properties) {
        existing.taskIds = readRelationIdsFromProperties(properties, "Task");
    }
}
function readNotionTitleProperty(properties, key) {
    const prop = properties?.[key];
    if (!prop || typeof prop !== "object" || !("title" in prop))
        return "";
    const arr = prop.title;
    return arr?.map((t) => t.plain_text ?? "").join("") ?? "";
}
async function resolveNotionPageTitle(notion, pageId, cache) {
    const hit = cache.get(pageId);
    if (hit !== undefined)
        return hit;
    try {
        const page = (await notion.pages.retrieve({ page_id: pageId }));
        const name = readNotionTitleProperty(page.properties, "Name") ||
            readNotionTitleProperty(page.properties, "Title");
        const label = name.trim() || pageId.replace(/-/g, "").slice(0, 8);
        cache.set(pageId, label);
        return label;
    }
    catch {
        const fallback = pageId.replace(/-/g, "").slice(0, 8);
        cache.set(pageId, fallback);
        return fallback;
    }
}
/**
 * Reads an auto_increment_id (unique_id) property from a Notion page
 * and returns the formatted string (e.g. "AD-PROJ-6").
 * Caches results keyed by `pageId:propName`.
 */
async function resolveNotionPageUniqueId(notion, pageId, propName, cache) {
    const cacheKey = `${pageId}:${propName}`;
    const hit = cache.get(cacheKey);
    if (hit !== undefined)
        return hit;
    try {
        const page = (await notion.pages.retrieve({ page_id: pageId }));
        const prop = page.properties?.[propName];
        if (prop && typeof prop === "object" && "unique_id" in prop) {
            const uid = prop.unique_id;
            if (uid && uid.number != null) {
                const formatted = uid.prefix ? `${uid.prefix}-${uid.number}` : String(uid.number);
                cache.set(cacheKey, formatted);
                return formatted;
            }
        }
        cache.set(cacheKey, "");
        return "";
    }
    catch {
        cache.set(cacheKey, "");
        return "";
    }
}
/** Notion property names for auto_increment_id on each related database. */
const UNIQUE_ID_PROP = {
    project: "Project ID",
    client: "ID",
    task: "Task ID",
};
async function maybeUpdateGitHubPrTitleFromNotion(notion, token, pr, row, opts) {
    if (!opts.enabled || opts.dryRun)
        return { ok: false, skippedReason: opts.dryRun ? "dry_run" : "disabled" };
    const parsed = parseGitHubUrl(pr.html_url);
    if (!parsed || parsed.type !== "pr")
        return { ok: false, skippedReason: "not_pr" };
    // Only patch titles on Abstract-Data org PRs
    if (parsed.owner.toLowerCase() !== ABSTRACT_DATA_ORG)
        return { ok: false, skippedReason: "not_abstract_data" };
    // Prefer the org-scoped token for Abstract-Data writes (PR title PATCH
    // requires write access the default GITHUB_TOKEN may not have).
    const effectiveToken = process.env.GITHUB_ABSTRACT_TOKEN ?? token;
    // Use the PR row's own relations, falling back to the parent repo's
    // relations when the PR row has none (common for rows created before
    // relation-inheritance was added).
    const effectiveProjectIds = row.projectIds.length > 0
        ? row.projectIds
        : (opts.repoRelations?.projectIds ?? []);
    const effectiveClientIds = row.clientIds.length > 0
        ? row.clientIds
        : (opts.repoRelations?.clientIds ?? []);
    const effectiveTaskIds = row.taskIds; // Tasks are PR-specific, no repo fallback
    console.log(TAG, `PR title check ${parsed.owner}/${parsed.repo}#${parsed.number}:`, `rowProject=${row.projectIds.length} rowClient=${row.clientIds.length} rowTask=${row.taskIds.length}`, `repoFallbackProject=${opts.repoRelations?.projectIds?.length ?? 0} repoFallbackClient=${opts.repoRelations?.clientIds?.length ?? 0}`, `effectiveProject=${effectiveProjectIds.length} effectiveClient=${effectiveClientIds.length} effectiveTask=${effectiveTaskIds.length}`);
    // Resolve auto_increment_id values from related pages
    const projectUniqueIds = [];
    for (const id of effectiveProjectIds) {
        projectUniqueIds.push(await resolveNotionPageUniqueId(notion, id, UNIQUE_ID_PROP.project, opts.idCache));
    }
    const clientUniqueIds = [];
    for (const id of effectiveClientIds) {
        clientUniqueIds.push(await resolveNotionPageUniqueId(notion, id, UNIQUE_ID_PROP.client, opts.idCache));
    }
    const taskUniqueIds = [];
    for (const id of effectiveTaskIds) {
        taskUniqueIds.push(await resolveNotionPageUniqueId(notion, id, UNIQUE_ID_PROP.task, opts.idCache));
    }
    const desired = composeGitHubPrTitleWithNotionContext(pr.title, projectUniqueIds, clientUniqueIds, taskUniqueIds);
    console.log(TAG, `PR title resolve ${parsed.owner}/${parsed.repo}#${parsed.number}:`, `projectIds=[${projectUniqueIds.join(",")}] clientIds=[${clientUniqueIds.join(",")}] taskIds=[${taskUniqueIds.join(",")}]`, `current="${pr.title}" desired="${desired}" willPatch=${desired !== pr.title}`);
    if (desired === pr.title) {
        // If prefix is empty (all IDs resolved to ""), that's a distinct skip reason
        const hasAnyId = [...projectUniqueIds, ...clientUniqueIds, ...taskUniqueIds].some((id) => id !== "");
        return { ok: false, skippedReason: hasAnyId ? "already_prefixed" : "no_resolvable_ids" };
    }
    const url = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/issues/${parsed.number}`;
    opts.apiCounter.count++;
    try {
        const res = await fetch(url, {
            method: "PATCH",
            headers: {
                Authorization: `Bearer ${effectiveToken}`,
                Accept: "application/vnd.github+json",
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ title: desired }),
        });
        if (!res.ok) {
            throw new GitHubApiError(classifyGitHubError(res, url));
        }
        return { ok: true };
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, error: msg };
    }
}
/** The GitHub org whose PRs get linked to the synced GitHub Pull Requests DB. */
const ABSTRACT_DATA_ORG = "abstract-data";
/**
 * Synced GitHub Pull Requests database ID.
 * This is the Notion-native GitHub integration's PR data source
 * that lives inside the GitHub Items multi-source database.
 * Falls back to env var GITHUB_PRS_SYNC_DATABASE_ID.
 */
function getGitHubPrsSyncDatabaseId() {
    return process.env.GITHUB_PRS_SYNC_DATABASE_ID || null;
}
/**
 * After upserting a PR row in GitHub Items, find the matching row in
 * Notion's native GitHub Pull Requests synced database and populate
 * the "GitHub Pull Requests" relation on the GitHub Items row.
 *
 * Only runs for Abstract-Data org PRs.  Matches by PR number.
 */
async function maybeLinkToSyncedGitHubPr(notion, prPageId, prNumber, repoFullName, opts) {
    // Only link Abstract-Data repos
    const owner = repoFullName.split("/")[0];
    if (!owner || owner.toLowerCase() !== ABSTRACT_DATA_ORG)
        return { linked: false };
    // Read the current "GitHub Pull Requests" relation to avoid overwriting
    try {
        const page = (await notion.pages.retrieve({ page_id: prPageId }));
        const existingRelIds = readRelationIds(page.properties, "GitHub Pull Requests");
        if (existingRelIds.length > 0)
            return { linked: false };
    }
    catch {
        // If we can't read the page, skip rather than risk overwriting
        return { linked: false, error: `Could not read page ${prPageId}` };
    }
    const syncDbId = getGitHubPrsSyncDatabaseId();
    if (!syncDbId) {
        return { linked: false, error: "GITHUB_PRS_SYNC_DATABASE_ID not set" };
    }
    try {
        // Query the synced PR database for a matching PR number
        const response = await queryDatabase(notion, syncDbId, {
            filter: {
                property: "PR Number",
                number: { equals: prNumber },
            },
            page_size: 5,
        });
        if (response.results.length === 0)
            return { linked: false };
        // Take the first match
        const syncedPrPageId = response.results[0].id;
        if (!opts.dryRun) {
            await notion.pages.update({
                page_id: prPageId,
                properties: {
                    "GitHub Pull Requests": {
                        relation: [{ id: syncedPrPageId }],
                    },
                },
            });
        }
        console.log(TAG, `Linked GitHub Items PR ${prPageId} → synced PR ${syncedPrPageId} (PR #${prNumber})`);
        return { linked: true };
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { linked: false, error: msg };
    }
}
/**
 * Builds a lookup from repo full_name (lowercase) → inherited relations.
 * Only includes Repo-type rows that have at least one relation set.
 */
function buildRelationInheritanceMap(existingRows) {
    const map = new Map();
    for (const [url, row] of existingRows) {
        if (row.type !== "Repo")
            continue;
        // Include repo if it has any relation OR a billable flag set
        if (row.projectIds.length === 0 && row.clientIds.length === 0 && !row.billable)
            continue;
        // Extract owner/repo from URL: https://github.com/Owner/Repo → owner/repo
        const match = url.match(/github\.com\/([^/]+\/[^/]+)/i);
        if (!match)
            continue;
        map.set(match[1].toLowerCase(), {
            projectIds: row.projectIds,
            clientIds: row.clientIds,
            billable: row.billable,
        });
    }
    return map;
}
/* ── Notion property builders ──────────────────────────────────── */
function buildRepoProperties(repo, firstCommitDate) {
    const createdDate = firstCommitDate
        ? toDateStr(firstCommitDate)
        : toDateStr(repo.created_at);
    const props = {
        Title: { title: [{ text: { content: repo.full_name } }] },
        Type: { select: { name: "Repo" } },
        "GitHub URL": { url: repo.html_url },
        Repo: {
            rich_text: [{ text: { content: repo.full_name } }],
        },
        Description: {
            rich_text: [{ text: { content: truncate(repo.description) } }],
        },
        Created: { date: { start: createdDate } },
        Updated: { date: { start: repo.updated_at } },
    };
    return props;
}
function buildIssueProperties(issue, repoFullName, relations) {
    const labels = mapLabels(issue.labels);
    const props = {
        Title: { title: [{ text: { content: issue.title } }] },
        Type: { select: { name: "Issue" } },
        Status: { status: { name: mapIssueStatus(issue.state) } },
        "GitHub URL": { url: issue.html_url },
        Repo: { rich_text: [{ text: { content: repoFullName } }] },
        Description: {
            rich_text: [{ text: { content: truncate(issue.body) } }],
        },
        Created: { date: { start: toDateStr(issue.created_at) } },
        Updated: { date: { start: issue.updated_at } },
    };
    if (labels.length > 0) {
        props.Labels = { multi_select: labels };
    }
    if (relations?.projectIds.length) {
        props.Project = { relation: relations.projectIds.map((id) => ({ id })) };
    }
    if (relations?.clientIds.length) {
        props.Client = { relation: relations.clientIds.map((id) => ({ id })) };
    }
    if (relations?.billable) {
        props.Billable = { checkbox: true };
    }
    return props;
}
function buildPRProperties(pr, repoFullName, relations) {
    const labels = mapLabels(pr.labels);
    const props = {
        Title: { title: [{ text: { content: pr.title } }] },
        Type: { select: { name: "PR" } },
        Status: { status: { name: mapPRStatus(pr.state, pr.merged_at) } },
        "GitHub URL": { url: pr.html_url },
        Repo: { rich_text: [{ text: { content: repoFullName } }] },
        Description: {
            rich_text: [{ text: { content: truncate(pr.body) } }],
        },
        Created: { date: { start: toDateStr(pr.created_at) } },
        Updated: { date: { start: pr.updated_at } },
    };
    if (labels.length > 0) {
        props.Labels = { multi_select: labels };
    }
    if (relations?.projectIds.length) {
        props.Project = { relation: relations.projectIds.map((id) => ({ id })) };
    }
    if (relations?.clientIds.length) {
        props.Client = { relation: relations.clientIds.map((id) => ({ id })) };
    }
    if (relations?.billable) {
        props.Billable = { checkbox: true };
    }
    return props;
}
async function upsertItem(notion, dbId, existingRows, githubUrl, githubUpdatedAt, expectedType, properties, dryRun) {
    const key = githubUrl.toLowerCase();
    const existing = existingRows.get(key);
    if (!existing) {
        // Create new row
        if (!dryRun) {
            const created = await notion.pages.create({
                parent: { database_id: dbId },
                properties: properties,
            });
            // Add to map so we don't try to create again
            const newRow = {
                id: created.id,
                updatedAt: githubUpdatedAt,
                type: expectedType,
                projectIds: readRelationIdsFromProperties(properties, "Project"),
                clientIds: readRelationIdsFromProperties(properties, "Client"),
                taskIds: readRelationIdsFromProperties(properties, "Task"),
                billable: properties["Billable"]?.checkbox === true,
            };
            existingRows.set(key, newRow);
        }
        return "created";
    }
    // Check if GitHub data is newer OR if Type is wrong
    const typeMismatch = existing.type !== "" && existing.type !== expectedType;
    if (isNewer(githubUpdatedAt, existing.updatedAt) || typeMismatch) {
        if (!dryRun) {
            await notion.pages.update({
                page_id: existing.id,
                properties: properties,
            });
            existing.updatedAt = githubUpdatedAt;
            existing.type = expectedType;
            patchExistingRowFromProperties(existing, properties);
        }
        return "updated";
    }
    return "skipped";
}
/* ── Concurrent batch helper ───────────────────────────────────── */
const REPO_CONCURRENCY = 3;
const WRITE_CONCURRENCY = 2;
/**
 * Safety cap: maximum Notion writes per run when the caller does NOT
 * provide `max_writes_per_run`.  Prevents timeout on large backlogs
 * (e.g. one-time timestamp migration).  Skipped items will be picked
 * up on subsequent runs.  Does not apply to dry-run mode so that
 * diagnostic counts remain accurate.
 */
const INTERNAL_WRITE_CAP = 75;
/**
 * Default lookback window in days when the caller does NOT provide
 * `updated_since_days`.  Prevents full-history syncs from timing out
 * the worker runtime.  Set to 180 (~6 months) to keep recent closed/
 * merged items in Notion while avoiding unbounded GitHub API pagination.
 */
const DEFAULT_UPDATED_SINCE_DAYS = 180;
async function processInBatches(items, batchSize, fn) {
    for (let i = 0; i < items.length; i += batchSize) {
        await Promise.all(items.slice(i, i + batchSize).map(fn));
    }
}
function createWriteBudget(maxWrites) {
    return {
        remaining: maxWrites != null && maxWrites > 0 ? maxWrites : Infinity,
    };
}
/**
 * Try to reserve one write from the budget.
 * Returns true if the write is allowed; false if the budget is exhausted.
 * Must be called BEFORE the Notion API call to prevent overshoot in
 * concurrent batches.
 */
function reserveBudget(budget) {
    if (budget.remaining <= 0)
        return false;
    budget.remaining--;
    return true;
}
/** Return a reserved budget unit when an upsert turns out to be a skip. */
function releaseBudget(budget) {
    budget.remaining++;
}
/* ── Token resolution ──────────────────────────────────────────── */
/**
 * Resolves the GitHub token for a source.  If the source specifies
 * `token_env`, reads that env var; otherwise falls back to GITHUB_TOKEN.
 */
function resolveToken(source) {
    if (source.token_env) {
        const token = process.env[source.token_env];
        if (!token)
            throw new Error(`${source.token_env} is not set (required for source "${source.name}")`);
        return token;
    }
    return getGitHubToken();
}
/* ── Source resolution ──────────────────────────────────────────── */
function resolveSources(input) {
    if (input.sources && input.sources.length > 0) {
        return input.sources;
    }
    if (input.org_name?.trim()) {
        return [{ name: input.org_name.trim(), type: "org" }];
    }
    return [];
}
/* ── Main execution ────────────────────────────────────────────── */
export async function executeSyncGitHubItems(input, notion) {
    const sources = resolveSources(input);
    if (sources.length === 0) {
        return {
            success: false,
            error: "At least one source is required (provide `sources` array or legacy `org_name`).",
        };
    }
    const includeForks = input.include_forks ?? false;
    const includeArchived = input.include_archived ?? true;
    const includeIssues = input.include_issues ?? true;
    const includePRs = input.include_prs ?? true;
    const dryRun = input.dry_run ?? true;
    // Always default to false — we want closed/merged items from the lookback window
    const openOnly = input.open_only ?? false;
    // ── Bounded execution: wall-clock timer + per-run limits ──
    // Platform hard-stops capability calls at ~60s. We exit at 40s by default
    // to leave headroom for in-flight I/O and the response trip back through
    // Notion. Caller can override (1..55).
    const startMs = Date.now();
    const requestedSeconds = input.max_seconds ?? 40;
    const maxMs = Math.min(Math.max(requestedSeconds, 1), 55) * 1000;
    const isTimeUp = () => Date.now() - startMs >= maxMs;
    /** Seconds-since-start formatted for log lines: "[+12.3s]". */
    const T = () => `[+${((Date.now() - startMs) / 1000).toFixed(1)}s]`;
    const phaseTimings = {};
    const startPhase = (name) => {
        const t0 = Date.now();
        return () => { phaseTimings[name] = (phaseTimings[name] ?? 0) + (Date.now() - t0); };
    };
    // Default per-call caps so a single invocation always returns quickly.
    // The agent loops with `resume_cursor` until `is_complete=true`. Set to
    // 0 (or pass Infinity) to disable.
    const maxReposPerRun = input.max_repos_per_run ?? 5;
    const maxItemsPerRun = input.max_items_per_run ?? 200;
    let totalItemsScanned = 0;
    let apiCallCount = 0;
    try {
        const dbId = getGitHubItemsSyncDatabaseId();
        const apiCounter = { count: 0 };
        // ── 1. Fetch repos from all sources ──
        // Track which token to use for each repo (keyed by full_name lowercase).
        const repoTokenMap = new Map();
        const allRepos = [];
        const sourceNames = sources.map((s) => `${s.name} (${s.type})`);
        for (const source of sources) {
            console.log(TAG, T(), `Fetching repos for ${source.type} "${source.name}"...`);
            const sourceToken = resolveToken(source);
            const endRepoListPhase = startPhase("repo_list");
            const repos = await fetchAllRepos(source, sourceToken, apiCounter);
            endRepoListPhase();
            for (const r of repos) {
                repoTokenMap.set(r.full_name.toLowerCase(), sourceToken);
            }
            console.log(TAG, T(), `  → ${repos.length} repos from ${source.name}`);
            allRepos.push(...repos);
        }
        // ── 2. Filter repos ──
        let filteredRepos = allRepos;
        if (!includeForks) {
            filteredRepos = filteredRepos.filter((r) => !r.fork);
        }
        if (!includeArchived) {
            filteredRepos = filteredRepos.filter((r) => !r.archived);
        }
        console.log(TAG, `${filteredRepos.length} repos after filtering (forks=${includeForks}, archived=${includeArchived})`);
        // ── 3. Pre-load existing Notion rows ──
        console.log(TAG, T(), "Pre-loading existing Notion rows...");
        const endPreloadPhase = startPhase("notion_preload");
        const existingRows = await preloadNotionRows(notion, dbId);
        endPreloadPhase();
        console.log(TAG, T(), `  → ${existingRows.size} existing rows loaded`);
        // ── 4. Build relation inheritance map ──
        const inheritanceMap = buildRelationInheritanceMap(existingRows);
        console.log(TAG, `  → ${inheritanceMap.size} repos with inheritable relations`);
        // ── 5. Compute incremental-sync cutoff ──
        // Default to DEFAULT_UPDATED_SINCE_DAYS (180) when caller omits the param.
        // Pass updated_since_days=0 explicitly to force a full-history sync.
        const effectiveSinceDays = input.updated_since_days != null
            ? input.updated_since_days
            : DEFAULT_UPDATED_SINCE_DAYS;
        let sinceISO;
        if (effectiveSinceDays > 0) {
            const cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - effectiveSinceDays);
            sinceISO = cutoff.toISOString();
            console.log(TAG, `Incremental sync: only items updated since ${sinceISO} (${effectiveSinceDays} days)`);
        }
        else {
            console.log(TAG, `Full-history sync (updated_since_days=0)`);
        }
        // ── 6. Sync repos, issues, PRs (sequential with early-exit) ──
        // In dry-run mode use unlimited budget for accurate reporting.
        // Otherwise, fall back to INTERNAL_WRITE_CAP to prevent timeout.
        const effectiveMaxWrites = dryRun
            ? undefined
            : (input.max_writes_per_run ?? INTERNAL_WRITE_CAP);
        const budget = createWriteBudget(effectiveMaxWrites);
        const reposFound = filteredRepos.length;
        let reposProcessed = 0;
        let issuesFound = 0;
        let prsFound = 0;
        let created = 0;
        let updated = 0;
        let skipped = 0;
        let budgetSkipped = 0;
        let errors = 0;
        let unlinkedRepos = 0;
        const errorDetails = [];
        let resumeCursor = null;
        let isComplete = true;
        let timeCutoffHit = false;
        let budgetExhausted = false;
        let prTitlesUpdated = 0;
        let prTitleAttempts = 0;
        const prTitleSkipReasons = new Map();
        let prTitleErrors = 0;
        const prTitleErrorDetails = [];
        let prLinksCreated = 0;
        const notionIdCache = new Map();
        // Default to false — per-PR title PATCH is expensive (Notion lookup +
        // GitHub PATCH per PR) and was the dominant cause of the daily 60s
        // platform-timeout. Agents that need it must opt in explicitly.
        const updateGithubPrTitles = input.update_github_pr_titles ?? false;
        console.log(TAG, `update_github_pr_titles=${updateGithubPrTitles} (raw input: ${input.update_github_pr_titles})`);
        /** Check if we should stop early due to time, budget, or limits. */
        function shouldStop() {
            if (isTimeUp()) {
                timeCutoffHit = true;
                return true;
            }
            if (budget.remaining <= 0 && !dryRun) {
                budgetExhausted = true;
                return true;
            }
            if (reposProcessed >= maxReposPerRun)
                return true;
            if (totalItemsScanned >= maxItemsPerRun)
                return true;
            return false;
        }
        const startRepoIndex = input.resume_cursor?.repo_index ?? 0;
        const resumePhase = input.resume_cursor?.phase ?? "issues";
        if (startRepoIndex > 0) {
            console.log(TAG, `Resuming from repo index ${startRepoIndex}, phase=${resumePhase}`);
        }
        for (let repoIdx = startRepoIndex; repoIdx < filteredRepos.length; repoIdx++) {
            if (shouldStop()) {
                resumeCursor = { repo_index: repoIdx, phase: "issues" };
                isComplete = false;
                console.log(TAG, `Early exit at repo index ${repoIdx}/${filteredRepos.length}`);
                break;
            }
            const repo = filteredRepos[repoIdx];
            const token = repoTokenMap.get(repo.full_name.toLowerCase()) ?? getGitHubToken();
            const skipIssuesForResume = repoIdx === startRepoIndex && resumePhase === "prs";
            // 6a. Upsert repo row
            if (!reserveBudget(budget)) {
                budgetSkipped++;
            }
            else {
                try {
                    // Only fetch first-commit date for new repos to avoid extra API calls
                    const isNewRepo = !existingRows.has(repo.html_url.toLowerCase());
                    let firstCommitDate = null;
                    if (isNewRepo) {
                        const [owner_, repoName_] = repo.full_name.split("/");
                        if (owner_ && repoName_) {
                            firstCommitDate = await fetchFirstCommitDate(owner_, repoName_, token, {
                                isFork: repo.fork,
                                authorLogin: repo.owner.login,
                                apiCounter,
                            });
                        }
                    }
                    const props = buildRepoProperties(repo, firstCommitDate);
                    const result = await upsertItem(notion, dbId, existingRows, repo.html_url, repo.updated_at, "Repo", props, dryRun);
                    if (result === "created")
                        created++;
                    else if (result === "updated")
                        updated++;
                    else {
                        skipped++;
                        releaseBudget(budget);
                    }
                }
                catch (e) {
                    releaseBudget(budget);
                    errors++;
                    const msg = e instanceof Error ? e.message : String(e);
                    errorDetails.push(`Repo ${repo.full_name}: ${msg}`);
                    console.error(TAG, `Error upserting repo ${repo.full_name}:`, msg);
                }
            }
            const [owner, repoName] = repo.full_name.split("/");
            if (!owner || !repoName) {
                reposProcessed++;
                continue;
            }
            // Track unlinked repos (no Client relation)
            const repoKey = repo.full_name.toLowerCase();
            if (!inheritanceMap.has(repoKey)) {
                unlinkedRepos++;
            }
            // Resolve inherited relations for this repo's issues/PRs
            const repoRelations = inheritanceMap.get(repoKey);
            // 6b. Sync issues (skip if resuming past issues phase)
            if (includeIssues && !skipIssuesForResume) {
                // Pre-fetch time guard: skip starting a potentially long pagination
                // when budget is mostly consumed. Resume here next call.
                if (isTimeUp()) {
                    timeCutoffHit = true;
                    resumeCursor = { repo_index: repoIdx, phase: "issues" };
                    isComplete = false;
                    console.log(TAG, T(), `Pre-issues time cutoff at ${repo.full_name}`);
                    break;
                }
                try {
                    const endIssuesPhase = startPhase("github_issues_fetch");
                    const allIssues = await fetchAllIssues(owner, repoName, token, sinceISO, apiCounter);
                    endIssuesPhase();
                    const issues = openOnly ? allIssues.filter((i) => i.state === "open") : allIssues;
                    issuesFound += issues.length;
                    totalItemsScanned += issues.length;
                    await processInBatches(issues, WRITE_CONCURRENCY, async (issue) => {
                        if (!reserveBudget(budget)) {
                            budgetSkipped++;
                            return;
                        }
                        try {
                            const isNew = !existingRows.has(issue.html_url.toLowerCase());
                            // Always inherit Client, Project, Billable from repo — relations
                            // are never set directly on Issues, only on their parent Repo row.
                            const props = buildIssueProperties(issue, repo.full_name, repoRelations);
                            const result = await upsertItem(notion, dbId, existingRows, issue.html_url, issue.updated_at, "Issue", props, dryRun);
                            if (result === "created")
                                created++;
                            else if (result === "updated")
                                updated++;
                            else {
                                skipped++;
                                releaseBudget(budget);
                            }
                        }
                        catch (e) {
                            releaseBudget(budget);
                            errors++;
                            const msg = e instanceof Error ? e.message : String(e);
                            errorDetails.push(`Issue ${repo.full_name}#${issue.number}: ${msg}`);
                            console.error(TAG, `Error upserting issue ${repo.full_name}#${issue.number}:`, msg);
                        }
                    });
                }
                catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    errorDetails.push(`Issues fetch ${repo.full_name}: ${msg}`);
                    console.error(TAG, `Error fetching issues for ${repo.full_name}:`, msg);
                }
                // Check time after issues — if up, save cursor at PRs phase for this repo
                if (isTimeUp()) {
                    timeCutoffHit = true;
                    resumeCursor = { repo_index: repoIdx, phase: "prs" };
                    isComplete = false;
                    console.log(TAG, `Time cutoff after issues for ${repo.full_name}`);
                    break;
                }
            }
            // 6c. Sync PRs
            if (includePRs) {
                // Pre-fetch time guard for PRs phase. Resume cursor saves "prs" so
                // the next call skips the issues phase for this repo.
                if (isTimeUp()) {
                    timeCutoffHit = true;
                    resumeCursor = { repo_index: repoIdx, phase: "prs" };
                    isComplete = false;
                    console.log(TAG, T(), `Pre-PRs time cutoff at ${repo.full_name}`);
                    break;
                }
                try {
                    const endPrsPhase = startPhase("github_prs_fetch");
                    const allPRs = await fetchAllPRs(owner, repoName, token, sinceISO, apiCounter);
                    endPrsPhase();
                    const prs = openOnly ? allPRs.filter((pr) => pr.state === "open") : allPRs;
                    prsFound += prs.length;
                    totalItemsScanned += prs.length;
                    await processInBatches(prs, WRITE_CONCURRENCY, async (pr) => {
                        if (!reserveBudget(budget)) {
                            budgetSkipped++;
                            return;
                        }
                        let upsertFailed = false;
                        try {
                            const isNew = !existingRows.has(pr.html_url.toLowerCase());
                            // Always inherit Client, Project, Billable from repo — relations
                            // are never set directly on PRs, only on their parent Repo row.
                            const props = buildPRProperties(pr, repo.full_name, repoRelations);
                            const result = await upsertItem(notion, dbId, existingRows, pr.html_url, pr.updated_at, "PR", props, dryRun);
                            if (result === "created")
                                created++;
                            else if (result === "updated")
                                updated++;
                            else {
                                skipped++;
                                releaseBudget(budget);
                            }
                        }
                        catch (e) {
                            upsertFailed = true;
                            releaseBudget(budget);
                            errors++;
                            const msg = e instanceof Error ? e.message : String(e);
                            errorDetails.push(`PR ${repo.full_name}#${pr.number}: ${msg}`);
                            console.error(TAG, `Error upserting PR ${repo.full_name}#${pr.number}:`, msg);
                        }
                        if (!upsertFailed && updateGithubPrTitles) {
                            const rowAfter = existingRows.get(pr.html_url.toLowerCase());
                            if (rowAfter?.type === "PR") {
                                prTitleAttempts++;
                                const endTitlePhase = startPhase("pr_title_update");
                                const titleRes = await maybeUpdateGitHubPrTitleFromNotion(notion, token, pr, rowAfter, {
                                    dryRun,
                                    enabled: true,
                                    idCache: notionIdCache,
                                    apiCounter,
                                    repoRelations,
                                });
                                endTitlePhase();
                                if (titleRes.ok)
                                    prTitlesUpdated++;
                                else if (titleRes.error) {
                                    prTitleErrors++;
                                    prTitleErrorDetails.push(`${repo.full_name}#${pr.number}: ${titleRes.error}`);
                                    // Title updates are best-effort; log but don't count as sync errors
                                    console.warn(TAG, `PR title sync failed ${repo.full_name}#${pr.number}:`, titleRes.error);
                                }
                                else if (titleRes.skippedReason) {
                                    const count = prTitleSkipReasons.get(titleRes.skippedReason) ?? 0;
                                    prTitleSkipReasons.set(titleRes.skippedReason, count + 1);
                                }
                            }
                        }
                        // Link GitHub Items PR → synced GitHub Pull Requests DB (Abstract-Data only)
                        if (!upsertFailed) {
                            const rowForLink = existingRows.get(pr.html_url.toLowerCase());
                            if (rowForLink?.type === "PR") {
                                const linkRes = await maybeLinkToSyncedGitHubPr(notion, rowForLink.id, pr.number, repo.full_name, { dryRun });
                                if (linkRes.linked)
                                    prLinksCreated++;
                                else if (linkRes.error) {
                                    console.error(TAG, `PR link failed ${repo.full_name}#${pr.number}: ${linkRes.error}`);
                                }
                            }
                        }
                    });
                }
                catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    errorDetails.push(`PRs fetch ${repo.full_name}: ${msg}`);
                    console.error(TAG, `Error fetching PRs for ${repo.full_name}:`, msg);
                }
            }
            reposProcessed++;
        }
        const elapsedMs = Date.now() - startMs;
        const modeLabel = dryRun ? "DRY RUN — " : "";
        const completionLabel = isComplete ? "" : "⚠️ Partial — ";
        const openOnlyNote = openOnly ? " (open only)" : "";
        const linkedNote = unlinkedRepos > 0 ? ` (${unlinkedRepos} repos unlinked to Client)` : "";
        const budgetNote = budgetSkipped > 0 ? ` Budget exhausted — ${budgetSkipped} items deferred.` : "";
        const resumeNote = resumeCursor
            ? ` Resume from repo ${resumeCursor.repo_index}/${filteredRepos.length} (${resumeCursor.phase}).`
            : "";
        const backlinkNote = prLinksCreated > 0 ? ` ${prLinksCreated} PR links created.` : "";
        const summary = `${completionLabel}${modeLabel}Synced [${sourceNames.join(", ")}]${openOnlyNote}: ${reposFound} repos (${reposProcessed} processed), ${issuesFound} issues, ${prsFound} PRs. ${created} created, ${updated} updated, ${skipped} skipped, ${errors} errors.${linkedNote}${backlinkNote}${budgetNote}${resumeNote} [${elapsedMs}ms]`;
        console.log(TAG, summary);
        const phaseSummary = Object.entries(phaseTimings)
            .map(([phase, ms]) => `${phase}=${(ms / 1000).toFixed(2)}s`)
            .join(" ");
        console.log(TAG, `Phase timings: ${phaseSummary || "(none)"}; total elapsed=${((Date.now() - startMs) / 1000).toFixed(2)}s`);
        const instrumentation = {
            repos_scanned: reposProcessed,
            items_scanned: totalItemsScanned,
            items_upserted: created + updated,
            api_calls: apiCounter.count,
            elapsed_ms: elapsedMs,
            budget_exhausted: budgetExhausted,
            time_cutoff_hit: timeCutoffHit,
        };
        return {
            success: true,
            repos_found: reposFound,
            issues_found: issuesFound,
            prs_found: prsFound,
            created,
            updated,
            skipped,
            errors,
            unlinked_repos: unlinkedRepos,
            error_details: errorDetails,
            summary,
            is_complete: isComplete,
            resume_cursor: resumeCursor,
            instrumentation,
            github_pr_titles_updated: prTitlesUpdated,
            github_pr_title_attempts: prTitleAttempts,
            github_pr_title_errors: prTitleErrors,
            github_pr_title_error_details: prTitleErrorDetails,
            github_pr_title_skip_reasons: Object.fromEntries(prTitleSkipReasons),
            github_pr_backlinks_created: prLinksCreated,
        };
    }
    catch (e) {
        const message = extractErrorMessage(e);
        console.error(TAG, "error:", message);
        return { success: false, error: message };
    }
}
