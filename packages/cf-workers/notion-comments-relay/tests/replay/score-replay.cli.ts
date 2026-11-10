/**
 * Offline Clef replay CLI (local only; never deploys, never calls Cloudflare or Notion).
 *
 *   bun run replay -- --rows <masked.jsonl>         Mode A: re-decide exported rows (no AI)
 *   bun run replay -- --fixtures <dir-or-file.json> Mode B: masked fixtures through the real pipeline (stub AI)
 *   bun run replay -- --fixtures <dir> --live       Mode B with CLEF_SKIP_PAGE_CREATED_LIVE=1
 *
 * Output is labels, counts and opaque hashes only.
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { formatReport, parseReplayInput, replay } from "./replay-lib.js";
import { formatFixtureResult, runFixture, type ReplayFixture } from "./replay-pipeline.js";

function usage(): never {
  console.error(
    "usage: bun run replay -- --rows <file.jsonl> | --fixtures <dir|file.json> [--live] [--out-by-event-type <dir>]",
  );
  process.exit(2);
}

function parseArgv(argv: string[]): { rows?: string; fixtures?: string; live: boolean; outDir?: string } {
  const out: { rows?: string; fixtures?: string; live: boolean; outDir?: string } = { live: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--live") out.live = true;
    else if (a === "--rows") out.rows = argv[++i];
    else if (a === "--fixtures") out.fixtures = argv[++i];
    else if (a === "--out-by-event-type") out.outDir = argv[++i];
  }
  return out;
}

function replayEventTypeBuckets(rows: Record<string, unknown>[]): Record<string, unknown[]> {
  const buckets: Record<string, unknown[]> = {
    page_created: [],
    properties_updated: [],
    comments: [],
    other: [],
  };
  for (const row of rows) {
    const ev = String(row.event ?? "");
    if (ev === "page.created" || ev === "page.added" || ev === "page_created") buckets.page_created.push(row);
    else if (ev === "page.properties_updated") buckets.properties_updated.push(row);
    else if (ev.startsWith("comment.")) buckets.comments.push(row);
    else buckets.other.push(row);
  }
  return buckets;
}

function writeEventTypeOutput(outDir: string, rows: Record<string, unknown>[]): void {
  mkdirSync(outDir, { recursive: true });
  const buckets = replayEventTypeBuckets(rows);
  for (const [name, list] of Object.entries(buckets)) {
    if (list.length === 0) continue;
    const path = `${outDir}/${name}.jsonl`;
    for (const row of list) appendFileSync(path, `${JSON.stringify(row)}\n`, "utf8");
  }
}

function fixtureFiles(path: string): string[] {
  if (statSync(path).isDirectory()) {
    return readdirSync(path)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => join(path, f));
  }
  return [path];
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgv(argv);
  if (args.rows) {
    const parsed = parseReplayInput(readFileSync(args.rows, "utf8"));
    if (args.outDir) writeEventTypeOutput(args.outDir, parsed.rows as Record<string, unknown>[]);
    console.log(formatReport(replay(parsed.rows), parsed));
    return;
  }
  if (args.fixtures) {
    for (const file of fixtureFiles(args.fixtures)) {
      const fixture = JSON.parse(readFileSync(file, "utf8")) as ReplayFixture;
      const result = await runFixture(fixture, args.live ? { CLEF_SKIP_PAGE_CREATED_LIVE: "1" } : {});
      if (args.outDir && result.rows?.length) writeEventTypeOutput(args.outDir, result.rows);
      console.log(formatFixtureResult(result));
    }
    return;
  }
  usage();
}

await main(process.argv.slice(2));
