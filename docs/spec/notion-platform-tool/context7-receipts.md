# Context7 Receipt Log — notion-platform-tool

Append-only. Written by Phases 2 and 3. Every library selected must appear here; where Context7
has no coverage, a **receipt-equivalent** records the substitute source of truth rather than
omitting the entry.

**Grounding note:** `@notionhq/*` claims were not taken from Context7 alone. Both packages are
physically present in the repo at their fidelity-locked versions, so every version-sensitive
claim was cross-checked against the on-disk `.d.ts` files. That is how Phase 1's Risk 3
(Context7 tracking 0.8.x while the pin is 0.4.0) was discharged rather than deferred.

---

## Context7 Receipt — @notionhq/workers 0.4.0
- resolve-library-id result: /makenotion/workers-template (748 snippets, High reputation, benchmark 76)
- query-docs: CONFIRMED. Retrieved worker.tool / worker.sync / worker.webhook / worker.database /
  worker.pacer / worker.oauth registration surface, SyncConfig (mode, schedule, execute, SyncResult),
  WebhookConfig + WebhookEvent, and the `j` schema-builder.
- PHASE 1 RISK 3 — DISCHARGED. The Context7 entry tracks the template repo at the 0.8.x line.
  Every documented surface was cross-checked against the on-disk 0.4.0 declarations at
  node_modules/@notionhq/workers/dist/:
    - capabilities/{tool,sync,webhook,oauth,automation,ai_connector}.d.ts — ALL PRESENT in 0.4.0
    - sync.d.ts:129 `mode?: SyncMode`, :141 `schedule?: Schedule`, :121-127 "replace"/"incremental"
      with @default "replace" — PRESENT in 0.4.0
    - WebhookVerificationError exported from index.d.ts:9 — PRESENT in 0.4.0
    - schema-builder.d.ts:29 `nullable()`, :57 `anyOf()`, :66-79 the `j` object — PRESENT in 0.4.0
  VERDICT: for every surface this project uses, the Context7 docs are 0.4.0-accurate. Corroborates
  RECOVERY.md's claim that the 0.8.3 upgrade is optional, not a prerequisite.
- Version-sensitive APIs noted: json-schema.d.ts documents HARD constraints bounding where `j` may
  be used — no recursive schemas, all object properties required, additionalProperties:false, no
  string/number constraints, no allOf/not/if/then/else, $ref/$defs but no external refs. These are
  the Anthropic-intersect-OpenAI structured-output constraints. Directly drives the decision to keep
  `j` on tool registrations and hand-write plain JSON Schema for as-code.
- Also noted: declares ajv ^8.17.1 + ajv-formats ^3.0.1 as direct dependencies (not devDeps).

## Context7 Receipt — @notionhq/client 5.21.0
- resolve-library-id result: /makenotion/notion-sdk-js (High reputation, benchmark 78.59).
  NOTE: resolving the npm name "@notionhq/client" returns unrelated packages; the correct Context7
  ID is the GitHub project name. Recorded so the next run does not repeat the miss.
  The resolve listing reports "Code Snippets: 0", but query-docs returned substantive content from
  the repo's _autodocs/. Coverage is real; the snippet count is misleading.
- query-docs: CONFIRMED. ClientOptions { auth, timeoutMs, baseUrl, logLevel, logger, notionVersion,
  fetch, agent, retry }; dataSources.{retrieve,query,create,update,listTemplates};
  iteratePaginatedAPI / collectPaginatedAPI. `baseUrl` documented as "Root URL for API requests.
  Use to point to a mock server for testing" — i.e. the NOTION_API_BASE_URL seam is the SDK's own
  intended mechanism, not an improvisation. DEFAULT_BASE_URL = "https://api.notion.com",
  DEFAULT_MAX_RETRIES = 2.
- Version pinned in ID: NO — docs reflect ~5.23.x. Re-verified against the on-disk 5.21.0 at
  node_modules/@notionhq/client/build/src/:
    - Client.d.ts:27 timeoutMs, :28 baseUrl, :31 notionVersion — ALL PRESENT in 5.21.0
    - Client.d.ts:157 `readonly databases` AND :171 `readonly dataSources` — both present;
      databases is the deprecated path
    - index.d.ts:15 exports iteratePaginatedAPI, collectPaginatedAPI, isFullPage, isFullDataSource,
      extractNotionId — PRESENT in 5.21.0
    - `retry?: RetryOptions | false`; public `request<T>({ path, method, body, headers })`
      accepting an arbitrary path — PRESENT in 5.21.0
- Version-sensitive APIs noted — THREE, all architecture-bearing:
  1. `Client.defaultNotionVersion = "2025-09-03"` in 5.21.0, NOT the 2026-03-11 this project
     targets. Confirms the pin-the-version constraint with a concrete number: an unpinned client
     silently speaks a one-generation-old API.
  2. `retry` defaults ON with maxRetries 2 and real timers. Must be `false` project-wide or the
     Clock port cannot make tests deterministic.
  3. `request()` returns a parsed body only — response headers (X-RateLimit-Remaining, Retry-After)
     and verbatim 4xx bodies are reachable ONLY through the injected `fetch`. This is what makes
     ClientOptions.fetch a first-class port rather than a test convenience.
  Also: `baseUrl` is load-bearing for the fake-server test seam; `databases.query` -> `dataSources.query`
  is the API-2025-09-03 breaking change behind the 25 legacy call sites; `isFullPage` is the guard
  missing at RECOVERY.md bug #11.

## Context7 Receipt — ajv 8.18.0 (docs indexed at v8.17.1)
- resolve-library-id result: /ajv-validator/ajv (598 snippets, High, benchmark 82.04, versions: v8.17.1)
- query-docs: CONFIRMED against /ajv-validator/ajv/v8.17.1. Retrieved the `discriminator` keyword
  with oneOf (requires `new Ajv({discriminator: true})`), the full ErrorObject interface (keyword /
  instancePath as JSON Pointer / schemaPath / typed params / message), the DefinedError
  discriminated-union type, and CurrentOptions (strict, allErrors, verbose, discriminator,
  allowUnionTypes, coerceTypes, removeAdditional).
- Version delta: tree resolves 8.18.0; docs indexed at 8.17.1. Same 8.x minor line, no breaking
  change on the surfaces used. Recorded rather than glossed.
- Version-sensitive APIs noted: v6->v8 added strict, discriminator, allowUnionTypes. All APIs relied
  on here are v8-only — a v6-era pattern would be wrong. Selected config:
  { allErrors: true, discriminator: true, strict: true }.
  `ErrorObject.instancePath` is the JSON Pointer that becomes `PlatformError.path`.

## Context7 Receipt — ajv-formats 3.0.1
- resolve-library-id result: /ajv-validator/ajv-formats (33 snippets, High, benchmark 83, versions: v3.0.1)
- query-docs: NOT separately called. Version matched exactly (v3.0.1 == tree), coverage is 33
  snippets, and it is a format-vocabulary plugin with no independent API beyond `addFormats(ajv)`.
  Presence and version verified directly on disk (node_modules/ajv-formats/package.json).
  Declared openly rather than padding the log with a call that adds nothing.
- Version-sensitive APIs noted: v3 requires ajv 8.x — satisfied.

## Context7 Receipt — Node.js 22 (node:util parseArgs)
- resolve-library-id result: /nodejs/node (28,600 snippets, High, benchmark 76.87; versions include
  v22.17.0, v22_20_0)
- query-docs: CONFIRMED against /nodejs/node/v22_20_0. Config surface: { args, strict (default TRUE),
  options, allowPositionals (defaults to !strict), tokens, allowNegative }. Returns { values,
  positionals, tokens? }. Option defs: { type: 'boolean'|'string', short, multiple, default }.
  Token reprocessing pattern for --no-* negation retrieved.
- Version-sensitive APIs noted: `allowNegative` is a later addition — present in 22.20, do not assume
  on older 22.x patch levels. NO built-in subcommand support and NO help generation — the known gap,
  addressed by shifting argv before the parseArgs call. `values` is a null-prototype object: do NOT
  call .hasOwnProperty() on it.

## Context7 Receipt — Bun (bun:test)
- resolve-library-id result: /oven-sh/bun (12,932 snippets, High, benchmark 80.59)
- query-docs: CONFIRMED. Retrieved bun:test subprocess-spawning patterns, tempDir fixture helper,
  and the snapshot API (toMatchSnapshot / toMatchInlineSnapshot).
- Version-sensitive APIs noted: JS/TS Base v1.1.0 requires an EXACT Bun pin (no LTS policy) — 1.3.11
  in CI and in "packageManager". The Base distinguishes `bun test` (built-in runner) from
  `bun run test` (package script); this project uses the built-in runner. The design deliberately
  declines toMatchSnapshot in favour of explicit golden files (a compiled intents.json is a human
  review artifact), and declines Bun.spawn in favour of node:child_process behind an `Ntn` port.

## Context7 Receipt — TypeScript 5.9.3
- resolve-library-id result: /microsoft/typescript (31,158 snippets, High, benchmark 75; versions
  include v5.9.3 — EXACT match to the fidelity-locked pin)
- query-docs: CONFIRMED against /microsoft/typescript/v5.9.3. Retrieved verbatimModuleSyntax
  semantics: TS1484 ("must be imported using a type-only import") and TS1294/TS1295 diagnostics;
  both `import type { X }` and inline `import { type X }` accepted.
- Version-sensitive APIs noted: verbatimModuleSyntax supersedes the deprecated
  importsNotUsedAsValues / preserveValueImports. Composes with NodeNext + strict +
  noUncheckedIndexedAccess. Enabled on the NEW packages only — NOT on packages/workers, where it
  would alter emit and break fidelity verification.

## Context7 Receipt — ESLint 9 (flat config)
- resolve-library-id result: /eslint/eslint (5,090 snippets, High, benchmark 76.95; versions v9.37.0,
  v9.39.3, v10.x)
- query-docs: CONFIRMED against /eslint/eslint/v9.39.3. Retrieved globalIgnores() from "eslint/config",
  and the critical semantic distinction: patterns in GLOBAL ignores can match directories ("dir/"),
  patterns in non-global `ignores` can only match files ("dir/**"). Also --no-warn-ignored and
  --max-warnings 0 for CI.
- Version-sensitive APIs noted: flat config is the v9 default; .eslintrc is removed. globalIgnores()
  is a v9.x helper and does not exist in v8 — a v8-era config would silently fail to exclude
  packages/workers/src, which is the whole point of the scoping. Pin the v9 line; do NOT drift onto
  v10 without re-checking.

## Context7 Receipt — typescript-eslint
- resolve-library-id result: /typescript-eslint/typescript-eslint (2,449 snippets, High, benchmark 81.91)
- query-docs: CONFIRMED. Retrieved flat-config composition via tseslint.config() / defineConfig(),
  per-directory scoping with `files`, the ignores-only config object as the .eslintignore replacement,
  and the official note that tseslint.configs.recommended requires NO program/projectService.
- Version-sensitive APIs noted: `recommended` (syntax-only) vs `recommendedTypeChecked` (requires
  parserOptions.projectService, materially slower, far more rules to tune). `recommended` selected
  deliberately for solo-maintainer cost — tsc --strict --noUncheckedIndexedAccess already covers the
  high-value class.

## Context7 Receipt — Prettier 3
- resolve-library-id result: /prettier/prettier (3,376 snippets, High, benchmark 78.85; versions
  3.6.2, 3.8.3)
- query-docs: CONFIRMED. .prettierignore uses gitignore pattern syntax; `--check` is the CI mode,
  returning non-zero and reporting the count of unformatted files.
- Version-sensitive APIs noted: none affecting this use. Load-bearing detail: tests/golden/ MUST be
  listed in .prettierignore, or Prettier reformats golden fixtures out from under the byte comparison.

---

# Receipt-equivalents — where Context7 genuinely has no coverage

## Receipt-Equivalent — Notion as Code (/v1/infra_as_code)
- resolve-library-id ATTEMPTED with libraryName "Notion as Code". Result: NO MATCH. Returned
  /websites/notion_help (end-user product docs), /llmstxt/notion_so_llms_txt (marketing), and two
  unrelated "X-as-Code" Sphinx projects. Zero API coverage. Phase 1's Risk 2 CONFIRMED by direct
  evidence rather than assumption.
- Incidental finding: the org's own Notion workspace IS indexed as
  /notion-john-r-eakin-s-space/ac02b3 ("AI Agents Dev Environment", 5,775 snippets). Useful for
  playbook lookups; NOT a substitute for as-code API documentation.
- SUBSTITUTE SOURCE OF TRUTH: the intake's session-verified primary-source platform facts —
  POST /v1/infra_as_code -> taskId; GET /v1/async_tasks/{taskId}; PAT auth (not bot token);
  client-supplied existingResources/existingProperties; 7-member intent union; page content as
  Notion-flavored Markdown strings; no delete intent; no server-side plan/dry-run; 5 req/min;
  custom_agent cannot bind Worker tools; cannot create a space.
- DRIFT MECHANISM: three layers. Layer B (server-observed 4xx rejections captured verbatim to
  tests/fixtures/api-errors/) is the only detector that can see an unpublished server schema change,
  and is therefore the primary one. Its output is also the fake server's input, so the test double
  gets more faithful every time production rejects something.
- PHASE 3 ADDS two questions to the contract test run when alpha access lands:
  (a) does POST accept an idempotency key? (if so, the lost-response failure class collapses)
  (b) does polling /v1/async_tasks consume the 5 req/min /v1/infra_as_code budget?

## Receipt-Equivalent — makenotion/notion-as-code-template types.d.ts (1,998 lines)
- Not a published package; exists only in a GitHub repo. Context7 indexes no such entry (the workers
  resolve returned /makenotion/workers-template, a different repo).
- SUBSTITUTE: pinned vendoring with PROVENANCE.json recording upstream repo, commit SHA, path,
  retrievedAt, sha256, and the corresponding notionApiVersion. Layer-A CI job re-hashes weekly.
  File stays byte-verbatim; local corrections live in a sibling overrides.d.ts so the drift hash
  never goes stale for a local reason.
- CAVEAT RECORDED: the same repo documents a `notion-as-code` CLI subcommand that does not exist in
  ntn 0.21.2 (intake, verified). The repo is demonstrably capable of being out of step with the
  platform. Treat types.d.ts as a strong hypothesis corrected by Layer B, not as ground truth.

## Receipt-Equivalent — ntn CLI 0.13.2
- External binary, not an npm library in the dependency graph. No Context7 entry.
- SUBSTITUTE: the canonical playbook `Notion CLI & API — Deterministic Ops for Project Setup (2026)`
  (live in Reference Documentation, Stable), plus the intake's verified behavioural facts:
  `ntn doctor` writes to stderr and always exits 0 — NEVER parse it; `ntn whoami --json` is the auth
  probe; `ntn workers *` speaks a private, unversioned /api/v3/ RPC surface.
- ACTION: pin as an exact devDependency "ntn": "0.13.2". Currently pinned NOWHERE in any
  package.json in the repo despite being an intake constraint.
- PHASE 3 STRUCTURAL NOTE: the `Ntn` port exposes whoami() and has NO doctor() method at all, so the
  "never parse ntn doctor" rule is unstatable rather than merely documented.

## Not applicable — Node standard library
- `node:util parseArgs`, `node:async_hooks AsyncLocalStorage`, `node:fs` (O_EXCL open, atomic rename)
  carry no third-party receipt beyond the Node.js entry above; they are runtime stdlib under the
  locked Node >= 22. Recorded explicitly so the absence does not read as an omission.

## Inherited pin — explicitly NOT selected by this brainstorm
- `date-fns@3.6.0` is a fidelity-locked dependency of packages/workers. Not selected, not evaluated,
  not vouched for; no receipt fetched. Frozen by the recovery constraint and belongs to the fidelity
  PR's review scope. Flagged rather than quietly listed in the stack as if it had been vetted.

---

**Net-new third-party packages introduced across Phases 2 and 3: three** — eslint,
typescript-eslint, prettier. Everything else is a promotion of an existing transitive, a pin of
something already required, a committed file, or Node stdlib.
