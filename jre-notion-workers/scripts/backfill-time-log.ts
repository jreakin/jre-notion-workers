#!/usr/bin/env bun
/**
 * backfill-time-log: One-time script to create Time Log entries for ALL
 * GitHub Items (Issues + PRs) that don't already have one.
 *
 * Usage:
 *   bun run --env-file=.env.local scripts/backfill-time-log.ts [options]
 *
 * Options:
 *   --dry-run          Log what would be created, but don't write to Notion
 *   --repo <name>      Only process items from specific repo(s) (repeatable)
 *   --type <Issue|PR>  Only process specific types (repeatable, default: both)
 *   --limit <n>        Max items to process (useful for testing)
 *   --verbose          Show estimation details for each item
 */
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

/* ── Load .env.local if present (same pattern as test-connection.ts) ─── */
function loadEnvLocal() {
  const root = resolve(import.meta.dir, "..");
  const path = resolve(root, ".env.local");
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "").trim();
  }
}
loadEnvLocal();

import type { Client } from "@notionhq/client";
import { getNotionClient, getGitHubItemsDatabaseId, getTimeLogDatabaseId } from "../src/shared/notion-client.js";
import {
  type GitHubItemRow,
  type EstimationResult,
  readTitle,
  readSelect,
  readMultiSelect,
  readUrl,
  readRichText,
  readDateStart,
  readRelationIds,
  descriptionPrefix,
  buildDescription,
  estimateItem,
  loadExistingTimeLogEntries,
} from "../src/workers/sync-time-log.js";

const TAG = "[backfill]";
const NOTION_DELAY_MS = 350;
const GITHUB_DELAY_MS = 750;

/* ── CLI argument parsing ─────────────────────────────────────────────── */

interface BackfillOptions {
  dryRun: boolean;
  repoFilter: string[];
  itemTypes: ("Issue" | "PR")[];
  limit: number;
  verbose: boolean;
}

export function parseArgs(argv: string[] = process.argv): BackfillOptions {
  const opts: BackfillOptions = {
    dryRun: false,
    repoFilter: [],
    itemTypes: ["Issue", "PR"],
    limit: 0,
    verbose: false,
  };

  // Track whether --type was explicitly provided
  let typeExplicit = false;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--verbose") {
      opts.verbose = true;
    } else if (arg === "--repo" && i + 1 < argv.length) {
      opts.repoFilter.push(argv[++i]!);
    } else if (arg === "--type" && i + 1 < argv.length) {
      const t = argv[++i]!;
      if (t !== "Issue" && t !== "PR") {
        console.error(`Invalid --type value: "${t}". Must be "Issue" or "PR".`);
        process.exit(1);
      }
      if (!typeExplicit) {
        opts.itemTypes = [];
        typeExplicit = true;
      }
      if (!opts.itemTypes.includes(t)) opts.itemTypes.push(t);
    } else if (arg === "--limit" && i + 1 < argv.length) {
      opts.limit = parseInt(argv[++i]!, 10);
      if (isNaN(opts.limit) || opts.limit < 1) {
        console.error(`Invalid --limit value. Must be a positive integer.`);
        process.exit(1);
      }
    } else if (arg.startsWith("--")) {
      console.error(`Unknown option: ${arg}`);
      process.exit(1);
    }
  }

  return opts;
}

/* ── Load ALL GitHub Items (no date filter) ────────────────────────────── */

export async function loadAllGitHubItems(
  notion: Client,
  itemTypes: ("Issue" | "PR")[],
  repoFilter: string[]
): Promise<GitHubItemRow[]> {
  const dbId = getGitHubItemsDatabaseId();

  // Build type filter: Issue and/or PR (never Repo)
  const typeFilters = itemTypes.map((t) => ({
    property: "Type",
    select: { equals: t },
  }));

  const filter: Record<string, unknown> =
    typeFilters.length === 1
      ? typeFilters[0]!
      : { or: typeFilters };

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

/* ── Rate-limited sleep ───────────────────────────────────────────────── */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ── Main ─────────────────────────────────────────────────────────────── */

export async function runBackfill(
  opts: BackfillOptions,
  notion: Client
): Promise<{
  totalItems: number;
  alreadyCovered: number;
  processed: number;
  created: number;
  errors: number;
  fallbacks: number;
  totalHours: number;
  errorDetails: string[];
}> {
  console.log(TAG, "Starting Time Log backfill...");
  console.log(
    TAG,
    `Options: dry_run=${opts.dryRun}, repos=${opts.repoFilter.join(",") || "all"}, types=${opts.itemTypes.join(",")}, limit=${opts.limit || "none"}, verbose=${opts.verbose}`
  );

  // Phase 1: Load existing Time Log entries (for dedup)
  console.log(TAG, "Loading existing Time Log entries...");
  const existingMap = await loadExistingTimeLogEntries(notion);
  const existingIds = new Set(existingMap.keys());
  console.log(TAG, `  → ${existingIds.size} existing entries with GitHub Item links`);

  // Phase 2: Load ALL GitHub Items (no date filter)
  console.log(TAG, "Loading all GitHub Items...");
  const allItems = await loadAllGitHubItems(notion, opts.itemTypes, opts.repoFilter);
  console.log(TAG, `  → ${allItems.length} GitHub Items found`);

  // Phase 3: Compute work queue
  const toProcess = allItems.filter((item) => !existingIds.has(item.id));
  const limited = opts.limit > 0 ? toProcess.slice(0, opts.limit) : toProcess;
  console.log(
    TAG,
    `${toProcess.length} items need backfill (${allItems.length - toProcess.length} already have entries)`
  );
  if (opts.limit > 0 && toProcess.length > opts.limit) {
    console.log(TAG, `Processing limited to ${opts.limit} items`);
  }

  // Phase 4: Process items
  let created = 0;
  let errors = 0;
  let fallbacks = 0;
  let totalHours = 0;
  const errorDetails: string[] = [];
  const timeLogDbId = getTimeLogDatabaseId();

  for (let i = 0; i < limited.length; i++) {
    const item = limited[i]!;
    try {
      // Estimate hours via GitHub API
      const estimation: EstimationResult = await estimateItem(item);
      await sleep(GITHUB_DELAY_MS);

      const prefix = descriptionPrefix(
        item.type,
        item.status,
        estimation.confidence,
        estimation.isFallback
      );
      const desc = buildDescription(
        prefix,
        item.type,
        item.title,
        item.githubUrl,
        item.repo
      );

      if (estimation.isFallback) fallbacks++;

      if (!opts.dryRun) {
        const properties: Record<string, unknown> = {
          Description: { title: [{ text: { content: desc } }] },
          Hours: { number: estimation.hours },
          Date: {
            date: {
              start:
                item.createdDate ||
                new Date().toISOString().split("T")[0],
            },
          },
          "GitHub Item": { relation: [{ id: item.id }] },
          Billable: { checkbox: false },
        };

        // Copy relations from GitHub Item
        if (item.clientIds.length) {
          properties.Client = {
            relation: item.clientIds.map((id) => ({ id })),
          };
        }
        if (item.projectIds.length) {
          properties.Project = {
            relation: item.projectIds.map((id) => ({ id })),
          };
        }
        if (item.taskIds.length) {
          properties.Task = {
            relation: item.taskIds.map((id) => ({ id })),
          };
        }

        await notion.pages.create({
          parent: { database_id: timeLogDbId },
          properties: properties as never,
        });
        await sleep(NOTION_DELAY_MS);
      }

      totalHours += estimation.hours;
      created++;

      if (opts.verbose) {
        console.log(
          TAG,
          `  ${opts.dryRun ? "[DRY] " : "✓ "}${desc} (${estimation.hours}h, ${estimation.confidence})`
        );
      }

      // Progress every 10 items
      if ((i + 1) % 10 === 0 || i === limited.length - 1) {
        console.log(
          TAG,
          `Progress: ${i + 1}/${limited.length} (${created} created, ${errors} errors, ${totalHours.toFixed(1)}h total)`
        );
      }
    } catch (e) {
      errors++;
      const msg = e instanceof Error ? e.message : String(e);
      errorDetails.push(`${item.type} "${item.title}": ${msg}`);
      console.error(TAG, `Error: ${item.type} "${item.title}": ${msg}`);

      // Abort on rate limit
      if (msg.includes("rate limit")) {
        console.error(
          TAG,
          `GitHub rate limit hit after ${i + 1} items. Re-run later to continue (${limited.length - i - 1} items remaining).`
        );
        break;
      }
    }
  }

  return {
    totalItems: allItems.length,
    alreadyCovered: allItems.length - toProcess.length,
    processed: limited.length,
    created,
    errors,
    fallbacks,
    totalHours,
    errorDetails,
  };
}

/* ── Entry point ──────────────────────────────────────────────────────── */

async function main() {
  const opts = parseArgs();
  const notion = getNotionClient();

  const result = await runBackfill(opts, notion);

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log(`${TAG} ${opts.dryRun ? "DRY RUN " : ""}COMPLETE`);
  console.log(`  Total GitHub Items:  ${result.totalItems}`);
  console.log(`  Already in Time Log: ${result.alreadyCovered}`);
  console.log(`  Processed:           ${result.processed}`);
  console.log(`  Created:             ${result.created}`);
  console.log(`  Errors:              ${result.errors}`);
  console.log(`  Fallback estimates:  ${result.fallbacks}`);
  console.log(`  Total hours:         ${result.totalHours.toFixed(1)}h`);
  if (result.errorDetails.length > 0) {
    console.log(`\n  Error details:`);
    for (const e of result.errorDetails) {
      console.log(`    - ${e}`);
    }
  }
  console.log("=".repeat(60));
}

// Only run when executed directly (not imported as a module in tests)
if (import.meta.main) {
  main().catch((err) => {
    console.error(`${TAG} Fatal error:`, err.message);
    process.exit(1);
  });
}
