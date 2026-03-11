/**
 * sync-time-log: Scans GitHub Items for recent PRs/issues, calls estimation
 * logic, and creates/updates Time Log entries with hour estimates.
 *
 * Replaces the agent-side "Step 0" logic that burned tokens on repetitive
 * Notion queries.  One worker call covers all items in the lookback window.
 */
import type { Client } from "@notionhq/client";
import { executeEstimateGitHubHours } from "./estimate-github-hours.js";
import {
  getGitHubItemsDatabaseId,
  getTimeLogDatabaseId,
} from "../shared/notion-client.js";
import type {
  SyncTimeLogInput,
  SyncTimeLogOutput,
  TimeLogEntryResult,
} from "../shared/types.js";

const TAG = "[sync-time-log]";

/* ── Types ────────────────────────────────────────────────────────────── */

export interface GitHubItemRow {
  id: string;
  title: string;
  type: "Issue" | "PR";
  status: string;
  githubUrl: string;
  repo: string;
  createdDate: string;
  updatedDate: string;
  labels: string[];
  clientIds: string[];
  projectIds: string[];
  taskIds: string[];
}

export interface ExistingTimeLogEntry {
  id: string;
  description: string;
  githubItemIds: string[];
}

/* ── Helpers ──────────────────────────────────────────────────────────── */

/**
 * Parse a GitHub URL into owner/repo/number.
 * Returns null for repo-level URLs (no number).
 */
export function parseGitHubUrl(
  url: string
): { owner: string; repo: string; number: number; type: "pr" | "issue" } | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    // e.g. /Abstract-Data/my-app/issues/42  or  /Abstract-Data/my-app/pull/10
    if (parts.length < 4) return null;
    const owner = parts[0]!;
    const repo = parts[1]!;
    const kind = parts[2]!;
    const num = parseInt(parts[3]!, 10);
    if (isNaN(num)) return null;
    if (kind === "issues") return { owner, repo, number: num, type: "issue" };
    if (kind === "pull") return { owner, repo, number: num, type: "pr" };
    return null;
  } catch {
    return null;
  }
}

/** Read an array of page IDs from a Notion relation property. */
export function readRelationIds(
  properties: Record<string, unknown> | undefined,
  propName: string
): string[] {
  const prop = properties?.[propName];
  if (!prop || typeof prop !== "object" || !("relation" in prop)) return [];
  const rel = (prop as { relation: Array<{ id: string }> | null }).relation;
  return (rel ?? []).map((r) => r.id);
}

/** Read a plain-text title property. */
export function readTitle(properties: Record<string, unknown> | undefined): string {
  const t = properties?.["Title"] ?? properties?.["Description"];
  if (!t || typeof t !== "object" || !("title" in t)) return "";
  const arr = (t as { title: Array<{ plain_text: string }> }).title;
  return arr?.map((seg) => seg.plain_text).join("") ?? "";
}

/** Read a select property value. */
export function readSelect(
  properties: Record<string, unknown> | undefined,
  propName: string
): string {
  const p = properties?.[propName];
  if (!p || typeof p !== "object" || !("select" in p)) return "";
  const sel = (p as { select: { name: string } | null }).select;
  return sel?.name ?? "";
}

/** Read a multi-select property as string array. */
export function readMultiSelect(
  properties: Record<string, unknown> | undefined,
  propName: string
): string[] {
  const p = properties?.[propName];
  if (!p || typeof p !== "object" || !("multi_select" in p)) return [];
  const arr = (p as { multi_select: Array<{ name: string }> }).multi_select;
  return arr?.map((o) => o.name.toLowerCase()) ?? [];
}

/** Read a URL property. */
export function readUrl(
  properties: Record<string, unknown> | undefined,
  propName: string
): string {
  const p = properties?.[propName];
  if (!p || typeof p !== "object" || !("url" in p)) return "";
  return ((p as { url: string | null }).url) ?? "";
}

/** Read a rich-text property as plain text. */
export function readRichText(
  properties: Record<string, unknown> | undefined,
  propName: string
): string {
  const p = properties?.[propName];
  if (!p || typeof p !== "object" || !("rich_text" in p)) return "";
  const arr = (p as { rich_text: Array<{ plain_text: string }> }).rich_text;
  return arr?.map((seg) => seg.plain_text).join("") ?? "";
}

/** Read a date property start value. */
export function readDateStart(
  properties: Record<string, unknown> | undefined,
  propName: string
): string {
  const p = properties?.[propName];
  if (!p || typeof p !== "object" || !("date" in p)) return "";
  const d = (p as { date: { start: string } | null }).date;
  return d?.start ?? "";
}

/** Determine the description prefix based on item type, status, and confidence. */
export function descriptionPrefix(
  itemType: "Issue" | "PR",
  status: string,
  confidence: "low" | "medium" | "high" | null,
  isFallback: boolean
): string {
  if (isFallback) return "[EST-FALLBACK]";
  if (itemType === "PR" && status === "Merged") return "[EST-FINAL]";
  if (confidence === "low") return "[EST-LOW]";
  return "[EST]";
}

/** Build the Time Log description line. */
export function buildDescription(
  prefix: string,
  itemType: "Issue" | "PR",
  title: string,
  githubUrl: string,
  repo: string
): string {
  const parsed = parseGitHubUrl(githubUrl);
  const numberStr = parsed ? `#${parsed.number}` : "";
  const shortTitle = title.length > 80 ? title.slice(0, 77) + "..." : title;
  return `${prefix} ${itemType}: ${shortTitle} (${numberStr}) \u2014 ${repo}`;
}

/** Fallback hour estimate when the GitHub API estimator fails. */
export function fallbackEstimate(labels: string[]): number {
  if (labels.includes("documentation")) return 0.5;
  if (labels.includes("bug")) return 2;
  if (labels.includes("feature") || labels.includes("enhancement")) return 5;
  return 2;
}

/* ── Query helpers ────────────────────────────────────────────────────── */

/** Load GitHub Items (Issues + PRs) created or updated within lookback window. */
async function loadGitHubItems(
  notion: Client,
  lookbackDays: number,
  itemTypes: ("Issue" | "PR")[],
  repoFilter: string[]
): Promise<GitHubItemRow[]> {
  const dbId = getGitHubItemsDatabaseId();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - lookbackDays);
  const cutoffIso = cutoff.toISOString().split("T")[0]!;

  // Build type filter: Issue and/or PR (never Repo)
  const typeFilters = itemTypes.map((t) => ({
    property: "Type",
    select: { equals: t },
  }));

  const filter: Record<string, unknown> = {
    and: [
      // Type filter
      typeFilters.length === 1
        ? typeFilters[0]
        : { or: typeFilters },
      // Created or updated within window
      {
        or: [
          { property: "Created", date: { on_or_after: cutoffIso } },
          { property: "Updated", date: { on_or_after: cutoffIso } },
        ],
      },
    ],
  };

  const rows: GitHubItemRow[] = [];
  let cursor: string | undefined;

  do {
    const resp = await notion.databases.query({
      database_id: dbId,
      filter: filter as never,
      start_cursor: cursor,
      page_size: 100,
    });

    for (const page of resp.results) {
      if (!("properties" in page)) continue;
      const props = page.properties as Record<string, unknown>;

      const title = readTitle(props);
      const type = readSelect(props, "Type") as "Issue" | "PR";
      const status = readSelect(props, "Status");
      const githubUrl = readUrl(props, "GitHub URL");
      const repo = readRichText(props, "Repo");
      const labels = readMultiSelect(props, "Labels");
      const createdDate = readDateStart(props, "Created");
      const updatedDate = readDateStart(props, "Updated");
      const clientIds = readRelationIds(props, "Client");
      const projectIds = readRelationIds(props, "Project");
      const taskIds = readRelationIds(props, "Task");

      // Apply repo filter if set
      if (repoFilter.length > 0) {
        const repoLower = repo.toLowerCase();
        if (!repoFilter.some((r) => repoLower === r.toLowerCase())) continue;
      }

      if (!type || (type !== "Issue" && type !== "PR")) continue;

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
      });
    }

    cursor = resp.has_more ? resp.next_cursor ?? undefined : undefined;
  } while (cursor);

  return rows;
}

/** Load existing Time Log entries that have GitHub Item relations set. */
export async function loadExistingTimeLogEntries(
  notion: Client
): Promise<Map<string, ExistingTimeLogEntry>> {
  const dbId = getTimeLogDatabaseId();

  // Query for entries that have a GitHub Item relation
  const filter = {
    property: "GitHub Item",
    relation: { is_not_empty: true as const },
  };

  // Map: github_item_page_id → time log entry
  const map = new Map<string, ExistingTimeLogEntry>();
  let cursor: string | undefined;

  do {
    const resp = await notion.databases.query({
      database_id: dbId,
      filter: filter as never,
      start_cursor: cursor,
      page_size: 100,
    });

    for (const page of resp.results) {
      if (!("properties" in page)) continue;
      const props = page.properties as Record<string, unknown>;

      const description = readTitle(props);
      const githubItemIds = readRelationIds(props, "GitHub Item");

      const entry: ExistingTimeLogEntry = {
        id: page.id,
        description,
        githubItemIds,
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

export async function executeSyncTimeLog(
  input: SyncTimeLogInput,
  notion: Client
): Promise<SyncTimeLogOutput> {
  try {
    const lookbackDays = input.lookback_days ?? 7;
    const itemTypes = input.item_types ?? ["Issue", "PR"];
    const repoFilter = input.repo_filter ?? [];
    const dryRun = input.dry_run ?? false;

    // 1. Load GitHub Items
    console.log(TAG, `Loading GitHub Items (lookback: ${lookbackDays}d)...`);
    const ghItems = await loadGitHubItems(notion, lookbackDays, itemTypes, repoFilter);
    console.log(TAG, `  \u2192 ${ghItems.length} items found`);

    // 2. Load existing Time Log entries
    console.log(TAG, "Loading existing Time Log entries...");
    const existingEntries = await loadExistingTimeLogEntries(notion);
    console.log(TAG, `  \u2192 ${existingEntries.size} existing entries`);

    // 3. Process each item
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;
    let totalHours = 0;
    const errorDetails: string[] = [];
    const entries: TimeLogEntryResult[] = [];

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
              } as never,
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
        const result = await estimateItem(item);
        const prefix = descriptionPrefix(item.type, item.status, result.confidence, result.isFallback);
        const desc = buildDescription(prefix, item.type, item.title, item.githubUrl, item.repo);

        if (!dryRun) {
          const properties: Record<string, unknown> = {
            Description: { title: [{ text: { content: desc } }] },
            Hours: { number: result.hours },
            Date: { date: { start: item.createdDate || new Date().toISOString().split("T")[0] } },
            "GitHub Item": { relation: [{ id: item.id }] },
            Billable: { checkbox: false },
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
            properties: properties as never,
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
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errorDetails.push(`${item.type} "${item.title}": ${msg}`);
        errors++;
        console.error(TAG, `Error processing ${item.type} "${item.title}":`, msg);
      }
    }

    const prefix = dryRun ? "DRY RUN \u2014 " : "";
    const summary = `${prefix}Synced Time Log: ${ghItems.length} items scanned. ${created} created, ${updated} updated, ${skipped} skipped, ${errors} errors. Total estimated: ${totalHours}h.`;
    console.log(TAG, summary);

    return {
      success: true,
      items_scanned: ghItems.length,
      created,
      updated,
      skipped,
      errors,
      total_estimated_hours: totalHours,
      error_details: errorDetails,
      entries,
      summary,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(TAG, "error:", message);
    return { success: false, error: message };
  }
}

/* ── Estimation wrapper ───────────────────────────────────────────────── */

export interface EstimationResult {
  hours: number;
  confidence: "low" | "medium" | "high";
  isFallback: boolean;
}

export async function estimateItem(item: GitHubItemRow): Promise<EstimationResult> {
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
