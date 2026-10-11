#!/usr/bin/env bun
/**
 * PR Estimate Writer CLI — dry-run by default.
 *
 * Usage:
 *   bun run scripts/pr-estimate-writer.ts [--dry-run] [--live] [--backfill] \
 *     --client "Quorum Report" --repos jreakin/v0-quorum-report-redesign-concep jreakin/qr-podcast-site-gv
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import { getNotionClient } from "../src/shared/notion-client.js";
import { executePrEstimateWriter } from "../src/workers/pr-estimate-writer.js";
import type { PrEstimateWriterInput, PrEstimateWriterOutput } from "../src/shared/types.js";

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

export interface CliOptions {
  dryRun: boolean;
  live: boolean;
  backfill: boolean;
  client: string | null;
  repos: string[];
}

export function parseCliArgs(argv: string[] = process.argv): CliOptions {
  const opts: CliOptions = {
    dryRun: true,
    live: false,
    backfill: false,
    client: null,
    repos: [],
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--live") {
      opts.live = true;
      opts.dryRun = false;
    } else if (arg === "--backfill") opts.backfill = true;
    else if (arg === "--client" && i + 1 < argv.length) opts.client = argv[++i]!;
    else if (arg === "--repos") {
      while (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) {
        opts.repos.push(argv[++i]!);
      }
    } else if (arg === "--help" || arg === "-h") {
      console.log(`PR Estimate Writer CLI\n  --dry-run (default)\n  --live\n  --backfill\n  --client <name>\n  --repos <owner/repo> ...`);
      process.exit(0);
    }
  }

  return opts;
}

function missingCreds(): string[] {
  const missing: string[] = [];
  if (!process.env.NTN_API_TOKEN) missing.push("NTN_API_TOKEN");
  if (!process.env.GITHUB_TOKEN) missing.push("GITHUB_TOKEN");
  if (!process.env.GITHUB_ITEMS_DATABASE_ID) missing.push("GITHUB_ITEMS_DATABASE_ID");
  if (!process.env.TIME_LOG_DATABASE_ID) missing.push("TIME_LOG_DATABASE_ID");
  return missing;
}

function writeArtifacts(result: PrEstimateWriterOutput, client: string | null) {
  const artifactsDir = resolve(import.meta.dir, "../../artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  const slug = (client ?? "all").toLowerCase().replace(/\s+/g, "-");
  const mdPath = resolve(artifactsDir, `pr-estimate-writer-dry-run-${slug}.md`);
  const csvPath = resolve(artifactsDir, `pr-estimate-writer-dry-run-${slug}.csv`);

  if (!result.success) {
    writeFileSync(mdPath, `# PR Estimate Writer dry-run\n\nFailed: ${result.error}\n`);
    return;
  }

  const lines = [
    "# PR Estimate Writer dry-run",
    "",
    `- **Summary:** ${result.summary}`,
    `- **Items scanned:** ${result.items_scanned}`,
    `- **Created:** ${result.created}`,
    `- **Updated:** ${result.updated}`,
    `- **Skipped:** ${result.skipped}`,
    `- **Errors:** ${result.errors}`,
    `- **Total hours:** ${result.total_hours}`,
    "",
    "## By project/repo",
    "",
  ];

  const byRepo = new Map<string, { count: number; hours: number }>();
  for (const row of result.rows) {
    const repo = row.github_url.match(/github\.com\/([^/]+\/[^/]+)/)?.[1] ?? "unknown";
    const cur = byRepo.get(repo) ?? { count: 0, hours: 0 };
    cur.count += row.action === "created" || row.action === "updated" ? 1 : 0;
    cur.hours += row.hours ?? 0;
    byRepo.set(repo, cur);
  }
  for (const [repo, stats] of byRepo) {
    lines.push(`- ${repo}: ${stats.count} rows, ${stats.hours}h`);
  }

  writeFileSync(mdPath, lines.join("\n") + "\n");

  const csvHeader = "github_url,action,hours,weighted_lines,over_cap,reason\n";
  const csvRows = result.rows
    .map((r) =>
      [
        JSON.stringify(r.github_url),
        r.action,
        r.hours ?? "",
        r.weighted_lines ?? "",
        r.over_cap,
        JSON.stringify(r.reason ?? ""),
      ].join(",")
    )
    .join("\n");
  writeFileSync(csvPath, csvHeader + csvRows + "\n");
  console.log(`Wrote ${mdPath}`);
  console.log(`Wrote ${csvPath}`);
}

async function main() {
  const opts = parseCliArgs();
  const missing = missingCreds();

  if (missing.length > 0) {
    const msg = `Missing credentials: ${missing.join(", ")}. Cannot run live/dry-run against Notion/GitHub.`;
    console.error(msg);
    const artifactsDir = resolve(import.meta.dir, "../../artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    const slug = (opts.client ?? "quorum").toLowerCase().replace(/\s+/g, "-");
    writeFileSync(
      resolve(artifactsDir, `pr-estimate-writer-dry-run-${slug}.md`),
      `# PR Estimate Writer dry-run\n\n${msg}\n`
    );
    process.exit(1);
  }

  if (opts.live && process.env.PR_ESTIMATE_WRITER_LIVE !== "1") {
    console.error("Live writes require PR_ESTIMATE_WRITER_LIVE=1 in addition to --live");
    process.exit(1);
  }

  const defaultQuorumRepos = [
    "jreakin/v0-quorum-report-redesign-concep",
    "jreakin/qr-podcast-site-gv",
  ];

  const input: PrEstimateWriterInput = {
    dry_run: opts.dryRun,
    backfill: opts.backfill,
    client_filter: opts.client ?? (opts.backfill ? "Quorum Report" : undefined),
    repo_filter:
      opts.repos.length > 0
        ? opts.repos
        : opts.backfill
          ? defaultQuorumRepos
          : undefined,
  };

  console.log("PR Estimate Writer CLI", {
    dry_run: input.dry_run,
    live: opts.live,
    backfill: opts.backfill,
    repos: input.repo_filter,
    client: input.client_filter,
  });

  const notion = getNotionClient();
  const result = await executePrEstimateWriter(input, notion);
  console.log(result.success ? result.summary : result.error);

  if (opts.dryRun || !opts.live) {
    writeArtifacts(result, input.client_filter ?? null);
  }

  process.exit(result.success ? 0 : 1);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
