#!/usr/bin/env node
/**
 * verify-fidelity — proves the recovered TypeScript still compiles to the same
 * JavaScript as the sourceless build that is live in production.
 *
 * Recompiles src/ and compares each emitted file against its counterpart in the
 * committed root dist/, normalised for comments, trailing commas and whitespace.
 * Any divergence means the recovery drifted from what is actually deployed.
 *
 * Usage:  npm run verify:fidelity  [--dist <path-to-original-dist>]
 * Exits non-zero on any mismatch, so it is safe to wire into CI.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");

const argIdx = process.argv.indexOf("--dist");
const originalDist = resolve(
  pkgRoot,
  argIdx !== -1 && process.argv[argIdx + 1] ? process.argv[argIdx + 1] : "../../dist"
);

/** Files recovered from compiled output, so provable against the original. */
const RECOVERED = [
  "shared/notion-client",
  "shared/zoho-client",
  "shared/time-log-relations",
  "workers/sync-zoho-projects",
  "workers/sync-crm-accounts",
  "workers/sync-hours-by-client",
];

/** Reduce JS to a comparable token stream: no comments, no trailing commas, no whitespace runs. */
function normalise(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\/(?![^\n"']*["']).*$/gm, "")
    .replace(/,(\s*[)\]}])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

if (!existsSync(originalDist)) {
  console.error(`verify-fidelity: original dist not found at ${originalDist}`);
  console.error("Pass --dist <path> if the committed root dist/ lives elsewhere.");
  process.exit(2);
}

const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");

rmSync(resolve(pkgRoot, "dist"), { recursive: true, force: true });
execFileSync(tsc, { cwd: pkgRoot, stdio: "inherit" });

let failed = 0;
for (const rel of RECOVERED) {
  const mine = resolve(pkgRoot, "dist", `${rel}.js`);
  const orig = resolve(originalDist, `${rel}.js`);
  if (!existsSync(mine) || !existsSync(orig)) {
    console.log(`  ? SKIP        ${rel} (missing ${existsSync(mine) ? "original" : "emit"})`);
    failed++;
    continue;
  }
  const a = normalise(readFileSync(mine, "utf8"));
  const b = normalise(readFileSync(orig, "utf8"));
  if (a === b) {
    console.log(`  ✓ IDENTICAL   ${rel}`);
  } else {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    console.log(`  ✗ DIFFERS     ${rel} (first divergence at char ${i})`);
    console.log(`      recovered: …${a.slice(Math.max(0, i - 70), i + 70)}…`);
    console.log(`      deployed:  …${b.slice(Math.max(0, i - 70), i + 70)}…`);
    failed++;
  }
}

console.log(
  `\nfidelity: ${RECOVERED.length - failed}/${RECOVERED.length} token-identical to the deployed build`
);
process.exit(failed === 0 ? 0 : 1);
