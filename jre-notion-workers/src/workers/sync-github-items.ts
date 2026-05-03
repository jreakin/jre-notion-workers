/**
 * sync-github-items: Syncs GitHub repos, issues, and PRs from one or more
 * sources (orgs and/or users) into the Notion GitHub Items database.
 * Creates new rows for items not yet tracked, updates existing rows when
 * GitHub data is newer, using GitHub URL as the idempotent unique key.
 */
import type { Client } from "@notionhq/client";
import {
  getGitHubItemsDatabaseId,
  getGitHubToken,
} from "../shared/notion-client.js";
import { classifyGitHubError, GitHubApiError } from "../shared/github-utils.js";
import { fetchWithGitHubRetry } from "../shared/github-retry.js";
import type {
  GitHubSource,
  SyncGitHubItemsInput,
  SyncGitHubItemsOutput,
  SyncResumeCursor,
  SyncInstrumentation,
} from "../shared/types.js";

const TAG = "[sync-github-items]";

/* ── GitHub API types ──────────────────────────────────────────── */

interface GitHubRepo {
  full_name: string;
  html_url: string;
  description: string | null;
  fork: boolean;
  archived: boolean;
  created_at: string;
  updated_at: string;
  owner: { login: string };
}

interface GitHubIssue {
  number: number;
  title: string;
  html_url: string;
  state: "open" | "closed";
  body: string | null;
  labels: Array<{ name: string }>;
  created_at: string;
  updated_at: string;
  pull_request?: unknown; // present → this is actually a PR
}

interface GitHubPullRequest {
  number: number;
  title: string;
  html_url: string;
  state: "open" | "closed";
  body: string | null;
  labels: Array<{ name: string }>;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
}

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

export function inferTypeFromUrl(
  url: string
): "Repo" | "Issue" | "PR" | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    // /{owner}/{repo}/issues/{number}
    if (parts.length >= 4 && parts[2] === "issues" && /^\d+$/.test(parts[3]!)) {
      return "Issue";
    }
    // /{owner}/{repo}/pull/{number}
    if (parts.length >= 4 && parts[2] === "pull" && /^\d+$/.test(parts[3]!)) {
      return "PR";
    }
    // /{owner}/{repo}  (exactly 2 segments)
    if (parts.length === 2) {
      return "Repo";
    }
    return null;
  } catch {
    return null;
  }
}

/* ── Helpers ───────────────────────────────────────────────────── */

function truncate(text: string | null | undefined, maxLen = 2000): string {
  if (!text) return "";
  return text.length > maxLen ? text.slice(0, maxLen - 3) + "..." : text;
}

function toDateStr(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Compares two ISO-8601 date/datetime strings by epoch.
 * Returns true when the GitHub timestamp is strictly newer than
 * the stored Notion value.  Handles mixed formats gracefully:
 *   - GitHub: "2026-03-10T15:00:00Z"
 *   - Notion: "2026-03-10" | "2026-03-10T15:00:00.000+00:00"
 */
function isNewer(ghUpdatedAt: string, existingUpdatedAt: string): boolean {
  if (!existingUpdatedAt) return true;
  const ghTime = new Date(ghUpdatedAt).getTime();
  const exTime = new Date(existingUpdatedAt).getTime();
  if (Number.isNaN(ghTime)) return false;
  if (Number.isNaN(exTime)) return true;
  return ghTime > exTime;
}

function mapLabels(
  labels: Array<{ name: string }>
): Array<{ name: string }> {
  return labels
    .filter((l) => VALID_LABELS.has(l.name.toLowerCase()))
    .map((l) => ({ name: l.name.toLowerCase() }));
}

function mapIssueStatus(state: "open" | "closed"): string {
  return state === "open" ? "Open" : "Closed";
}

function mapPRStatus(
  state: "open" | "closed",
  mergedAt: string | null
): string {
  if (mergedAt) return "Merged";
  return state === "open" ? "Open" : "Closed";
}

/* ── GitHub fetch functions ────────────────────────────────────── */

/**
 * Generic paginated GitHub GET. Returns all items across pages.
 */
async function paginatedGitHubGet<T>(
  baseUrl: string,
  token: string,
  apiCounter?: { count: number }
): Promise<T[]> {
  const items: T[] = [];
  let url: string | null = baseUrl.includes("?")
    ? `${baseUrl}&per_page=100`
    : `${baseUrl}?per_page=100`;

  while (url) {
    if (apiCounter) apiCounter.count++;
    const requestUrl = url;
    const res: Response = await fetchWithGitHubRetry(
      () =>
        fetch(requestUrl, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
          },
        }),
      { label: requestUrl }
    );

    if (!res.ok) {
      throw new GitHubApiError(classifyGitHubError(res, requestUrl));
    }

    const data = (await res.json()) as T[];
    items.push(...data);

    // Pagination via Link header
    const linkHeader = res.headers.get("link");
    url = null;
    if (linkHeader) {
      const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      if (nextMatch) url = nextMatch[1]!;
    }
  }

  return items;
}

async function fetchAllRepos(
  source: GitHubSource,
  token: string,
  apiCounter?: { count: number }
): Promise<GitHubRepo[]> {
  if (source.type === "org") {
    return paginatedGitHubGet<GitHubRepo>(
      `https://api.github.com/orgs/${source.name}/repos?type=all`,
      token,
      apiCounter
    );
  }

  // For user sources, use the authenticated /user/repos endpoint
  // so private repos are included. Then filter to only repos owned
  // by the specified user.
  const allUserRepos = await paginatedGitHubGet<GitHubRepo>(
    "https://api.github.com/user/repos?per_page=100",
    token,
    apiCounter
  );
  return allUserRepos.filter(
    (r) => r.owner.login.toLowerCase() === source.name.toLowerCase()
  );
}

async function fetchAllIssues(
  owner: string,
  repo: string,
  token: string,
  since?: string,
  apiCounter?: { count: number }
): Promise<GitHubIssue[]> {
  let url = `https://api.github.com/repos/${owner}/${repo}/issues?state=all`;
  if (since) {
    url += `&since=${since}`;
  }
  const items = await paginatedGitHubGet<GitHubIssue>(url, token, apiCounter);
  // The issues endpoint includes PRs; filter them out
  return items.filter((i) => !i.pull_request);
}

async function fetchAllPRs(
  owner: string,
  repo: string,
  token: string,
  since?: string,
  apiCounter?: { count: number }
): Promise<GitHubPullRequest[]> {
  if (!since) {
    // Full sync — fetch everything
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls?state=all`;
    return paginatedGitHubGet<GitHubPullRequest>(url, token, apiCounter);
  }

  // Incremental sync — sort by updated desc and stop when we pass the cutoff.
  // The PRs endpoint doesn't support `since`, so we paginate manually.
  const items: GitHubPullRequest[] = [];
  let url: string | null =
    `https://api.github.com/repos/${owner}/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100`;

  while (url) {
    if (apiCounter) apiCounter.count++;
    const requestUrl = url;
    const res: Response = await fetchWithGitHubRetry(
      () =>
        fetch(requestUrl, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
          },
        }),
      { label: requestUrl }
    );

    if (!res.ok) {
      throw new GitHubApiError(classifyGitHubError(res, requestUrl));
    }

    const data = (await res.json()) as GitHubPullRequest[];
    let reachedCutoff = false;
    for (const pr of data) {
      if (pr.updated_at < since) {
        reachedCutoff = true;
        break;
      }
      items.push(pr);
    }

    if (reachedCutoff) break;

    const linkHeader = res.headers.get("link");
    url = null;
    if (linkHeader) {
      const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      if (nextMatch) url = nextMatch[1]!;
    }
  }

  return items;
}

/* ── Notion helpers ────────────────────────────────────────────── */

interface ExistingRow {
  id: string;
  /** The GitHub URL key this row was loaded under (lowercased). */
  ghUrl: string;
  updatedAt: string; // YYYY-MM-DD or ""
  type: string;      // "Repo" | "Issue" | "PR" | ""
  /** Full repo name as stored in the `Repo` rich_text column ("Owner/Name"). */
  repoFullName: string;
  projectIds: string[];
  clientIds: string[];
}

/** Relations that an Issue/PR can inherit from its parent Repo row. */
interface InheritedRelations {
  projectIds: string[];
  clientIds: string[];
}

/**
 * Pre-load ALL rows from the GitHub Items database into a lookup map
 * keyed by normalised GitHub URL.
 */
async function preloadNotionRows(
  notion: Client,
  dbId: string
): Promise<Map<string, ExistingRow>> {
  const map = new Map<string, ExistingRow>();
  let hasMore = true;
  let startCursor: string | undefined;

  while (hasMore) {
    const response = await notion.databases.query({
      database_id: dbId,
      start_cursor: startCursor,
      page_size: 100,
    });

    for (const page of response.results) {
      const p = page as {
        id: string;
        properties?: Record<string, unknown>;
      };

      let ghUrl = "";
      const urlProp = p.properties?.["GitHub URL"];
      if (urlProp && typeof urlProp === "object" && "url" in urlProp) {
        ghUrl = ((urlProp as { url: string | null }).url ?? "").trim();
      }

      if (!ghUrl) continue;

      let updatedAt = "";
      const updProp = p.properties?.["Updated"];
      if (updProp && typeof updProp === "object" && "date" in updProp) {
        const dateObj = (updProp as { date: { start?: string } | null }).date;
        updatedAt = dateObj?.start ?? "";
      }

      let existingType = "";
      const typeProp = p.properties?.["Type"];
      if (typeProp && typeof typeProp === "object" && "select" in typeProp) {
        const sel = (typeProp as { select: { name?: string } | null }).select;
        existingType = sel?.name ?? "";
      }

      const projectIds = readRelationIds(p.properties, "Project");
      const clientIds = readRelationIds(p.properties, "Client");
      const repoFullName = readRichText(p.properties, "Repo");

      const key = ghUrl.toLowerCase();
      map.set(key, {
        id: p.id,
        ghUrl: key,
        updatedAt,
        type: existingType,
        repoFullName,
        projectIds,
        clientIds,
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
function readRelationIds(
  properties: Record<string, unknown> | undefined,
  propName: string
): string[] {
  const prop = properties?.[propName];
  if (!prop || typeof prop !== "object" || !("relation" in prop)) return [];
  const rel = (prop as { relation: Array<{ id: string }> | null }).relation;
  return (rel ?? []).map((r) => r.id);
}

/**
 * Extract concatenated plain_text from a Notion rich_text property.
 * Returns empty string when the property is missing or empty.
 */
function readRichText(
  properties: Record<string, unknown> | undefined,
  propName: string
): string {
  const prop = properties?.[propName];
  if (!prop || typeof prop !== "object" || !("rich_text" in prop)) return "";
  const arr = (prop as { rich_text: Array<{ plain_text?: string; text?: { content?: string } }> | null })
    .rich_text;
  if (!arr) return "";
  return arr
    .map((r) => r.plain_text ?? r.text?.content ?? "")
    .join("")
    .trim();
}

/**
 * Given a NEW issue/PR URL and a rename map, try to find the OLD-URL
 * equivalent and return the matching existing row.  Used to migrate rows
 * whose stored `GitHub URL` still points at the pre-rename name.
 */
function lookupByRenamedUrl(
  existingRows: Map<string, ExistingRow>,
  renameMap: Map<string, string>,
  newKeyLower: string
): ExistingRow | undefined {
  if (renameMap.size === 0) return undefined;
  const newRepoKey = parseRepoKeyFromUrl(newKeyLower);
  if (!newRepoKey) return undefined;
  for (const [oldKey, mappedNew] of renameMap) {
    if (mappedNew !== newRepoKey) continue;
    // Replace the new owner/repo segment with the old one in the URL.
    const oldUrl = newKeyLower.replace(`/${newRepoKey}/`, `/${oldKey}/`);
    const candidate = existingRows.get(oldUrl);
    if (candidate) return candidate;
    // Tail-of-path edge case: URLs like "github.com/owner/repo" have no trailing slash.
    const oldUrlBareTail = newKeyLower.replace(
      new RegExp(`/${newRepoKey}$`),
      `/${oldKey}`
    );
    const candidate2 = existingRows.get(oldUrlBareTail);
    if (candidate2) return candidate2;
  }
  return undefined;
}

/**
 * Parse a GitHub URL into its lowercased `owner/repo` key. Returns null
 * for non-repo URLs or unparseable input.
 */
function parseRepoKeyFromUrl(url: string): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith("github.com")) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    return `${parts[0]}/${parts[1]}`.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Builds a lookup from repo full_name (lowercase) → inherited relations.
 * Only includes Repo-type rows that have at least one relation set.
 */
function buildRelationInheritanceMap(
  existingRows: Map<string, ExistingRow>
): Map<string, InheritedRelations> {
  const map = new Map<string, InheritedRelations>();

  for (const [url, row] of existingRows) {
    if (row.type !== "Repo") continue;
    if (row.projectIds.length === 0 && row.clientIds.length === 0) continue;

    // Extract owner/repo from URL: https://github.com/Owner/Repo → owner/repo
    const match = url.match(/github\.com\/([^/]+\/[^/]+)/i);
    if (!match) continue;

    map.set(match[1]!.toLowerCase(), {
      projectIds: row.projectIds,
      clientIds: row.clientIds,
    });
  }

  return map;
}

/**
 * Build a fallback inheritance map keyed by lowercased GitHub owner.
 * Used when a Repo row has no relations of its own — we look at every
 * sibling repo under the same owner and adopt the relations only when
 * every linked sibling agrees on the same `Client` and `Project` ids.
 *
 * Two design rules:
 *   1. We only fall back when *all* linked siblings share the same
 *      relation set — mixed-client owners produce no fallback (silence
 *      is safer than mis-tagging).
 *   2. The fallback is owner-scoped, not global: GitHub usernames are
 *      unique, so the worst case is "this user owns repos for several
 *      clients" which the consensus rule already filters out.
 */
function buildOwnerFallbackInheritanceMap(
  existingRows: Map<string, ExistingRow>
): Map<string, InheritedRelations> {
  const byOwner = new Map<
    string,
    { projects: Set<string>; clients: Set<string>; linkedRepoCount: number }
  >();

  for (const [url, row] of existingRows) {
    if (row.type !== "Repo") continue;
    if (row.projectIds.length === 0 && row.clientIds.length === 0) continue;

    const match = url.match(/github\.com\/([^/]+)\/[^/]+/i);
    if (!match) continue;
    const owner = match[1]!.toLowerCase();

    let entry = byOwner.get(owner);
    if (!entry) {
      entry = { projects: new Set(), clients: new Set(), linkedRepoCount: 0 };
      byOwner.set(owner, entry);
    }
    entry.linkedRepoCount++;
    for (const id of row.projectIds) entry.projects.add(id);
    for (const id of row.clientIds) entry.clients.add(id);
  }

  const result = new Map<string, InheritedRelations>();
  for (const [owner, entry] of byOwner) {
    // Need at least 2 linked siblings to call something a "consensus".
    if (entry.linkedRepoCount < 2) continue;
    // All linked siblings must agree on a single client (and at most one project).
    if (entry.clients.size > 1) continue;
    if (entry.projects.size > 1) continue;
    result.set(owner, {
      projectIds: [...entry.projects],
      clientIds: [...entry.clients],
    });
  }
  return result;
}

/**
 * Resolve inherited relations for a repo, preferring the per-repo entry
 * and falling back to the owner-level consensus when none exists.
 */
function resolveInheritedRelations(
  repoFullName: string,
  perRepo: Map<string, InheritedRelations>,
  perOwner: Map<string, InheritedRelations>
): InheritedRelations | undefined {
  const key = repoFullName.toLowerCase();
  const direct = perRepo.get(key);
  if (direct) return direct;
  const owner = key.split("/")[0];
  if (!owner) return undefined;
  return perOwner.get(owner);
}

/* ── Notion property builders ──────────────────────────────────── */

function buildRepoProperties(repo: GitHubRepo): Record<string, unknown> {
  const props: Record<string, unknown> = {
    Title: { title: [{ text: { content: repo.full_name } }] },
    Type: { select: { name: "Repo" } },
    "GitHub URL": { url: repo.html_url },
    Repo: {
      rich_text: [{ text: { content: repo.full_name } }],
    },
    Description: {
      rich_text: [{ text: { content: truncate(repo.description) } }],
    },
    Created: { date: { start: toDateStr(repo.created_at) } },
    Updated: { date: { start: repo.updated_at } },
  };
  return props;
}

function buildIssueProperties(
  issue: GitHubIssue,
  repoFullName: string,
  relations?: InheritedRelations
): Record<string, unknown> {
  const labels = mapLabels(issue.labels);
  const props: Record<string, unknown> = {
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
  return props;
}

function buildPRProperties(
  pr: GitHubPullRequest,
  repoFullName: string,
  relations?: InheritedRelations
): Record<string, unknown> {
  const labels = mapLabels(pr.labels);
  const props: Record<string, unknown> = {
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
  return props;
}

/* ── Upsert logic ──────────────────────────────────────────────── */

type UpsertResult = "created" | "updated" | "skipped" | "remapped";

interface UpsertOptions {
  /**
   * Optional pre-resolved match (e.g. by full_name during a rename).
   * When provided, we update this row regardless of URL-key match —
   * but we re-key the map entry to the new URL so subsequent lookups
   * find it by the new URL.
   */
  existingMatch?: ExistingRow;
  /** New repoFullName to remember on the row after upsert. */
  repoFullName?: string;
}

async function upsertItem(
  notion: Client,
  dbId: string,
  existingRows: Map<string, ExistingRow>,
  githubUrl: string,
  githubUpdatedAt: string,
  expectedType: "Repo" | "Issue" | "PR",
  properties: Record<string, unknown>,
  dryRun: boolean,
  opts: UpsertOptions = {}
): Promise<UpsertResult> {
  const key = githubUrl.toLowerCase();
  const directMatch = existingRows.get(key);
  const existing = directMatch ?? opts.existingMatch;
  const isRemap = !directMatch && !!opts.existingMatch;

  if (!existing) {
    // Create new row
    if (!dryRun) {
      const created = await notion.pages.create({
        parent: { database_id: dbId },
        properties: properties as never,
      });
      existingRows.set(key, {
        id: (created as { id: string }).id,
        ghUrl: key,
        updatedAt: githubUpdatedAt,
        type: expectedType,
        repoFullName: opts.repoFullName ?? "",
        projectIds: [],
        clientIds: [],
      });
    }
    return "created";
  }

  // Check if GitHub data is newer OR if Type is wrong OR if the row has been
  // remapped (URL changed because the upstream repo was renamed).
  const typeMismatch = existing.type !== "" && existing.type !== expectedType;
  const shouldUpdate =
    isRemap || isNewer(githubUpdatedAt, existing.updatedAt) || typeMismatch;

  if (shouldUpdate) {
    if (!dryRun) {
      await notion.pages.update({
        page_id: existing.id,
        properties: properties as never,
      });
    }
    existing.updatedAt = githubUpdatedAt;
    existing.type = expectedType;
    if (opts.repoFullName) existing.repoFullName = opts.repoFullName;

    if (isRemap) {
      // Re-key the row under the new URL so subsequent lookups find it.
      existingRows.delete(existing.ghUrl);
      existing.ghUrl = key;
      existingRows.set(key, existing);
      return "remapped";
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

async function processInBatches<T>(
  items: T[],
  batchSize: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  for (let i = 0; i < items.length; i += batchSize) {
    await Promise.all(items.slice(i, i + batchSize).map(fn));
  }
}

/** Mutable write budget — shared across all repos in a single run. */
interface WriteBudget {
  remaining: number;
}

function createWriteBudget(maxWrites: number | undefined | null): WriteBudget {
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
function reserveBudget(budget: WriteBudget): boolean {
  if (budget.remaining <= 0) return false;
  budget.remaining--;
  return true;
}

/** Return a reserved budget unit when an upsert turns out to be a skip. */
function releaseBudget(budget: WriteBudget): void {
  budget.remaining++;
}

/* ── Source resolution ──────────────────────────────────────────── */

function resolveSources(input: SyncGitHubItemsInput): GitHubSource[] {
  if (input.sources && input.sources.length > 0) {
    return input.sources;
  }
  if (input.org_name?.trim()) {
    return [{ name: input.org_name.trim(), type: "org" }];
  }
  return [];
}

/* ── Main execution ────────────────────────────────────────────── */

export async function executeSyncGitHubItems(
  input: SyncGitHubItemsInput,
  notion: Client
): Promise<SyncGitHubItemsOutput> {
  const sources = resolveSources(input);
  if (sources.length === 0) {
    return {
      success: false,
      error:
        "At least one source is required (provide `sources` array or legacy `org_name`).",
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
  const startMs = Date.now();
  const maxMs = (input.max_seconds ?? 50) * 1000;
  const isTimeUp = (): boolean => Date.now() - startMs >= maxMs;
  const maxReposPerRun = input.max_repos_per_run ?? Infinity;
  const maxItemsPerRun = input.max_items_per_run ?? Infinity;
  let totalItemsScanned = 0;
  let apiCallCount = 0;

  try {
    const token = getGitHubToken();
    const dbId = getGitHubItemsDatabaseId();

    const apiCounter = { count: 0 };

    // ── 1. Fetch repos from all sources ──
    const allRepos: GitHubRepo[] = [];
    const sourceNames = sources.map((s) => `${s.name} (${s.type})`);

    for (const source of sources) {
      console.log(TAG, `Fetching repos for ${source.type} "${source.name}"...`);
      const repos = await fetchAllRepos(source, token, apiCounter);
      console.log(TAG, `  → ${repos.length} repos from ${source.name}`);
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

    console.log(
      TAG,
      `${filteredRepos.length} repos after filtering (forks=${includeForks}, archived=${includeArchived})`
    );

    // ── 3. Pre-load existing Notion rows ──
    console.log(TAG, "Pre-loading existing Notion rows...");
    const existingRows = await preloadNotionRows(notion, dbId);
    console.log(TAG, `  → ${existingRows.size} existing rows loaded`);

    // ── 4. Build relation inheritance map ──
    const inheritanceMap = buildRelationInheritanceMap(existingRows);
    const ownerFallbackMap = buildOwnerFallbackInheritanceMap(existingRows);
    console.log(
      TAG,
      `  → ${inheritanceMap.size} repos with inheritable relations (${ownerFallbackMap.size} owner-level fallbacks)`
    );

    // Build a secondary lookup from `Owner/Name` (lowercase) → existing Repo
    // row so we can detect upstream repo renames (URL miss but full_name hit)
    // and remap issue/PR URLs that still reference the old name.
    const repoRowsByFullName = new Map<string, ExistingRow>();
    for (const row of existingRows.values()) {
      if (row.type !== "Repo") continue;
      const fromUrl = parseRepoKeyFromUrl(row.ghUrl);
      if (fromUrl) repoRowsByFullName.set(fromUrl, row);
      if (row.repoFullName) {
        repoRowsByFullName.set(row.repoFullName.toLowerCase(), row);
      }
    }

    /**
     * Maps lowercased OLD `owner/repo` → lowercased NEW `owner/repo` for
     * repos we discovered to have been renamed during this run.  Used to
     * remap issue/PR URLs that still point at the old name in Notion.
     */
    const repoRenameMap = new Map<string, string>();
    let repoRemapped = 0;

    // ── 5. Compute incremental-sync cutoff ──
    // Default to DEFAULT_UPDATED_SINCE_DAYS (180) when caller omits the param.
    // Pass updated_since_days=0 explicitly to force a full-history sync.
    const effectiveSinceDays =
      input.updated_since_days != null
        ? input.updated_since_days
        : DEFAULT_UPDATED_SINCE_DAYS;
    let sinceISO: string | undefined;
    if (effectiveSinceDays > 0) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - effectiveSinceDays);
      sinceISO = cutoff.toISOString();
      console.log(TAG, `Incremental sync: only items updated since ${sinceISO} (${effectiveSinceDays} days)`);
    } else {
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
    const errorDetails: string[] = [];
    let resumeCursor: SyncResumeCursor | null = null;
    let isComplete = true;
    let timeCutoffHit = false;
    let budgetExhausted = false;

    /** Check if we should stop early due to time, budget, or limits. */
    function shouldStop(): boolean {
      if (isTimeUp()) { timeCutoffHit = true; return true; }
      if (budget.remaining <= 0 && !dryRun) { budgetExhausted = true; return true; }
      if (reposProcessed >= maxReposPerRun) return true;
      if (totalItemsScanned >= maxItemsPerRun) return true;
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

      const repo = filteredRepos[repoIdx]!;
      const skipIssuesForResume = repoIdx === startRepoIndex && resumePhase === "prs";

      // 6a. Upsert repo row — detect rename if URL miss but full_name hit.
      const repoKey = repo.full_name.toLowerCase();
      const urlKey = repo.html_url.toLowerCase();
      let renameMatch: ExistingRow | undefined;
      if (!existingRows.has(urlKey)) {
        const candidate = repoRowsByFullName.get(repoKey);
        // Only treat as rename if the existing row's URL maps to a *different*
        // owner/repo than the GitHub response — otherwise it's just a row
        // that happened to be re-linked.
        if (candidate) {
          const candidateRepoKey = parseRepoKeyFromUrl(candidate.ghUrl);
          if (candidateRepoKey && candidateRepoKey !== repoKey) {
            renameMatch = candidate;
            repoRenameMap.set(candidateRepoKey, repoKey);
            console.log(
              TAG,
              `Detected rename: ${candidateRepoKey} → ${repoKey} (Notion row ${candidate.id})`
            );
          }
        }
      }

      if (!reserveBudget(budget)) { budgetSkipped++; }
      else {
        try {
          const props = buildRepoProperties(repo);
          const result = await upsertItem(
            notion,
            dbId,
            existingRows,
            repo.html_url,
            repo.updated_at,
            "Repo",
            props,
            dryRun,
            { existingMatch: renameMatch, repoFullName: repo.full_name }
          );
          if (result === "created") created++;
          else if (result === "updated") updated++;
          else if (result === "remapped") { updated++; repoRemapped++; }
          else { skipped++; releaseBudget(budget); }
        } catch (e) {
          releaseBudget(budget);
          errors++;
          const msg = e instanceof Error ? e.message : String(e);
          errorDetails.push(`Repo ${repo.full_name}: ${msg}`);
          console.error(TAG, `Error upserting repo ${repo.full_name}:`, msg);
        }
      }

      const [owner, repoName] = repo.full_name.split("/");
      if (!owner || !repoName) { reposProcessed++; continue; }

      // Resolve inherited relations for this repo's issues/PRs.  Falls back
      // to an owner-level consensus when no per-repo relation is set.
      const repoRelations = resolveInheritedRelations(
        repo.full_name,
        inheritanceMap,
        ownerFallbackMap
      );

      // Track unlinked repos (no Client relation directly OR via owner fallback)
      if (!repoRelations) {
        unlinkedRepos++;
      }

      // 6b. Sync issues (skip if resuming past issues phase)
      if (includeIssues && !skipIssuesForResume) {
        try {
          const allIssues = await fetchAllIssues(owner, repoName, token, sinceISO, apiCounter);
          const issues = openOnly ? allIssues.filter((i) => i.state === "open") : allIssues;
          issuesFound += issues.length;
          totalItemsScanned += issues.length;

          await processInBatches(issues, WRITE_CONCURRENCY, async (issue) => {
            if (!reserveBudget(budget)) { budgetSkipped++; return; }
            try {
              const directKey = issue.html_url.toLowerCase();
              const renameMatch = !existingRows.has(directKey)
                ? lookupByRenamedUrl(existingRows, repoRenameMap, directKey)
                : undefined;
              const isNew = !existingRows.has(directKey) && !renameMatch;
              const props = buildIssueProperties(
                issue,
                repo.full_name,
                isNew ? repoRelations : undefined
              );
              const result = await upsertItem(
                notion,
                dbId,
                existingRows,
                issue.html_url,
                issue.updated_at,
                "Issue",
                props,
                dryRun,
                { existingMatch: renameMatch, repoFullName: repo.full_name }
              );
              if (result === "created") created++;
              else if (result === "updated") updated++;
              else if (result === "remapped") { updated++; repoRemapped++; }
              else { skipped++; releaseBudget(budget); }
            } catch (e) {
              releaseBudget(budget);
              errors++;
              const msg = e instanceof Error ? e.message : String(e);
              errorDetails.push(
                `Issue ${repo.full_name}#${issue.number}: ${msg}`
              );
              console.error(
                TAG,
                `Error upserting issue ${repo.full_name}#${issue.number}:`,
                msg
              );
            }
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          errorDetails.push(`Issues fetch ${repo.full_name}: ${msg}`);
          console.error(
            TAG,
            `Error fetching issues for ${repo.full_name}:`,
            msg
          );
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
        try {
          const allPRs = await fetchAllPRs(owner, repoName, token, sinceISO, apiCounter);
          const prs = openOnly ? allPRs.filter((pr) => pr.state === "open") : allPRs;
          prsFound += prs.length;
          totalItemsScanned += prs.length;

          await processInBatches(prs, WRITE_CONCURRENCY, async (pr) => {
            if (!reserveBudget(budget)) { budgetSkipped++; return; }
            try {
              const directKey = pr.html_url.toLowerCase();
              const renameMatch = !existingRows.has(directKey)
                ? lookupByRenamedUrl(existingRows, repoRenameMap, directKey)
                : undefined;
              const isNew = !existingRows.has(directKey) && !renameMatch;
              const props = buildPRProperties(
                pr,
                repo.full_name,
                isNew ? repoRelations : undefined
              );
              const result = await upsertItem(
                notion,
                dbId,
                existingRows,
                pr.html_url,
                pr.updated_at,
                "PR",
                props,
                dryRun,
                { existingMatch: renameMatch, repoFullName: repo.full_name }
              );
              if (result === "created") created++;
              else if (result === "updated") updated++;
              else if (result === "remapped") { updated++; repoRemapped++; }
              else { skipped++; releaseBudget(budget); }
            } catch (e) {
              releaseBudget(budget);
              errors++;
              const msg = e instanceof Error ? e.message : String(e);
              errorDetails.push(
                `PR ${repo.full_name}#${pr.number}: ${msg}`
              );
              console.error(
                TAG,
                `Error upserting PR ${repo.full_name}#${pr.number}:`,
                msg
              );
            }
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          errorDetails.push(`PRs fetch ${repo.full_name}: ${msg}`);
          console.error(
            TAG,
            `Error fetching PRs for ${repo.full_name}:`,
            msg
          );
        }
      }

      reposProcessed++;
    }

    const elapsedMs = Date.now() - startMs;
    const modeLabel = dryRun ? "DRY RUN — " : "";
    const completionLabel = isComplete ? "" : "⚠️ Partial — ";
    const openOnlyNote = openOnly ? " (open only)" : "";
    const linkedNote =
      unlinkedRepos > 0 ? ` (${unlinkedRepos} repos unlinked to Client)` : "";
    const remapNote =
      repoRemapped > 0 ? ` (${repoRemapped} rows remapped after rename)` : "";
    const budgetNote =
      budgetSkipped > 0 ? ` Budget exhausted — ${budgetSkipped} items deferred.` : "";
    const resumeNote = resumeCursor
      ? ` Resume from repo ${resumeCursor.repo_index}/${filteredRepos.length} (${resumeCursor.phase}).`
      : "";
    const summary = `${completionLabel}${modeLabel}Synced [${sourceNames.join(", ")}]${openOnlyNote}: ${reposFound} repos (${reposProcessed} processed), ${issuesFound} issues, ${prsFound} PRs. ${created} created, ${updated} updated, ${skipped} skipped, ${errors} errors.${linkedNote}${remapNote}${budgetNote}${resumeNote} [${elapsedMs}ms]`;

    console.log(TAG, summary);

    const instrumentation: SyncInstrumentation = {
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
      remapped_rows: repoRemapped,
      skipped,
      errors,
      unlinked_repos: unlinkedRepos,
      error_details: errorDetails,
      summary,
      is_complete: isComplete,
      resume_cursor: resumeCursor,
      instrumentation,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(TAG, "error:", message);
    return { success: false, error: message };
  }
}
