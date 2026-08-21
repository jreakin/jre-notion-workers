# Brainstorm Intake — Notion Platform Tool (jre-notion-workers)
**Spec name:** notion-platform-tool
**Output path:** docs/spec/notion-platform-tool/ — first pass for this spec, flat (no prior content on disk, no migration required)
**Date:** 2026-07-26

**Intent:**
Rework `jre-notion-workers` from a Notion-Workers-only repo into an all-in-one Notion platform
maintenance tool spanning three surfaces: (1) the `ntn` CLI and Notion public REST API,
(2) Notion Workers, and (3) Notion as Code — workspace infrastructure-as-code. Today every
structural change to the workspace (creating databases, wiring teamspaces, defining custom
agents, repairing schema drift) is done by hand through the Notion MCP in Claude Desktop, one
call at a time. The goal is for coding agents to configure, template, audit and repair the
workspace programmatically instead. TypeScript/Node is the presumed language but has not yet
been through a formal gate. Architecture, CLI surface, as-code engine design, state model, and
the merge strategy for two divergent worker generations are all open.

**Fixed constraints:**

*Platform facts (verified this session against primary sources — the public docs are wrong on several of these):*
- Notion as Code is a **public REST API, not a CLI subcommand**: `POST /v1/infra_as_code` returns a taskId; poll `GET /v1/async_tasks/{taskId}`. The released `ntn` 0.21.2 binary has no `notion-as-code` subcommand. The `makenotion/notion-as-code-template` repo documents a CLI path that does not exist.
- As-code authenticates with a **personal access token**, not an integration/bot token.
- **No server-side state.** The client supplies `existingResources`/`existingProperties`; that mapping is the only thing preventing duplicate creation on re-apply. Hand-seeding it with real Notion IDs is the mechanism for adopting existing records.
- As-code **can create and update inside an existing space but cannot create a space**.
- Intent union is exactly `space | teamspace | database | page | view | file_attachment | custom_agent`. Page content is Notion-flavored **Markdown strings, not block objects**.
- **No delete intent and no server-side plan/dry-run.** Every mistake is manual cleanup.
- Rate limit **5 requests/minute** on `/v1/infra_as_code`.
- `custom_agent` has **no field for attaching Worker tools** — agent↔tool wiring is permanently manual.
- Notion as Code is a **gated alpha; access applied for, not yet granted.**
- Notion Workers require **Business/Enterprise** plus workspace-owner enablement, and **stop being free on 2026-08-11** ($0.0023/run; a `"5m"` sync ≈ 8,640 runs/mo ≈ $20/mo).
- Workers have **no versioning and no rollback** — redeploying prior source is the only rollback.
- `ntn workers *` speaks a **private, unversioned `/api/v3/` RPC surface**; pin the CLI version.
- Pin `NOTION_API_VERSION` (currently `2026-03-11`) — the default is fetched live and can shift.
- `ntn doctor` writes to stderr and always exits 0 — never parse it; `ntn whoami --json` is the auth probe.

*Human-stated / organisational:*
- Secrets flow **only** through 1Password Environments / `op run`. `op read` is prohibited and hook-blocked. Canonical Environment: `i6ul2k6tk5kzyszv465wzhdpnu`.
- The as-code personal access token must live in a **separate** 1Password Environment from the workers' database-ID keys.
- As-code **apply is feature-flagged**; the full build → validate → plan pipeline must run offline while alpha access is pending.
- As-code applies target the **primary workspace only, guarded** — no scratch workspace. Guard is an explicit flag plus typed confirmation.
- The GitHub repo is to be **made private**; as-code definitions and state are then committed.
- **Deploy freeze** in force until the lost worker generation is recovered (see below).
- Node ≥ 22. npm is the package manager / lockfile authority; Bun is the test runner only.
- Every command must be agent-consumable: `--json` on stdout, diagnostics on stderr, documented non-zero exit codes.

*Codebase reality (blocking constraints, not preferences):*
- The repo contains **two divergent worker generations**. `jre-notion-workers/` (nested, 33 tools) has source but is written against `@notionhq/client` 2.3.0 on API **2022-06-28**, with 25 call sites on the deprecated `notion.databases.query` and no version pin. The committed root `dist/` is a **34-tool build whose TypeScript was never committed** — it is the API-2026-03-11 migration itself, plus a Zoho integration, a plan webhook, a scheduler, inbox routing and autofill workers.
- **The sourceless generation is what is deployed.** Some of its 13 unique tools are live in production.
- Recovery is in progress: 2,207 lines reconstructed and verified **token-identical** to the deployed build (`shared/notion-client`, `shared/zoho-client`, `shared/time-log-relations`, `workers/sync-zoho-projects`, `workers/sync-crm-accounts`, `workers/sync-hours-by-client`). Nine tools and seven shared modules remain sourceless.
- The canonical generation's real pins, read from its own abandoned `node_modules`: `@notionhq/client@5.21.0`, `@notionhq/workers@0.4.0`, `typescript@5.9.3`, `esbuild@0.27.4`, `ntn@0.13.2`. `0.4.0` already exposes `tool`, `sync`, `webhook`, `database`, `oauth`, `pacer`.
- 22 behavioural bugs were catalogued during recovery and deliberately left unfixed to preserve fidelity.
- Environment-key drift, **re-measured in Phase 2** (the figure below supersedes an earlier unverified count of 15 pointers): `.env.example` has **20** keys, `.env.1p` has **18** `op://` pointers, `scripts/deploy.sh` `WORKER_ENV_KEYS` has **18**, and the canonical generation needs **16 further** variables present in none of them. `deploy.sh` **fails silently** on a missing key — its push loop is `if [[ -n "$val" ]]` and it only errors when *every* key is absent.
- No CI test workflow exists (`.github/workflows/` has only `label.yml` and `release-please.yml`).

**Timeline:** production (months)

**Greenfield:** no

**If no — retrofit or evergreen:**
Retrofit by the skill's own detection — no `.abstract-data/` directory, no `abstract-data` CLI,
no `docs/adr/` log — despite the governance doc set (`AGENTS.md`, `ARCHITECTURE.md`,
`GUARDRAILS.md`, `TESTING.md`, `WORKERS.md`) being present and code referencing `ADR-0009`,
`ADR-003`, `ADR-004`. The project went through the pipeline once and has since drifted past
what a sync would fix.

**Human override (recorded):** rather than hand off to `project-alignment` first, the human
elected to treat the platform tool as **new scope** and run the full brainstorm now, on the
reasoning that the genuinely open decisions here are architectural (as-code engine, state
model, CLI surface, generation-merge strategy) rather than stack decisions `project-alignment`
audits. Repo alignment proceeds as a **separate track and is not a blocker**. Phases 1–2 are
therefore NOT skipped — the language and tooling gates run normally, since this is being
treated as new scope rather than an evergreen extension.

**BMAD roles:** solo — John plays PM + Architect; agents play Engineer, QA, DevOps
(per the skill's documented solo default).

---

## Decision Log
<!-- Each phase appends its locked decision here after APPROVE. Never edit a prior entry. -->

### Phase 1 — Language (locked 2026-07-26)

**Primary:** TypeScript 5.x — Node ≥ 22 runtime, npm as lockfile authority, Bun as test runner
only. **Single language across all three surfaces. Not a split.**

**Rationale (as approved):**
- The org's canonical mapping already covers this project shape. `AGENTS.md (JS/TS Base)` v1.1.0
  (live Notion pull, last reviewed 2026-07-02) names `ntn workers deploy`, `@notionhq/client`
  initialization, `iteratePaginatedAPI`, and Notion error-code narrowing as base content.
  `JS/TS Project Setup & Retrofit` routes `project_type: worker` to "Use JS/TS Base only —
  Worker patterns are in the base," with `deploy_target: ntn`, `node_version: 22`,
  `repo_visibility: private`.
- Notion Workers execute TypeScript on Notion's runtime, so one of the three surfaces has no
  language choice at all.
- **The decisive argument is the state model, not type sharing.** `existingResources` /
  `existingProperties` is the only thing preventing duplicate creation on re-apply, against a
  primary workspace, with no server-side dry-run and no delete intent. That mapping is produced
  by reading live workspace state — the same code path as the REST audit/repair surface, which
  is TS-native via `@notionhq/client` 5.21.0. A Python CLI would put a serialization boundary
  through the most safety-critical structure in the system.
- A Python CLI would also have to shell out to `ntn` and parse its JSON regardless
  (`ntn whoami --json`; `ntn workers *` on the private `/api/v3/` surface).
- Over a production/months horizon a **solo maintainer** would carry two lockfiles, two CI
  matrices and two dependency streams into a repo that currently has no CI test workflow, 22
  catalogued unfixed bugs, and a partly sourceless deployed generation under deploy freeze.

**Where the split genuinely had a point (recorded, not suppressed):** `custom_agent` has no
field for attaching Worker tools, so the one place as-code and Workers would need shared types
is exactly the place Notion made impossible. A Python CLI's dual-schema cost is therefore
smaller than it first appears. Outweighed by the state-model argument, not by a type-port cost.

**Falsification test:** if the worker package did not exist — an as-code + REST audit CLI only —
the recommendation would be Python/Typer. TypeScript wins here specifically because the worker
package exists, is deployed, is partly sourceless, and is under deploy freeze pending recovery.

**Orchestrator correction to the subagent's reasoning (recorded):** the subagent grepped
`node_modules`, found no as-code intent types, and concluded the schema must be hand-authored.
The types are indeed absent from every published package — but a 1,998-line `types.d.ts` does
exist in `makenotion/notion-as-code-template` on GitHub (verified this session). **Vendoring a
pinned copy with provenance is a live option; hand-authoring is not forced.** Phases 2–3 should
treat it as such.

**AGENTS.md base:** `AGENTS.md (JS/TS Base)` v1.1.0 — sole base, no type-specific overlay.
Companions: `WORKERS.md (Notion Workers)`, `GUARDRAILS.md`, `ARCHITECTURE.md`, `TESTING.md`
(JS/TS). Environment overlays split by surface: **`AGENTS.prod.md`** for the Workers/deploy
surface, **`AGENTS.alpha.md`** for the gated as-code apply surface. Also binding: the
**TypeScript Design Principles Playbook** (P1–P17) and `Notion CLI & API — Deterministic Ops
(2026)` — note the latter's `data_source_id`-not-`database_id` callout, directly relevant to the
25 deprecated `notion.databases.query` call sites in the legacy generation.

**Risks handed forward to Phase 2:**
1. **Un-sourced CLI tooling decision.** The JS/TS Base says nothing about CLI argument parsing,
   and DEV-ENV-INDEX has no TS counterpart to `abstract-data-cli-readiness` or `CLI
   Agent-Readiness Audit`. Node 22's stdlib `node:util parseArgs` is the traceable zero-dependency
   fallback; any third-party TS CLI framework needs a Context7 receipt **plus** a recorded human
   override. The playbook's *contract* — the 15-point Agentic CLI Design Scorecard, `--json` on
   stdout / diagnostics on stderr / documented non-zero exit codes / TTY detection — binds
   regardless of language and must be carried into TS explicitly.
2. **Zero Context7 coverage for Notion as Code.** The one component for which Phase 2 cannot
   produce a receipt. Substitute: the intake's verified primary-source platform facts are the
   schema's source of truth, logged as a receipt-equivalent, plus a contract test that
   re-verifies against the live API once alpha access lands.
3. **`@notionhq/workers` Context7 resolves to the template repo at 0.8.x** while the
   fidelity-locked pin is **0.4.0**. Receipts must be checked against the 0.4.0 surface; the
   fidelity constraint forbids bumping inside the recovery commit.
4. **Compile-time types are insufficient for the as-code path.** Phase 2 must select a runtime
   schema validator for the intent union and for the `existingResources` mapping.

**Human decision:** APPROVE (2026-07-26), with the CLI's divergence from the Python/Typer house
playbook consciously accepted on the condition that its output contract is preserved.

### Phase 2 — Tooling (locked 2026-07-26)

**Package manager:** npm (lockfile authority, `npm ci`) + npm **workspaces** — root `package.json`
must gain a `workspaces` field; it has none today, so `packages/workers` is currently orphaned.
**Framework:** none — CLI/local tool. `@notionhq/workers@0.4.0` is a platform SDK, not an app framework.
**CLI argument parsing:** `node:util` **`parseArgs`** (Node 22 stdlib) + a hand-rolled command registry.
**Data layer:** none — Notion is the system of record; local state is a committed JSON file.
**Runtime validation:** **ajv 8.18.0 + ajv-formats 3.0.1**, promoted transitive → direct. Zero net install.
**As-code intent types:** **vendored pinned `types.d.ts`** + `PROVENANCE.json` + three-layer drift detection.
**Test stack:** **`bun:test` + `node:` stdlib only.** No fixture/HTTP-mock/fake-timer/snapshot libraries.
**Build:** **`tsc` only.** No bundler for the CLI; no bundler change for workers.
**Lint/format:** ESLint 9 flat config + typescript-eslint `recommended` (not type-checked) + Prettier 3,
scoped to new packages; `packages/workers/src` in `globalIgnores`.
**Deploy:** N/A for the CLI. Workers deploy stays manual via `scripts/deploy.sh` under `op run`, **frozen**.
**Observability:** structured logging to **stderr only** — an on-demand CLI has no uptime between runs.
**Terraform:** no. The only infrastructure is the Notion workspace; Notion as Code is the IaC layer.
**Secrets:** `op run --environment` exclusively, two Environments, no `op read`, no 1Password JS SDK.

**Key reasoning, preserved:**

- **`parseArgs` needs no override, and is the better answer.** Fourteen of the fifteen Agentic CLI
  Design Scorecard criteria are the implementer's regardless of framework. The fifteenth — the
  machine-readable `commands --json` catalog — *actively punishes* a framework: with a hand-rolled
  registry the catalog **is** the registry and cannot drift from the implementation, whereas
  reflecting over commander's internal AST can silently diverge. `parseArgs` has no subcommand
  support; shifting `argv` before the call is ~30 lines, not a dependency.
- **`j` must not be used for as-code intents.** `@notionhq/workers`' `json-schema.d.ts` enforces at
  the type level: no recursive schemas, all object properties required, `additionalProperties: false`,
  no string/number constraints, no `allOf`/`not`/`if`/`then`/`else`. That is the Anthropic∩OpenAI
  structured-output intersection — correct for the 34 tool registrations, wrong for nested intents
  with genuinely optional fields and Notion-ID `pattern` validation. One ajv instance, two authoring
  styles: `j` for tool registrations, plain JSON Schema for as-code.
- **Validate narrowly, not exhaustively.** Do NOT re-express 1,998 lines of intent types as runtime
  schema — Notion's server is the only authoritative validator. Client-side validation earns its
  keep at exactly three boundaries: (1) the intent discriminator (`discriminator: true` + `oneOf`);
  (2) `existingResources`/`existingProperties` — validated hard, including a **referential-closure
  graph walk** that is not a schema check; (3) the `/v1/infra_as_code` and `/v1/async_tasks` envelopes.
  ajv earns its place beyond availability: `ErrorObject.instancePath` is a JSON Pointer, which maps
  one-to-one onto the scorecard's structured-error requirement where a hand-rolled guard returns `false`.
  Config: `new Ajv({ allErrors: true, discriminator: true, strict: true })`.
- **Zod rejected** — genuinely new dependency, and infer-type-from-schema would put it in competition
  with the vendored `types.d.ts` for source-of-truth, guaranteeing drift.
- **Vendored types, three-layer drift detection.** Layer A: weekly CI SHA-256 of upstream
  `types.d.ts` vs `PROVENANCE.json`. **Layer B (the one that matters):** every 4xx from
  `POST /v1/infra_as_code` persisted verbatim to `tests/fixtures/api-errors/` — a rejected field the
  vendored types call valid IS drift evidence, and it is the only detector that can see the
  unpublished *server* schema change. Layer C: offline build→validate→plan contract test over one
  fixture per intent type. `types.d.ts` stays byte-verbatim; corrections live in a sibling
  `overrides.d.ts` so the drift hash never goes stale for a local reason.
- **Never automate an apply.** The contract test stops at `plan`. No scratch workspace, no delete
  intent, no server-side dry-run — the first real apply is a human at a terminal with the guard flag.
- **Golden files, not `toMatchSnapshot()`.** A compiled `intents.json` is a human review artifact;
  reviewers must be able to read the diff. `tests/golden/` goes in `.prettierignore`.
- **`packages/workers` stays sealed.** Fidelity is verified by plain `tsc` emit comparison — a
  bundler, path alias, or cross-package runtime import changes the emit and destroys the only
  evidence of what is running in production. Cloud rolldown bundling of a workspace-linked package
  is unverified and untestable under a deploy freeze, and there is no rollback. Types may cross the
  boundary (erased); runtime values may not. Enforced by `verbatimModuleSyntax` in the new packages
  plus a CI check that `packages/workers/src` has zero imports resolving outside itself.
- **CI jobs:** typecheck · **fidelity (required check — the mechanical guard on the deploy freeze)** ·
  test · lint · **env-parity** · **freeze-guard** (fails while the deploy-freeze marker exists) ·
  weekly drift cron. No deploy workflow, no secrets in CI — every test is offline, so the runner
  never needs `op` or a PAT and cannot leak one.
- **Cross-contamination guard.** An as-code command refuses to run if any workers-Environment key is
  present in `process.env`. This is the only *mechanical* enforcement of the two-Environment
  separation; without it the separation is a convention that erodes on first misuse.
- **1Password JS SDK declined** despite being canonical in DEV-ENV-INDEX — it needs a service-account
  token, itself a secret requiring its own bootstrap path, and adds a runtime dependency to a CLI a
  human already invokes from a shell. Recorded as the canonical option deliberately not taken.

**Two live repo breakages found (block CI, not Phase 2's to fix):**
1. `packages/workers/scripts/verify-fidelity.mjs` hard-codes `node_modules/.bin/tsc`, which does not
   exist and will not exist under workspaces (binaries hoist to root). Fix via
   `createRequire(import.meta.url).resolve("typescript/bin/tsc")`.
2. Root `package.json` declares no `workspaces` field.

**Design requirements forced onto Phase 3:**
- `NOTION_API_BASE_URL` config seam (mirroring `@notionhq/client`'s own `baseUrl`) — without it the
  fake server is unreachable and the whole offline as-code pipeline is untestable.
- A `Clock` port (`now()`/`sleep()`) so the 5 req/min limiter does not make tests sleep.
- The referential-closure check on `existingResources` needs a home in the architecture.

**Overrides approved by the human (2026-07-26):**
| # | Item | Severity |
|---|---|---|
| 1 | ajv 8.18.0 + ajv-formats 3.0.1 promoted transitive → direct | Minor |
| 2 | Vendored `types.d.ts` from `makenotion/notion-as-code-template` | Minor |
| 3 | `ntn@0.13.2` as an exact devDependency (pinned nowhere today) | Trivial |
| 4 | CI installs with `npm ci`, not `bun install` — the canonical CI template cannot express npm-lockfile + Bun-runner | Trivial |
| 5 | ESLint scoped, `packages/workers/src` excluded (fidelity freeze; reverts when it lifts) | Trivial |

**Net-new packages across the whole stack: three** — eslint, typescript-eslint, prettier. Everything
else is a promotion, a pin, or a committed file.

**Feedback owed to the dev-env maintainer:** the `GitHub Actions CI (JS/TS)` template cannot express
npm-lockfile + Bun-runner; `test-writer.md (TypeScript)` emits Vitest/Playwright against a
Bun-test-only base.

**Human decision:** APPROVE (2026-07-26), all five overrides recorded.

### Phase 3 — Patterns (locked 2026-07-26)

**Primary pattern:** prompt chaining — the as-code engine is a fixed, gated sequential pipeline
(load → record → serialise → validate → close → plan → **gate** → apply → merge → verify).
**Composition:** routing → prompt chaining, with bounded parallelization inside `plan`'s live-record
fan-out (semaphored by the rate limiter). Explicitly *not* orchestrator-workers (nothing decomposes
dynamically) and *not* evaluator-optimizer (no quality-scored regeneration loop).
**Hexagonal / Ports & Adapters:** yes, as *Pure core / I-O edge*. `process.*`, `fetch`,
`child_process`, `node:fs` confined to `*/src/adapters/` by CI grep; cross-package direction
enforced at compile time by `tsc` project references.

**Packages (5) and direction:**
`cli → ascode → notion-port → core`; `cli → notion-port → core`; nothing → `workers`
(`cli --import type--> workers`). `packages/workers/tsconfig.json` gets **no changes at all** —
no `composite`, no `verbatimModuleSyntax`, no references. The seal is one-directional: workers
*exports* `./types` and imports nothing new, so it needs no edit.

**Organising device — "the check is the constructor."** Every dangerous precondition is a branded
type whose sole constructor is the check: `ObservedIntent`←`observe()`, `ClosedIntentDocument`←
`checkClosure()`, `ApprovedPlan`←`confirmApply()`, `GuardedTarget`←`resolveTarget()`,
`AsCodeEnv`←`loadAsCodeEnv()`. Brands erase at runtime, so **each is paired with a runtime
re-check** (plan-hash re-verification, closure re-walk on the deserialised document, workspace-id
match against live `whoami`). Two layers, stated as two.

**`plan` / `adopt` cannot diverge — structurally.** Both are compositions of one primitive,
`observe(pointer)`, the sole (non-exported-constructor) producer of `ObservedIntent`. The same
canonicaliser runs on **both sides** of the diff, so a canonicaliser bug cancels out and biases
toward **under**-reporting change — the recoverable failure. Over-reporting would say "create" for
an existing record and duplicate the workspace. Further, **create-vs-update never comes from the
diff**: pointer in state → update, absent → create. All duplication risk therefore concentrates on
the state model. Acceptance tests: `adopt→plan` fixpoint must be empty for every fixture, and
`apply→re-plan` convergence must be empty.

**Intent recording:** recorder yes, module-level global no. `node:async_hooks AsyncLocalStorage`
scopes the recorder per build — decisive reason is test isolation (a module global would depend on
resetting the ESM module cache). `database()` returns an opaque `Ref<'database'>`; `view()` takes a
`Ref`, not a string, so an undeclared reference is unconstructible. References to pre-existing
records are `AdoptedRef`, minted only by the state loader from a real `RecordPointer`. **Loader must
cache-bust** (`import(url + '?b=' + nonce)`) or a second import in one process silently records nothing.

**Closure check has two homes:** authoring-time by construction (`Ref` handles) and validate-time as
a pure graph walk over the wire format, before the first network call. `plan` accepts only
`ClosedIntentDocument`.

**State model:** `state/<space-slug>.json`, committed, one per space, with a `space` header guarding
wrong-workspace apply. **Additive-only for pointers** — the merge function's type has no removal
path; removal lives only behind `state forget`. Concurrency: O_EXCL lock file that **never
auto-expires** (auto-expiry is how two applies happen) plus dirty-tree refusal on `state/` and
`definitions/`, with **no `--allow-dirty`**. Crash-safety ordering — the dangerous window is
**send→first-response**, not response→merge, because a POST that succeeded with a lost response is
indistinguishable from one that never landed: journal `{planHash, requestBody}` and **fsync before
the POST**; persist the raw task response verbatim before any state mutation; atomic
tmp+rename+fsync for the merge; a found journal makes any command refuse to proceed.
`schemaVersion` integer; a reader **refuses** a file newer than it knows; migrations are explicit,
never implicit during apply. **`plan` is a saved artifact** (`plan -o`), consumed hash-verified by
`apply --plan`, closing the approve-P/execute-P′ TOCTOU.

**`verified` vs `unverifiable` is derived, never authored** — it falls out of `observe` coverage,
so nothing can be marked verified that cannot be read back. Unverifiable: page content (lossy
markdown→blocks server transform), `custom_agent` internals, view config beyond `/v1/views`,
anything evidenced only by the `createdRecordCounts` aggregate. `apply` runs a **post-apply verify
pass** reporting confirmed/drifted/unverifiable — the compensating control for having no rollback.

**Result contract:** new code uses `Result<T, PlatformError>` in `core`, discriminated on **`ok`**
(deliberately not `success`, so the internal envelope can never be mistaken for the frozen wire
envelope). `PlatformError.path` is ajv's `instancePath` JSON Pointer. Two boundary adapters;
`toWorkerOutput` is **duplicated inside the sealed package** (~10 lines) by design — honest
duplication across an intentional seal beats a runtime import that breaks fidelity. The frozen
shapes are protected mechanically by golden-comparing emitted `dist/shared/types.d.ts` against
`tests/golden/wire-contract.d.ts`.

**Testing:** ports with fakes — `Clock`, `HttpFetch`, `FileStore`, `Process`, `Git`, `Ntn`. The fake
`ntn` is **an implementation of an interface, not a script on PATH**; the port exposes `whoami()`
and has **no `doctor()` method at all**, making "never parse `ntn doctor`" unstatable. The fake
as-code server is written as a `SupportedFetch` function first; the `node:http` server is a thin
adapter around it. Its error fixtures are fed from Phase 2's Layer-B capture, so the fake gets more
faithful every time production rejects something.

**Two SDK facts that are architecture-bearing:** `retry` defaults ON with real timers →
**`retry: false` on every client** or the `Clock` port is a lie. And `Client.request<T>({path,…})`
is **public and takes an arbitrary path** → build the as-code transport on it, inheriting `baseUrl`,
`notionVersion`, auth and `APIResponseError` narrowing rather than reimplementing them.
Also: 5.21.0's `defaultNotionVersion` is `2025-09-03`, one generation behind the 2026-03-11 target —
concrete confirmation of the pin-the-version constraint.

**Two-generation convergence: Strangler Fig with a mechanical fidelity ratchet.**
`packages/workers` is the destination; nested `jre-notion-workers/` is a frozen read-only **donor**.
Lanes recorded in machine-readable `packages/workers/FIDELITY.json`: **A `recovered`** (transcribed
from `dist/`, token-identical — 6 done, 9 tools + 7 modules outstanding); **B `ported-and-proven`**
(donor source as a transcription *hint*, `dist/` as the oracle — the 21 both-generations tools);
**C `new`** (no oracle, **forbidden while frozen**). CI asserts every `src/` file appears in the
manifest, no lane downgrades, and the verified count never decreases.
**Key finding:** the 25 `notion.databases.query` call sites are **not pending migration work** —
the canonical generation already migrated them and the result is compiled into root `dist/`. Porting
is *recovery, not rewrite*; a rewrite would have no oracle and could never be fidelity-verified.
The 22 catalogued bugs get IDs `REC-01`…`REC-22` and **characterisation tests asserting the buggy
behaviour, written now**, so fixing bug N and moving that file to Lane C are the same atomic commit.
**Cutover ends in a no-op deploy** of a tree proven token-identical to what is already running —
the safest possible first deploy is the one that changes nothing. The recovery's purpose is not
tidiness; it is to restore the ability to roll back, which does not currently exist.

**Defects found in Phase 3 (prerequisites, not Phase 3's to fix):**
- Root `.gitignore` contains `packages/workers/src/_core/` — a leftover from the superseded
  sync-core plan that **contradicts the Phase 2 seal**. Delete it in the same commit that adds the
  `workspaces` field, or someone resurrects the copy-in pattern and silently changes a verified emit.
- `verify-fidelity.mjs` hard-codes a 6-element array with **no check that every `src/` file is
  listed**, so an unverified new file is invisible to the guard.
- **`scripts/deploy.sh` fails OPEN on missing env keys** (loop is `if [[ -n "$val" ]]`; errors only
  when *every* key is absent). Highest-severity latent defect: a deploy would silently push a partial
  environment to live workers with no rollback. `env-parity` checks the lists agree; it does not check
  values resolve. Both required, and `deploy.sh` must fail closed.
- **Delete the `deploy` npm script for the duration of the freeze** — a missing script is a far
  stronger guard than a documented prohibition or a CI job, neither of which stops a local run.

**Design Principles Gate, scoped honestly:** the TypeScript Playbook's own `Exclude When` reads
"Pure Node.js backends with no React," and the Gate's Step 2 scoping leaves only **P5, P6, P17** in
scope. The Gate is therefore **near-vacuous here and must not be treated as this project's quality
bar** — CI (typecheck · fidelity · test · lint · env-parity · freeze-guard · drift) and the 15-point
Agentic CLI Design Scorecard carry that weight.

**Self-identified marginal call (recorded for the constitution):** `ascode` may be ceremony for a
solo maintainer. **Collapse criterion:** if by first apply `ascode` has no consumer other than `cli`
*and* the adapters grep has never fired on an engine file, fold it into `cli` and drop to four
packages. Two costs named: project references require `tsc -b` before a cold cross-package
typecheck, and each package needs a `"bun"` export condition pointing at `src/index.ts` or Bun
resolves a stale `dist/` and the golden tests validate the wrong build.

**Corrections to the briefing, recorded so they don't propagate:** the frozen surface has **28**
copy-pasted `{success:false}` arms (not 30) and **five** non-conforming outputs (not three) —
`CheckUpstreamStatusOutput`, `LintAgentsFileOutput`, `CheckUrlStatusOutput`,
`RedactClientDocumentOutput` carry no discriminant, and `ReadRepoFileOutput` discriminates on
`found`. All five are deployed contract and are snapshotted as-is.

**Accepted residual risks:** server-side field normalisation can cause perpetual drift — detected by
the post-apply verify pass, not prevented. Two API questions remain unverified and both bear on
state safety: (a) does `POST /v1/infra_as_code` accept an **idempotency key** (if so the entire
lost-response failure class collapses); (b) does polling `/v1/async_tasks` consume the 5 req/min
budget (one shared limiter is the conservative default). Both are the first things to settle when
alpha access lands.

**Human decision:** APPROVE (2026-07-26).
