/**
 * sync-github-repos: Notion Workers Sync that pulls GitHub repos, issues,
 * and PRs into a Notion database using the native worker.sync() API.
 *
 * This is a PARALLEL deployment alongside the existing sync-github-items tool.
 * The sync manages its own database — Notion handles row matching by primary
 * key (GitHub URL), pagination state, and stale-row cleanup.
 *
 * Migration note: Once validated, this can replace sync-github-items. The
 * existing GitHub Items DB would need a one-time data migration.
 */
import * as Schema from "@notionhq/workers/schema";
import * as Builder from "@notionhq/workers/builder";
import { getGitHubToken, getNotionClient, getGitHubItemsSyncDatabaseId, queryDatabase } from "../shared/notion-client.js";
import { classifyGitHubError, GitHubApiError } from "../shared/github-utils.js";
/* ── Constants ─────────────────────────────────────────────────── */
const VALID_LABELS = new Set([
    "bug",
    "feature",
    "enhancement",
    "documentation",
    "good first issue",
    "chore",
    "refactor",
    "test",
    "ci",
    "style",
    "performance",
]);
/** Sources to sync — matches the existing agent config. */
const DEFAULT_SOURCES = [
    { name: "Abstract-Data", type: "org" },
    { name: "JREakin", type: "user" },
];
/* ── Helpers ───────────────────────────────────────────────────── */
function truncate(text, maxLen = 2000) {
    if (!text)
        return "";
    return text.length > maxLen ? text.slice(0, maxLen - 3) + "..." : text;
}
/**
 * Strip markdown to plain text for use in rich-text properties (where markdown
 * renders as literal characters). Best-effort; full body still goes to
 * `pageContentMarkdown` where the SDK converts it to real Notion blocks.
 */
function stripMarkdown(text) {
    if (!text)
        return "";
    return text
        .replace(/```[\s\S]*?```/g, " ") // fenced code blocks
        .replace(/`([^`]+)`/g, "$1") // inline code
        .replace(/!\[[^\]]*]\([^)]+\)/g, " ") // images
        .replace(/\[([^\]]+)]\([^)]+\)/g, "$1") // links → label only
        .replace(/^\s{0,3}#{1,6}\s+/gm, "") // headings
        .replace(/^\s{0,3}>\s?/gm, "") // blockquotes
        .replace(/^\s{0,3}[-*+]\s+/gm, "") // bullet markers
        .replace(/^\s{0,3}\d+\.\s+/gm, "") // ordered list markers
        .replace(/(\*\*|__)(.*?)\1/g, "$2") // bold
        .replace(/(\*|_)(.*?)\1/g, "$2") // italic
        .replace(/\s+/g, " ")
        .trim();
}
function previewText(text, maxLen = 280) {
    return truncate(stripMarkdown(text), maxLen);
}
/**
 * Cap pageContentMarkdown payload so a single sync-phase response (which can
 * carry ~200 items at once) stays under the platform's runtime response size
 * limit. The full PR/issue body is the dominant size contributor — capping it
 * at 2KB per item keeps the response well under 1MB total. Anything longer is
 * truncated with an explicit "…[truncated]" marker so readers know to follow
 * the GitHub URL for the rest.
 */
const PAGE_CONTENT_MARKDOWN_CAP = 2_000;
function capPageMarkdown(text) {
    if (text.length <= PAGE_CONTENT_MARKDOWN_CAP)
        return text;
    return text.slice(0, PAGE_CONTENT_MARKDOWN_CAP - 20).trimEnd() + "\n\n…[truncated]";
}
/**
 * Strip noise that doesn't render as proper Notion blocks (or just clutters
 * the page) before handing markdown to the SDK's converter:
 *   - GitButler stack footer (between explicit boundary markers, plus the
 *     legacy "This is **part X of Y in a stack**" preamble if no markers).
 *   - HTML comments.
 *   - Trailing whitespace runs.
 */
function cleanBodyMarkdown(text) {
    if (!text)
        return "";
    let out = text;
    // GitButler boundary-marked footer (current convention).
    out = out.replace(/<!--\s*GitButler Footer Boundary Top\s*-->[\s\S]*?<!--\s*GitButler Footer Boundary Bottom\s*-->/gi, "");
    // Trailing GitButler footer when only the bottom marker is present.
    out = out.replace(/(?:^|\n)This is \*\*part \d+ of \d+ in a stack\*\*[\s\S]*?<!--\s*GitButler Footer Boundary Bottom\s*-->/gi, "");
    // Legacy GitButler footer with no boundary markers — strip from the
    // "This is **part X of Y in a stack**" line to end of message.
    out = out.replace(/(?:^|\n)This is \*\*part \d+ of \d+ in a stack\*\*[\s\S]*$/i, "");
    // Any remaining HTML comments.
    out = out.replace(/<!--[\s\S]*?-->/g, "");
    return out.replace(/\n{3,}/g, "\n\n").trim();
}
function toDateStr(iso) {
    return iso.slice(0, 10);
}
function mapLabels(labels) {
    return labels
        .filter((l) => VALID_LABELS.has(l.name.toLowerCase()))
        .map((l) => l.name.toLowerCase());
}
function mapPRStatus(state, mergedAt) {
    if (mergedAt)
        return "Merged";
    return state === "open" ? "Open" : "Closed";
}
/* ── GitHub fetch functions ────────────────────────────────────── */
async function paginatedGitHubGet(baseUrl, token) {
    const items = [];
    let url = baseUrl.includes("?")
        ? `${baseUrl}&per_page=100`
        : `${baseUrl}?per_page=100`;
    while (url) {
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
async function fetchOrgRepos(orgName, token) {
    return paginatedGitHubGet(`https://api.github.com/orgs/${orgName}/repos?type=all`, token);
}
async function fetchUserRepos(userName, token) {
    const allRepos = await paginatedGitHubGet("https://api.github.com/user/repos?per_page=100", token);
    return allRepos.filter((r) => r.owner.login.toLowerCase() === userName.toLowerCase());
}
async function fetchRepoIssues(owner, repo, token, since) {
    let url = `https://api.github.com/repos/${owner}/${repo}/issues?state=all`;
    if (since)
        url += `&since=${since}`;
    const items = await paginatedGitHubGet(url, token);
    return items.filter((i) => !i.pull_request);
}
async function fetchRepoPRs(owner, repo, token) {
    return paginatedGitHubGet(`https://api.github.com/repos/${owner}/${repo}/pulls?state=all`, token);
}
/** Narrows an unknown runtime value to SyncState (or undefined for a fresh run). */
function parseSyncState(value) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== "object")
        return undefined;
    const v = value;
    if (typeof v["phase"] === "string" &&
        ["repos", "inherit", "issues", "prs"].includes(v["phase"]) &&
        typeof v["repoIndex"] === "number" &&
        Array.isArray(v["repos"])) {
        return v;
    }
    return undefined;
}
/** Helper to build a typed SyncState — prevents literal type widening on spread. */
function nextPhase(current, phase, repoIndex, inheritCursor) {
    return {
        phase,
        repoIndex: repoIndex ?? current.repoIndex,
        repos: current.repos,
        inheritanceMap: current.inheritanceMap,
        inheritCursor,
    };
}
/* ── Schema definition ─────────────────────────────────────────── */
/**
 * The database schema Notion will create and manage.
 * Maps to the same properties as the existing GitHub Items DB.
 */
export const githubItemsSchema = {
    defaultName: "GitHub Items (Sync)",
    properties: {
        Title: Schema.title(),
        "GitHub URL": Schema.url(),
        Type: Schema.select([
            { name: "Repo" },
            { name: "Issue" },
            { name: "PR" },
        ]),
        Status: Schema.status({
            groups: [
                { name: "To-do", options: [{ name: "Open" }] },
                { name: "In progress", options: [] },
                { name: "Complete", options: [{ name: "Closed" }, { name: "Merged" }] },
            ],
        }),
        Repo: Schema.richText(),
        Description: Schema.richText(),
        Labels: Schema.multiSelect([
            { name: "bug" },
            { name: "feature" },
            { name: "enhancement" },
            { name: "documentation" },
            { name: "good first issue" },
            { name: "chore" },
            { name: "refactor" },
            { name: "test" },
            { name: "ci" },
            { name: "style" },
            { name: "performance" },
        ]),
        Created: Schema.date(),
        Updated: Schema.date(),
    },
};
/* ── Change builders ───────────────────────────────────────────── */
function repoToChange(repo) {
    return {
        type: "upsert",
        key: repo.html_url,
        properties: {
            Title: Builder.title(repo.full_name),
            "GitHub URL": Builder.url(repo.html_url),
            Type: Builder.select("Repo"),
            Repo: Builder.richText(repo.full_name),
            Description: Builder.richText(previewText(repo.description)),
            Created: Builder.date(toDateStr(repo.created_at)),
            Updated: Builder.date(toDateStr(repo.updated_at)),
        },
        ...((() => {
            const body = cleanBodyMarkdown(repo.description);
            return body ? { pageContentMarkdown: capPageMarkdown(body) } : {};
        })()),
    };
}
function issueToChange(issue, repoFullName) {
    const labels = mapLabels(issue.labels);
    return {
        type: "upsert",
        key: issue.html_url,
        properties: {
            Title: Builder.title(issue.title),
            "GitHub URL": Builder.url(issue.html_url),
            Type: Builder.select("Issue"),
            Status: Builder.status(issue.state === "open" ? "Open" : "Closed"),
            Repo: Builder.richText(repoFullName),
            Description: Builder.richText(previewText(issue.body)),
            Labels: Builder.multiSelect(...labels),
            Created: Builder.date(toDateStr(issue.created_at)),
            Updated: Builder.date(toDateStr(issue.updated_at)),
        },
        ...((() => {
            const body = cleanBodyMarkdown(issue.body);
            return body ? { pageContentMarkdown: capPageMarkdown(body) } : {};
        })()),
    };
}
function prToChange(pr, repoFullName) {
    const labels = mapLabels(pr.labels);
    return {
        type: "upsert",
        key: pr.html_url,
        properties: {
            Title: Builder.title(pr.title),
            "GitHub URL": Builder.url(pr.html_url),
            Type: Builder.select("PR"),
            Status: Builder.status(mapPRStatus(pr.state, pr.merged_at)),
            Repo: Builder.richText(repoFullName),
            Description: Builder.richText(previewText(pr.body)),
            Labels: Builder.multiSelect(...labels),
            Created: Builder.date(toDateStr(pr.created_at)),
            Updated: Builder.date(toDateStr(pr.updated_at)),
        },
        ...((() => {
            const body = cleanBodyMarkdown(pr.body);
            return body ? { pageContentMarkdown: capPageMarkdown(body) } : {};
        })()),
    };
}
/* ── Inheritance helpers ───────────────────────────────────────── */
/** Read page IDs from a Notion relation property. */
function readRelIds(properties, propName) {
    const prop = properties[propName];
    if (!prop || typeof prop !== "object" || !("relation" in prop))
        return [];
    const rel = prop.relation;
    return (rel ?? []).map((r) => r.id);
}
/**
 * Query the sync DB for Repo rows and build an inheritance map:
 * repo full_name (lowercase) → { clientIds, projectIds, taskIds, billable }
 * Only includes repos that have at least one inherited value set.
 */
async function buildInheritanceMap(dbId) {
    const notion = getNotionClient();
    const map = {};
    let cursor;
    do {
        const resp = await queryDatabase(notion, dbId, {
            filter: { property: "Type", select: { equals: "Repo" } },
            start_cursor: cursor,
            page_size: 100,
        });
        for (const page of resp.results) {
            if (!("properties" in page))
                continue;
            const props = page.properties;
            // Repo full_name lives in the Repo rich-text property
            const repoProp = props["Repo"];
            let repoKey = "";
            if (repoProp && typeof repoProp === "object" && "rich_text" in repoProp) {
                const rt = repoProp.rich_text;
                repoKey = rt.map((s) => s.plain_text).join("").trim().toLowerCase();
            }
            if (!repoKey)
                continue;
            // Property names match the live GitHub Items (Sync) DB schema —
            // plural "Clients", emoji-prefixed "📊 Projects", "✅ Tasks".
            const clientIds = readRelIds(props, "Clients");
            const projectIds = readRelIds(props, "📊 Projects");
            const taskIds = readRelIds(props, "✅ Tasks");
            let billable = false;
            const bProp = props["Billable"];
            if (bProp && typeof bProp === "object" && "checkbox" in bProp) {
                billable = bProp.checkbox === true;
            }
            if (clientIds.length || projectIds.length || taskIds.length || billable) {
                map[repoKey] = { clientIds, projectIds, taskIds, billable };
            }
        }
        cursor = resp.has_more ? (resp.next_cursor ?? undefined) : undefined;
    } while (cursor);
    return map;
}
/**
 * Process one page (up to 100 rows) of Issue/PR rows from the sync DB,
 * stamping inherited Client/Project/Task/Billable from the inheritance map.
 * Only touches Issue and PR rows — never Repo rows.
 */
async function applyInheritanceBatch(dbId, inheritanceMap, cursor) {
    const notion = getNotionClient();
    const resp = await queryDatabase(notion, dbId, {
        filter: {
            or: [
                { property: "Type", select: { equals: "Issue" } },
                { property: "Type", select: { equals: "PR" } },
            ],
        },
        start_cursor: cursor,
        page_size: 100,
    });
    let updated = 0;
    for (const page of resp.results) {
        if (!("properties" in page))
            continue;
        const props = page.properties;
        // Parse repo key from GitHub URL: https://github.com/Owner/Repo/...
        const urlProp = props["GitHub URL"];
        let githubUrl = "";
        if (urlProp && typeof urlProp === "object" && "url" in urlProp) {
            githubUrl = (urlProp.url ?? "").trim();
        }
        if (!githubUrl)
            continue;
        const match = githubUrl.match(/github\.com\/([^/]+\/[^/]+)/i);
        if (!match)
            continue;
        const repoKey = match[1].toLowerCase();
        const inheritance = inheritanceMap[repoKey];
        if (!inheritance)
            continue;
        const updateProps = {
            Billable: { checkbox: inheritance.billable },
        };
        if (inheritance.clientIds.length) {
            updateProps["Clients"] = { relation: inheritance.clientIds.map((id) => ({ id })) };
        }
        if (inheritance.projectIds.length) {
            updateProps["📊 Projects"] = { relation: inheritance.projectIds.map((id) => ({ id })) };
        }
        if (inheritance.taskIds.length) {
            updateProps["✅ Tasks"] = { relation: inheritance.taskIds.map((id) => ({ id })) };
        }
        await notion.pages.update({
            page_id: page.id,
            properties: updateProps,
        });
        updated++;
    }
    return {
        nextCursor: resp.has_more ? (resp.next_cursor ?? undefined) : undefined,
        updated,
    };
}
/* ── Execute function ──────────────────────────────────────────── */
/**
 * The sync execute function. Called repeatedly by the runtime:
 *   1. First call (no state): fetch repos, return repo upserts, nextState with repos list
 *   2. Subsequent calls: iterate repos, return issue/PR upserts per repo
 *   3. Final call: hasMore=false, stale records are cleaned up by runtime
 */
export async function executeSyncGitHubRepos(rawState, _context) {
    const state = parseSyncState(rawState);
    const token = getGitHubToken();
    // ── Phase 1: Fetch and return repos ──
    if (!state || state.phase === "repos") {
        const allRepos = [];
        for (const source of DEFAULT_SOURCES) {
            const repos = source.type === "org"
                ? await fetchOrgRepos(source.name, token)
                : await fetchUserRepos(source.name, token);
            allRepos.push(...repos);
        }
        // Filter: no forks by default
        const filtered = allRepos.filter((r) => !r.fork);
        const changes = filtered.map(repoToChange);
        // Serialize minimal repo data for subsequent phases
        const repoList = filtered.map((r) => ({
            full_name: r.full_name,
            html_url: r.html_url,
            fork: r.fork,
            archived: r.archived,
        }));
        // Build inheritance map from existing Repo rows before moving on.
        // This is read once per sync cycle and carried through subsequent phases.
        let inheritanceMap = {};
        try {
            inheritanceMap = await buildInheritanceMap(getGitHubItemsSyncDatabaseId());
            console.log("[sync-github-repos]", `Inheritance map built: ${Object.keys(inheritanceMap).length} repos with inherited values`);
        }
        catch (e) {
            console.error("[sync-github-repos] Failed to build inheritance map:", e);
        }
        const nextState = repoList.length > 0
            ? { phase: "inherit", repoIndex: 0, repos: repoList, inheritanceMap }
            : undefined;
        return { changes, hasMore: repoList.length > 0, nextState };
    }
    // ── Phase 2: Inherit — stamp Client/Project/Task/Billable onto Issues + PRs ──
    // Only touches Issue and PR rows; Repo rows are never modified here.
    // Wrapped in try/catch so a missing GITHUB_ITEMS_SYNC_DATABASE_ID or a Notion
    // error degrades gracefully — repos still got upserted in phase 1, and we
    // advance to the issues/PRs phases instead of stalling the whole sync.
    if (state.phase === "inherit") {
        const inheritanceMap = state.inheritanceMap ?? {};
        try {
            const dbId = getGitHubItemsSyncDatabaseId();
            const { nextCursor, updated } = await applyInheritanceBatch(dbId, inheritanceMap, state.inheritCursor);
            console.log("[sync-github-repos]", `Inherit batch: ${updated} rows updated`);
            if (nextCursor) {
                // More pages of Issue/PR rows to process
                return {
                    changes: [],
                    hasMore: true,
                    nextState: nextPhase(state, "inherit", state.repoIndex, nextCursor),
                };
            }
        }
        catch (e) {
            console.error("[sync-github-repos] Inherit phase error (skipping to issues/PRs):", e);
        }
        // Inherit complete (or skipped on error) — move to issues phase
        return {
            changes: [],
            hasMore: state.repos.length > 0,
            nextState: state.repos.length > 0
                ? nextPhase(state, "issues", 0)
                : undefined,
        };
    }
    // ── Phase 3: Issues for current repo ──
    if (state.phase === "issues") {
        const repo = state.repos[state.repoIndex];
        if (!repo) {
            return { changes: [], hasMore: false, nextState: undefined };
        }
        const [owner, repoName] = repo.full_name.split("/");
        if (!owner || !repoName) {
            // Skip malformed, advance to PRs
            return {
                changes: [],
                hasMore: true,
                nextState: nextPhase(state, "prs"),
            };
        }
        try {
            // Use 180-day lookback for incremental efficiency
            const cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - 180);
            const issues = await fetchRepoIssues(owner, repoName, token, cutoff.toISOString());
            const changes = issues.map((i) => issueToChange(i, repo.full_name));
            return {
                changes,
                hasMore: true,
                nextState: nextPhase(state, "prs"),
            };
        }
        catch (e) {
            console.error(`[sync-github-repos] Error fetching issues for ${repo.full_name}:`, e);
            return {
                changes: [],
                hasMore: true,
                nextState: nextPhase(state, "prs"),
            };
        }
    }
    // ── Phase 3: PRs for current repo ──
    if (state.phase === "prs") {
        const repo = state.repos[state.repoIndex];
        if (!repo) {
            return { changes: [], hasMore: false, nextState: undefined };
        }
        const [owner, repoName] = repo.full_name.split("/");
        if (!owner || !repoName) {
            // Advance to next repo
            const nextIndex = state.repoIndex + 1;
            return {
                changes: [],
                hasMore: nextIndex < state.repos.length,
                nextState: nextIndex < state.repos.length
                    ? nextPhase(state, "issues", nextIndex)
                    : undefined,
            };
        }
        try {
            const prs = await fetchRepoPRs(owner, repoName, token);
            const changes = prs.map((pr) => prToChange(pr, repo.full_name));
            const nextIndex = state.repoIndex + 1;
            return {
                changes,
                hasMore: nextIndex < state.repos.length,
                nextState: nextIndex < state.repos.length
                    ? nextPhase(state, "issues", nextIndex)
                    : undefined,
            };
        }
        catch (e) {
            console.error(`[sync-github-repos] Error fetching PRs for ${repo.full_name}:`, e);
            const nextIndex = state.repoIndex + 1;
            return {
                changes: [],
                hasMore: nextIndex < state.repos.length,
                nextState: nextIndex < state.repos.length
                    ? nextPhase(state, "issues", nextIndex)
                    : undefined,
            };
        }
    }
    return { changes: [], hasMore: false, nextState: undefined };
}
