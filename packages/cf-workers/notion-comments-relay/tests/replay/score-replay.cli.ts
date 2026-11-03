/**
 * Offline Clef replay CLI (local only; never deploys, never calls Cloudflare or Notion).
 *
 *   bun run replay -- --rows <masked.jsonl>         Mode A: re-decide exported rows (no AI)
 *   bun run replay -- --fixtures <dir-or-file.json> Mode B: masked fixtures through the real pipeline (stub AI)
 *
 * Output is labels, counts and opaque hashes only.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { formatReport, parseReplayInput, replay } from "./replay-lib.js";
import { formatFixtureResult, runFixture, type ReplayFixture } from "./replay-pipeline.js";

function usage(): never {
  console.error("usage: bun run replay -- --rows <file.jsonl> | --fixtures <dir|file.json>");
  process.exit(2);
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
  const [flag, path] = argv;
  if (!path) usage();
  if (flag === "--rows") {
    const parsed = parseReplayInput(readFileSync(path, "utf8"));
    console.log(formatReport(replay(parsed.rows), parsed));
    return;
  }
  if (flag === "--fixtures") {
    for (const file of fixtureFiles(path)) {
      const fixture = JSON.parse(readFileSync(file, "utf8")) as ReplayFixture;
      const result = await runFixture(fixture);
      console.log(formatFixtureResult(result));
    }
    return;
  }
  usage();
}

await main(process.argv.slice(2));
