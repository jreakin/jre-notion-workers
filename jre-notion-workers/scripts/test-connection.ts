#!/usr/bin/env bun
/**
 * Quick test: load .env.local and run check-upstream-status (read-only).
 * Usage: bun run scripts/test-connection.ts
 * (Loads .env.local from project root if present; otherwise use --env-file=.env.local)
 */
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

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

import { getNotionClient } from "../src/shared/notion-client.js";
import { executeCheckUpstreamStatus } from "../src/workers/check-upstream-status.js";

async function main() {
  console.log("Testing Notion Workers connection...\n");

  const token = process.env.NOTION_TOKEN;
  const docsId = process.env.DOCS_DATABASE_ID;
  const homeDocsId = process.env.HOME_DOCS_DATABASE_ID;
  const tasksId = process.env.TASKS_DATABASE_ID;

  if (!token) {
    console.error("NOTION_TOKEN is not set. Use .env.local or run with --env-file=.env.local");
    process.exit(1);
  }
  console.log("NOTION_TOKEN: set");
  console.log("DOCS_DATABASE_ID:", docsId ? `${docsId.slice(0, 8)}...` : "missing");
  console.log("HOME_DOCS_DATABASE_ID:", homeDocsId ? `${homeDocsId.slice(0, 8)}...` : "missing");
  console.log("TASKS_DATABASE_ID:", tasksId ? `${tasksId.slice(0, 8)}...` : "missing");
  console.log("");

  const notion = getNotionClient();
  const result = await executeCheckUpstreamStatus(
    { agent_name: "GitHub Insyncerator", max_age_hours: 168, require_current_cycle: false },
    notion
  );

  console.log("check-upstream-status result:");
  console.log(JSON.stringify(result, null, 2));
  console.log("");
  if (result.found) {
    console.log("✓ Connection OK. Found digest for GitHub Insyncerator.");
  } else if (result.status === "not_found") {
    console.log("✓ Connection OK. No recent digest found (expected if no digests in DB yet).");
  } else {
    console.log("✓ Connection OK. Status:", result.status);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
