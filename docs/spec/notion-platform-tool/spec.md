# spec.md — Notion Platform Tool (`jre-notion-workers`)

## Version: 0.1.0 (DRAFT)
## Date: 2026-07-26
## Constitution: ./project-constitution.md
## Intake & decision log: ./brainstorm-intake.md
## ADR (draft): ./adr/adr-draft-stack-selection.md
## Receipts: ./context7-receipts.md

> **THIS IS A DRAFT.** It is the Phase 5 output of `abstract-data-spec-brainstorm` and has had
> **no human approval gate**. It is reviewed properly in **SDD Phase 2 (PLAN)** by the
> `spec-reviewer` subagent. Do not treat any requirement here as locked; treat the
> **constitution** as locked and this document as the first attempt to discharge it.
>
> **Traceability rule.** Every functional requirement carries the constitution IDs it discharges.
> A requirement that contradicts an `NN-nn` is a defect in this draft, not a decision.
> Requirements with no `NN` trace are marked `[untraced]` and are listed again in Open Questions.
>
> **Format rule.** Every acceptance criterion below is EARS:
> `WHEN <trigger> / THE <component> / SHALL <behaviour> / SO THAT <reason>`.
> Anything that could not be phrased that way was moved to Non-functional notes or Open Questions
> rather than softened into a fake criterion.

---

## Problem Statement

`jre-notion-workers` is being reworked from a Notion-Workers-only repo into an all-in-one Notion
platform maintenance tool spanning three surfaces: the `ntn` CLI and the Notion public REST API,
Notion Workers, and **Notion as Code** (workspace infrastructure-as-code via
`POST /v1/infra_as_code`). Today every structural change to the maintainer's workspace — creating
databases, wiring teamspaces, defining custom agents, repairing schema drift — is made by hand
through the Notion MCP in Claude Desktop, one call at a time. The goal is for coding agents to
configure, template, audit and repair the workspace programmatically, through a CLI whose output
is machine-consumable by construction.

Four facts dominate every requirement in this document. **(1)** Notion as Code has no server-side
state and no server-side plan or dry-run; the client-supplied `existingResources` /
`existingProperties` mapping is the only thing preventing duplicate creation on re-apply, so
`plan` is a *client-side prediction* and is the single largest value the tool adds. **(2)** There
is **no delete intent and no rollback**, the target is the maintainer's **primary** workspace, and
every mistake is manual cleanup. **(3)** The repo's committed root `dist/` is a build **whose
TypeScript was never committed**, that sourceless generation is **what is deployed**, and Notion
Workers have no versioning — so a deploy today is irreversible by construction and the repo is
under a deploy freeze. **(4)** The wire contract that production Custom Agents consume is
therefore only partially expressible from source, and closing that gap is a first-class
requirement of this spec, not a cleanup task.

---

## Correction carried into this draft (verified 2026-07-26 against the repo)

The constitution's **NN-45** says *"the 33 deployed worker output shapes"*. That count is
**incomplete**, and the gap changes what the mechanical guard must snapshot. Measured directly:

| Artifact | Registrations |
|---|---|
| Nested `jre-notion-workers/src/index.ts` (donor, **not deployed**) | **33** `tool` |
| Root `dist/index.js` (**deployed**) | **34** `tool` + `webhook("plan-events")` + `database("github-items-db")` + `database("worker-runs-db")` + `sync("github-items-sync")` + `sync("scheduler")` |

- **21** tools exist in both generations; **13** exist **only in the deployed build**:
  `audit-dev-environment`, `audit-time-log`, `autofill-docs-projects`, `autofill-meeting-dates`,
  `autofill-task-clients`, `autofill-task-priority`, `compose-morning-briefing`,
  `label-github-prs`, `route-inbox`, `run-fleet-ops-daily`, `sync-crm-accounts`,
  `sync-hours-by-client`, `sync-zoho-projects`.
- **12** tools exist only in the nested donor (the `client-*` / `agent-ops` family) and are **not
  deployed**.
- The canonical generation's `dist/shared/types.js` is **124 bytes** (`export {};`) — TypeScript
  erased the type-only module. **The wire contract for the live-only tools does not exist anywhere
  in the repo as type declarations**, while Custom Agents consume those outputs in production now.
- Recovery has reconstructed types for **3 of the 13** (`sync-zoho-projects`, `sync-crm-accounts`,
  `sync-hours-by-client`), whose `*Input` / `*Output` types are exported from their **own worker
  modules**, not from `packages/workers/src/shared/types.ts` (currently a 27-line stub).
  **10 remain undefined.**
- Consequently, Phase 3's plan to freeze the contract by golden-comparing the emitted
  `dist/shared/types.d.ts` would, as written, snapshot **the nested (non-deployed) generation's**
  contract, or an almost-empty one — the wrong surface either way.
- One further correction: NN-45 lists five non-conforming outputs and calls all five "deployed
  contract". **`RedactClientDocumentOutput` is nested-generation-only** — `redact-client-document`
  appears 0 times in `dist/index.js` and has no `dist/workers/` module. Four non-conforming shapes
  are deployed contract, not five.

**Action for the constitution (not a functional requirement, so recorded here):** `NN-45` should
be restated from *"the 33 deployed worker output shapes"* to *"the deployed surface: 34 `tool`
registrations plus 5 non-tool capabilities (1 webhook, 2 databases, 2 syncs)"*, and its
non-conforming list annotated to mark `RedactClientDocumentOutput` as donor-only. Requirements
**FR-WIRE-01 … FR-WIRE-08** are written against the corrected surface.

---

## Scope

### In scope

- A single-language TypeScript CLI (`node:util parseArgs` + hand-rolled registry) covering three
  surfaces: Notion REST audit/repair, Notion Workers recovery/deploy tooling, and Notion as Code.
- The as-code engine as a fixed gated pipeline: **record -> build -> validate -> closure -> plan ->
  human gate -> apply -> merge -> verify**.
- A committed, per-space JSON state model with crash-safe write ordering, and `adopt` for bringing
  existing workspace records under management.
- A read-only REST audit surface that emits proposed repairs as data, never applying them.
- Recovery of the sourceless deployed worker generation against the `dist/` oracle, governed by a
  three-lane fidelity manifest and a monotonic CI ratchet.
- **Reconstruction and consolidation of the deployed wire contract**, including the 10 live-only
  tools that have no type declarations anywhere, and a golden snapshot covering the deployed
  surface (34 tools + webhook + 2 databases + 2 syncs).
- Two-Environment secret handling with a mechanical cross-contamination guard.
- Seven CI gates, all offline, holding no secrets.
- Definition scaffolding / templating for repeated workspace structures.

### Out of scope

- **Creating a Notion space.** As-code can create and update inside an existing space only
  (NN-28).
- **Deleting anything.** There is no delete intent (NN-28), and no `apply` path removes a record.
- **Any rollback mechanism**, for workers or for as-code. Post-apply verify is the compensating
  control, not a rollback (NN-01, NN-13).
- **Automating `apply`** from CI, cron, tests, or an agent — under any flag (NN-11).
- **Wiring Custom Agents to Worker tools.** `custom_agent` has no field for it; permanently manual
  (NN-28).
- **Fixing the 22 catalogued behavioural bugs (`REC-01`…`REC-22`)** during recovery (NN-08).
- **Migrating the 25 deprecated `notion.databases.query` call sites** — the canonical generation
  already migrated them and the result is compiled into `dist/` (NN-07).
- **Bumping any fidelity-locked pin** (`@notionhq/client@5.21.0`, `@notionhq/workers@0.4.0`,
  `typescript@5.9.3`, `esbuild@0.27.4`, `ntn@0.13.2`, `date-fns@3.6.0`) inside the recovery work.
- **The 12 donor-only tools** (`client-*` / `agent-ops` family). They are not deployed, are not
  part of the wire contract, and their adoption is a separate post-freeze decision.
- **A scratch or staging Notion workspace.** None exists and none is being created (NN-11).
- **Terraform or any second IaC layer.** Notion as Code *is* the IaC layer.
- **Zod or any second validation library** (NN-56); **any third-party CLI framework** (NN-53);
  **the 1Password JS SDK** (NN-20); **any bundler** (NN-04).
- **Metrics, tracing, or uptime monitoring.** An on-demand CLI has no uptime to observe (NN-41).
- **A TUI or an MCP-server surface.** Neither was raised in Phases 1–3; adding one requires a new
  gate.
- **Repo alignment to the abstract-data project templates.** Explicitly a separate, non-blocking
  track (intake).

---

## Functional Requirements

Groups: **CLI** (contract & output envelope) · **ARCH** (ports, purity, provenance) ·
**ENG** (as-code engine) · **STATE** (state model & crash safety) · **OBS** (adopt / observe) ·
**AUDIT** (read-only REST) · **REC** (worker recovery & fidelity ratchet) ·
**WIRE** (wire-contract preservation) · **SEC** (secrets & environments) · **CI** (gates) ·
**GEN** (codegen / templates).

### CLI contract & output envelope

**FR-CLI-01** `[NN-52, NN-41]`
WHEN any command is invoked with `--json`
THE CLI output adapter
SHALL write exactly one JSON document to stdout and route every human-readable word to stderr
SO THAT an agent can parse stdout without stripping prose.

**FR-CLI-02** `[NN-52]`
WHEN a command terminates
THE CLI dispatcher
SHALL exit with a code drawn from a single enumerated, documented exit-code table (`0` success,
and distinct non-zero codes for usage error, validation failure, guard refusal, journal-blocked,
lock-held, dirty-tree refusal, plan-hash mismatch, rate-limit exhaustion, and post-apply drift)
SO THAT an agent can branch on failure class without parsing text.

**FR-CLI-03** `[NN-53]`
WHEN `commands --json` is invoked
THE CLI
SHALL serialise the same in-memory registry object the dispatcher dispatches from, and SHALL NOT
read any separately maintained list
SO THAT the machine-readable catalog is structurally incapable of drifting from the implementation.

**FR-CLI-04** `[NN-52]`
WHEN stdout is not a TTY
THE CLI output adapter
SHALL default to JSON output and suppress colour, spinners and progress rendering
SO THAT piped and agent invocations are machine-readable without an explicit flag.

**FR-CLI-05** `[NN-52, NN-42]`
WHEN `parseArgs` rejects an invocation
THE CLI
SHALL emit a structured error on stderr naming the offending option, exit with the usage code, and
invoke no command handler
SO THAT no partially-parsed invocation ever reaches an I/O adapter.

**FR-CLI-06** `[NN-44, NN-55, NN-56]`
WHEN a command emits a structured error
THE error serialiser
SHALL include ajv's `instancePath` JSON Pointer as the error's `path` field
SO THAT the caller can locate the offending value without string-matching a message.

**FR-CLI-07** `[NN-53, NN-52]`
WHEN a command is added to the registry
THE registry type
SHALL require a JSON Schema for its options and a declared exit-code set as mandatory fields
SO THAT the `commands --json` catalog is complete by construction rather than by discipline.

### Architecture, ports and provenance

**FR-ARCH-01** `[NN-42]`
WHEN any adapter or client is constructed
THE `cli` package
SHALL be the only place that constructs it, passing ports downward to `ascode`, `notion-port` and
`core`
SO THAT there is exactly one composition root to audit.

**FR-ARCH-02** `[NN-43, NN-22, NN-23]`
WHEN a `@notionhq/client` instance is created
THE `notion-port` package
SHALL be the only package that calls `new Client()`, and SHALL pass `retry: false` and
`notionVersion: "2026-03-11"` explicitly
SO THAT the retry and version constraints hold in exactly one place instead of at every call site.

**FR-ARCH-03** `[NN-41, NN-52]`
WHEN code in `core` or `cli` needs to emit a diagnostic
THE logging port
SHALL be the only path, writing structured records to stderr, and `console.log` SHALL NOT appear
in either package
SO THAT stdout stays reserved for the machine-readable result.

**FR-ARCH-04** `[NN-40]`
WHEN engine or domain code needs time, network, filesystem, process, git or `ntn` access
THE code
SHALL take an injected port (`Clock`, `HttpFetch`, `FileStore`, `Process`, `Git`, `Ntn`) and SHALL
NOT reference `process.*`, `fetch`, `child_process` or `node:fs` outside `*/src/adapters/`
SO THAT the pure core is testable without a network or a disk.

**FR-ARCH-05** `[NN-49]`
WHEN the as-code or REST transport resolves its endpoint
THE transport
SHALL read a `NOTION_API_BASE_URL` configuration seam rather than a hard-coded host, and SHALL
obtain all delays from the `Clock` port rather than `setTimeout`
SO THAT the fake server is reachable and the 5 req/min limiter can be advanced instantly in tests.

**FR-ARCH-06** `[NN-46]`
WHEN a branded value (`ObservedIntent`, `ClosedIntentDocument`, `ApprovedPlan`, `GuardedTarget`,
`AsCodeEnv`) is used at a decision point
THE consuming stage
SHALL re-run the paired runtime check — plan-hash re-verification, closure re-walk on the
deserialised document, workspace-id match against live `whoami`, environment re-scan — and SHALL
NOT rely on the brand alone
SO THAT a guarantee that erases at runtime is backed by a check that does not.

**FR-ARCH-07** `[NN-46]`
WHEN a value is cast into a branded type by any means other than its designated constructor
THE lint and review gate
SHALL reject the change
SO THAT the check cannot be bypassed with an assertion.

**FR-ARCH-08** `[NN-50]`
WHEN a test needs a double for `ntn` or the as-code server
THE test
SHALL use an implementation of the port interface — a `SupportedFetch` function for the as-code
server, with the `node:http` server as a thin adapter around it — and SHALL NOT place a fake binary
on `PATH`
SO THAT the double is type-checked against the same interface production uses.

**FR-ARCH-09** `[NN-51]`
WHEN a workspace package is published to the workspace graph
THE package `exports` map
SHALL declare a `"bun"` condition pointing at `src/index.ts`
SO THAT the Bun test runner resolves source rather than a stale `dist/` and the golden tests
validate the build under test.

**FR-ARCH-10** `[NN-57, NN-61]`
WHEN the vendored as-code `types.d.ts` needs a correction
THE change
SHALL be written into a sibling `overrides.d.ts` while the vendored file stays byte-identical to
the `sha256` recorded in `PROVENANCE.json`
SO THAT the Layer-A drift hash never goes stale for a purely local reason.

**FR-ARCH-11** `[NN-58, NN-61]`
WHEN a captured Layer-B 4xx fixture contradicts the vendored types
THE fixture
SHALL be treated as authoritative and the divergence recorded against `PROVENANCE.json`
SO THAT an upstream template's documentation is never treated as a platform guarantee.

### As-code engine (record -> build -> validate -> closure -> plan -> gate -> apply -> merge -> verify)

**FR-ENG-01** `[NN-47]`
WHEN `build <definitions>` loads a definition module
THE definition loader
SHALL import it with a cache-busting specifier (`import(url + '?b=' + nonce)`) inside an
`AsyncLocalStorage`-scoped recorder context
SO THAT a second build in the same process records intents instead of silently recording nothing.

**FR-ENG-02** `[NN-36, NN-48]`
WHEN a definition declares a record
THE recorder
SHALL return an opaque `Ref<'database' | 'page' | 'view' | …>` handle rather than a Notion ID
string, and `view()` SHALL accept only a `Ref`
SO THAT a reference to an undeclared record is unconstructible at authoring time.

**FR-ENG-03** `[NN-48]`
WHEN a definition references a pre-existing workspace record
THE state loader
SHALL be the only component able to mint the corresponding `AdoptedRef`, and only from a
`RecordPointer` already present in the space's state file
SO THAT no Notion ID is ever hand-written into a definition file.

**FR-ENG-04** `[NN-59]`
WHEN `build` finishes recording
THE serialiser
SHALL emit `intents.json` with deterministic key and array ordering
SO THAT the compiled artifact can be byte-compared against a committed golden file that a human
can read as a diff.

**FR-ENG-05** `[NN-54, NN-55, NN-56]`
WHEN `validate` runs
THE single shared ajv instance, configured `{ allErrors: true, discriminator: true, strict: true }`
SHALL validate exactly three boundaries — the intent discriminator (`discriminator` + `oneOf`),
the `existingResources` / `existingProperties` mapping, and the `/v1/infra_as_code` and
`/v1/async_tasks` envelopes — and SHALL NOT re-express the 1,998-line intent type surface
SO THAT client-side validation is spent only where it prevents an unrecoverable mistake.

**FR-ENG-06** `[NN-54]`
WHEN an as-code intent schema is authored
THE author
SHALL write plain JSON Schema and SHALL NOT use the `j` helper from `@notionhq/workers`
SO THAT optional fields, nesting and Notion-ID `pattern` constraints remain expressible.

**FR-ENG-07** `[NN-36, NN-46]`
WHEN `checkClosure()` receives a serialised intent document
THE closure checker
SHALL walk the deserialised wire-format graph and reject any reference whose target is neither
declared in the document nor present as a pointer in state, before any network call is made
SO THAT closure holds even though brands do not survive JSON.

**FR-ENG-08** `[NN-36]`
WHEN `plan` is invoked
THE plan stage
SHALL accept only a value of type `ClosedIntentDocument`
SO THAT no unclosed document can reach the network.

**FR-ENG-09** `[NN-37]`
WHEN `plan` determines the action for a record
THE planner
SHALL derive create-versus-update solely from the presence of a state pointer — present means
update, absent means create — and SHALL NOT infer it from the diff
SO THAT all duplication risk concentrates in the state model where it can be defended.

**FR-ENG-10** `[NN-37]`
WHEN `plan` diffs an observed record against a desired intent
THE planner
SHALL apply the identical canonicaliser to both sides of the comparison
SO THAT a canonicaliser defect biases toward under-reporting change, which is recoverable, rather
than over-reporting it, which duplicates records.

**FR-ENG-11** `[NN-27, NN-49]`
WHEN `plan` fans out live reads
THE planner
SHALL bound concurrency with a semaphore driven by the single shared rate limiter
SO THAT parallelisation cannot exceed the 5 requests/minute platform budget.

**FR-ENG-12** `[NN-12, NN-34]`
WHEN `plan -o <file>` is invoked
THE planner
SHALL write a plan artifact containing the plan body, its `planHash`, the resolved workspace id,
and the git commit of `definitions/` and `state/`
SO THAT `apply` can execute exactly the plan a human reviewed.

**FR-ENG-13** `[NN-12, NN-46]`
WHEN `apply --plan <file>` is invoked
THE apply stage
SHALL recompute the plan hash, refuse on mismatch, and SHALL NOT re-derive the plan from
definitions
SO THAT the approve-P / execute-P-prime TOCTOU is closed.

**FR-ENG-14** `[NN-11, NN-15]`
WHEN `apply` is invoked
THE guard
SHALL require both the explicit guard flag and an interactively typed confirmation string matching
the resolved workspace name before minting `ApprovedPlan`
SO THAT an apply against the maintainer's primary workspace cannot happen by reflex.

**FR-ENG-15** `[NN-15, NN-25, NN-46]`
WHEN `apply` resolves its target workspace
THE `resolveTarget()` constructor
SHALL compare the configured workspace id against a live `ntn whoami --json` response through the
`Ntn` port and mint `GuardedTarget` only on an exact match
SO THAT a config file alone can never select the target.

**FR-ENG-16** `[NN-11]`
WHEN `apply` runs with a non-interactive stdin or with a CI environment marker present
THE apply command
SHALL refuse and exit non-zero
SO THAT no CI job, cron, test, or agent can invoke an apply.

**FR-ENG-17** `[NN-14]`
WHEN the as-code feature flag is unset
THE CLI
SHALL still run `build`, `validate`, `closure` and `plan` to completion against the configured base
URL, and SHALL refuse only `apply`
SO THAT the full pipeline is exercisable offline while alpha access is pending.

**FR-ENG-18** `[NN-26, NN-43]`
WHEN an as-code HTTP request is issued
THE transport
SHALL issue it through the public `Client.request<T>({ path, … })` of the single `notion-port`
client, and SHALL NOT construct a second HTTP client
SO THAT base URL, pinned API version, auth and `APIResponseError` narrowing have one implementation.

**FR-ENG-19** `[NN-27, NN-49]`
WHEN `POST /v1/infra_as_code` returns a `taskId`
THE apply stage
SHALL poll `GET /v1/async_tasks/{taskId}` through the same shared 5 req/min limiter and the `Clock`
port
SO THAT polling cannot exceed the budget on the unverified assumption that it is free.

**FR-ENG-20** `[NN-58]`
WHEN the as-code API returns any 4xx
THE transport
SHALL persist the verbatim response body to `tests/fixtures/api-errors/` before surfacing the error
SO THAT Layer-B drift evidence is captured and the fake server becomes more faithful with every
production rejection.

**FR-ENG-21** `[NN-28]`
WHEN a plan contains a `custom_agent` intent
THE plan renderer
SHALL emit an explicit manual post-apply step stating that agent-to-tool wiring cannot be performed
by as-code
SO THAT the human sees what the tool cannot do for them.

**FR-ENG-22** `[NN-28, NN-11]`
WHEN a definition expresses a space creation, a record deletion, or an intent kind outside
`space | teamspace | database | page | view | file_attachment | custom_agent`
THE validator
SHALL reject the document with a structured error naming the unsupported construct
SO THAT the pipeline fails at authoring time rather than at the platform boundary.

**FR-ENG-23** `[NN-28]`
WHEN a definition supplies page content
THE serialiser
SHALL emit it as a Notion-flavored Markdown string and SHALL NOT emit block objects
SO THAT the document matches the only content representation the endpoint accepts.

**FR-ENG-24** `[NN-13, NN-38]`
WHEN `apply` completes
THE verify stage
SHALL read back every affected record through `observe()` and report each as confirmed, drifted, or
unverifiable
SO THAT there is a compensating control for having no rollback.

**FR-ENG-25** `[NN-13, NN-30]`
WHEN the post-apply verify pass reports any drifted record
THE apply command
SHALL exit with the documented drift code while still having merged the state pointers
SO THAT drift is surfaced loudly without discarding the pointers that prevent duplication.

### State model & crash safety

**FR-STATE-01** `[NN-29]`
WHEN state is persisted
THE state store
SHALL write `state/<space-slug>.json`, one file per space, carrying a `space` header with the
workspace id and slug
SO THAT a wrong-workspace apply is detectable from the file alone.

**FR-STATE-02** `[NN-29, NN-21]`
WHEN the repository is configured
THE `state/` and `definitions/` directories
SHALL be committed and SHALL NOT appear in `.gitignore`
SO THAT the entire duplicate-prevention mechanism is reviewable as source.

**FR-STATE-03** `[NN-35]`
WHEN a state file's integer `schemaVersion` is greater than the reader's known version
THE state loader
SHALL refuse to proceed with a structured error naming both versions
SO THAT an older checkout cannot silently truncate a newer state file.

**FR-STATE-04** `[NN-35]`
WHEN a state migration is required
THE CLI
SHALL perform it only under an explicit `state migrate` command and SHALL NOT migrate as a side
effect of `apply`
SO THAT migrations land as their own reviewed commit.

**FR-STATE-05** `[NN-30]`
WHEN pointers are merged after an apply
THE merge function
SHALL add or update pointers only, and its type SHALL expose no removal path
SO THAT the mapping cannot be silently narrowed by a merge defect.

**FR-STATE-06** `[NN-30]`
WHEN a pointer must be removed
THE CLI
SHALL require the explicit `state forget <pointer>` command
SO THAT removal is a deliberate, named act rather than a side effect.

**FR-STATE-07** `[NN-33]`
WHEN `apply` starts
THE lock adapter
SHALL create the lock file with `O_EXCL`, SHALL apply no TTL, and SHALL offer no `--force-unlock`
flag
SO THAT two concurrent applies cannot arise from lock expiry.

**FR-STATE-08** `[NN-34]`
WHEN `apply` starts and the `Git` port reports any modification under `state/` or `definitions/`
THE apply command
SHALL refuse, with no `--allow-dirty` escape hatch
SO THAT the reviewed plan and the applied definitions are the same reviewable git object.

**FR-STATE-09** `[NN-31]`
WHEN `apply` is about to send the as-code POST
THE journal writer
SHALL write `{ planHash, requestBody }` and fsync it to disk before the request leaves the process
SO THAT a POST that succeeded with a lost response is distinguishable from one that never landed.

**FR-STATE-10** `[NN-31]`
WHEN an as-code task response is received
THE apply stage
SHALL persist the raw response verbatim before mutating any state
SO THAT evidence of what the platform actually returned survives a later merge defect.

**FR-STATE-11** `[NN-31]`
WHEN state is merged to disk
THE state store
SHALL write a temporary file, fsync it, rename it over the target, and fsync the containing
directory
SO THAT a crash cannot leave a truncated state file.

**FR-STATE-12** `[NN-32]`
WHEN any CLI command starts and a journal file is present
THE CLI
SHALL refuse to run, print the journal's `planHash` and path on stderr, and SHALL NOT auto-recover
or auto-discard it
SO THAT only a human who can inspect the workspace decides whether the POST landed.

**FR-STATE-13** `[NN-31, NN-32]`
WHEN the apply completes and its state merge has been fsynced
THE apply stage
SHALL delete the journal as the last step
SO THAT the journal's presence is an exact signal of an unresolved in-flight request.

### Adopt and observe

**FR-OBS-01** `[NN-39]`
WHEN any stage needs to read a Notion record
THE stage
SHALL read it through the single `observe(pointer)` primitive, whose `ObservedIntent` constructor
is not exported
SO THAT `plan` and `adopt` are structurally incapable of diverging.

**FR-OBS-02** `[NN-29, NN-37, NN-48]`
WHEN `adopt <pointer>` is invoked
THE adopt command
SHALL observe the record, write its `RecordPointer` into the space's `existingResources` /
`existingProperties`, and emit the observed intent on stdout for review
SO THAT an existing record comes under management without risking duplicate creation.

**FR-OBS-03** `[NN-39]`
WHEN `adopt` has completed for a fixture workspace and `plan` is then run
THE planner
SHALL produce an empty change set
SO THAT adoption is a verifiable fixpoint rather than an assumption.

**FR-OBS-04** `[NN-39]`
WHEN `apply` has completed and `plan` is re-run against the same definitions
THE planner
SHALL produce an empty change set
SO THAT convergence is demonstrated rather than assumed.

**FR-OBS-05** `[NN-38]`
WHEN the verify reporter labels a record
THE reporter
SHALL derive `verified` versus `unverifiable` from whether `observe()` can read the field back, and
SHALL NOT accept any authored annotation — page content, `custom_agent` internals, view
configuration beyond `/v1/views`, and anything evidenced only by `createdRecordCounts` are
therefore permanently `unverifiable`
SO THAT nothing can claim verification it cannot demonstrate.

**FR-OBS-06** `[NN-23]` (also: `Notion CLI & API — Deterministic Ops (2026)`, binding per constitution)
WHEN `observe()` reads a database's rows on API version `2026-03-11`
THE `notion-port` adapter
SHALL address it by `data_source_id` and SHALL NOT call the deprecated `databases.query`
`database_id` surface
SO THAT reads do not depend on a surface the platform has already deprecated.

### Audit (read-only REST surface)

**FR-AUDIT-01** `[NN-11, NN-52]`
WHEN any `audit *` command runs
THE audit command
SHALL issue only read requests against the Notion REST API and SHALL emit a machine-readable
findings document on stdout
SO THAT the audit surface can never mutate the primary workspace.

**FR-AUDIT-02** `[NN-11, NN-12]`
WHEN an audit finding is repairable by an as-code intent
THE audit command
SHALL emit the proposed intent as data in its `--json` output and SHALL NOT apply it
SO THAT every mutation still passes through the gated plan/apply pipeline.

**FR-AUDIT-03** `[NN-22, NN-23, NN-43]`
WHEN an audit command obtains its Notion client
THE `notion-port` package
SHALL supply the single client already configured with `retry: false` and the pinned
`notionVersion`
SO THAT the `Clock` port governs all backoff and the API version cannot drift per-command.

**FR-AUDIT-04** `[AGENTS.md (JS/TS Base) v1.1.0, per constitution]`
WHEN an audit reads a paginated Notion collection
THE adapter
SHALL iterate with `iteratePaginatedAPI` and SHALL narrow failures by Notion error code
SO THAT partial pages are never mistaken for complete results.

**FR-AUDIT-05** `[NN-25, NN-50]`
WHEN the CLI needs an authentication health signal
THE `Ntn` port
SHALL expose `whoami()` and SHALL expose no `doctor()` method at all
SO THAT parsing `ntn doctor` — which writes to stderr and always exits 0 — is unstatable rather
than merely prohibited.

**FR-AUDIT-06** `[NN-52]`
WHEN an audit finds nothing
THE audit command
SHALL emit an empty findings array with exit code 0, and SHALL NOT emit an empty stdout
SO THAT an agent can distinguish "clean" from "crashed".

### Worker recovery and the fidelity ratchet

**FR-REC-01** `[NN-06]`
WHEN a source file exists under `packages/workers/src`
THE `packages/workers/FIDELITY.json` manifest
SHALL contain an entry declaring its lane (A `recovered`, B `ported-and-proven`, C `new`), and CI
SHALL fail if any `src/` file is unlisted
SO THAT an unverified file cannot become invisible to the fidelity guard.

**FR-REC-02** `[NN-04]`
WHEN the fidelity job runs
THE verifier
SHALL compare a plain `tsc` emit of `packages/workers` against the committed sourceless root
`dist/`, resolving the compiler via `createRequire(import.meta.url).resolve("typescript/bin/tsc")`
SO THAT the guard survives npm-workspaces binary hoisting instead of pointing at a path that does
not exist.

**FR-REC-03** `[NN-06]`
WHEN `FIDELITY.json` changes in a pull request
THE CI ratchet
SHALL fail on any lane downgrade and on any decrease in the count of verified files
SO THAT recovery progress is monotonic.

**FR-REC-04** `[NN-06, NN-01]`
WHEN the deploy-freeze marker exists
THE CI ratchet
SHALL reject any new lane C entry in `packages/workers`
SO THAT no unverifiable file enters the sealed package while rollback is impossible.

**FR-REC-05** `[NN-07]`
WHEN a tool is recovered
THE recovery
SHALL transcribe it against the committed `dist/` oracle and MAY use the nested donor generation
only as a transcription hint
SO THAT recovery never silently becomes a rewrite with nothing to verify against.

**FR-REC-06** `[NN-08]`
WHEN a catalogued bug `REC-01`…`REC-22` is fixed
THE same commit
SHALL flip that file's lane to C and update its characterisation test
SO THAT losing the fidelity proof is visible in the same diff as the fix.

**FR-REC-07** `[NN-08]`
WHEN the test suite runs
THE characterisation tests
SHALL assert the current buggy behaviour of each catalogued `REC-NN` defect
SO THAT an accidental behavioural change during transcription fails a test rather than reaching
production.

**FR-REC-08** `[NN-03]`
WHEN any module under `packages/workers/src` imports another module
THE CI seal check
SHALL fail if the specifier resolves outside `packages/workers` and the import is not type-only
SO THAT the emit stays byte-comparable to what is deployed.

**FR-REC-09** `[NN-03, NN-44]`
WHEN new code inside `packages/workers` needs the worker error envelope
THE package
SHALL contain its own duplicated `toWorkerOutput` adapter rather than importing one across the seal
SO THAT honest duplication protects the emit instead of a runtime import breaking it.

**FR-REC-10** `[NN-05]`
WHEN the build configuration is changed anywhere in the workspace
THE change
SHALL leave `packages/workers/tsconfig.json` byte-identical — no `composite`, no
`verbatimModuleSyntax`, no project references
SO THAT the one-directional seal needs no edit to the sealed package.

**FR-REC-11** `[NN-02, NN-01]`
WHEN the deploy-freeze marker exists
THE repository
SHALL contain no `deploy` npm script, and `scripts/deploy.sh` SHALL be invocable only by explicit
path under `op run`
SO THAT the guard is mechanical rather than documentary.

**FR-REC-12** `[NN-10]`
WHEN `scripts/deploy.sh` resolves `WORKER_ENV_KEYS`
THE script
SHALL abort the entire deploy on the first key that does not resolve to a value
SO THAT a partial environment can never be pushed to live workers that cannot be rolled back.

**FR-REC-13** `[NN-01]`
WHEN recovery is complete and the freeze is lifted
THE cutover deploy
SHALL be a no-op deploy of a tree already proven token-identical to the running build
SO THAT the first deploy after the freeze changes nothing and rollback capability is restored
before any behaviour changes.

### Wire-contract preservation (corrected surface)

**FR-WIRE-01** `[NN-45 (corrected), NN-04]`
WHEN the wire-contract golden is generated or checked
THE generator
SHALL enumerate the deployed surface from the committed root `dist/index.js` — **34** `tool`
registrations plus `webhook("plan-events")`, `database("github-items-db")`,
`database("worker-runs-db")`, `sync("github-items-sync")` and `sync("scheduler")` — and SHALL fail
if any registration found there has no corresponding entry in the golden
SO THAT the frozen contract covers what is deployed rather than what the non-deployed nested
generation happens to declare.

**FR-WIRE-02** `[NN-45 (corrected)]`
WHEN the `wire-contract` check runs
THE check
SHALL compare against the golden keyed to the `dist/index.js` registration set, and SHALL NOT be
satisfied by comparing only the emitted `packages/workers/dist/shared/types.d.ts`
SO THAT a snapshot cannot pass while covering the donor generation's contract or an almost-empty
one.

**FR-WIRE-03** `[NN-45 (corrected), NN-06, NN-07]`
WHEN output types are reconstructed for the 10 live-only tools that have no type declarations
anywhere — `audit-dev-environment`, `audit-time-log`, `autofill-docs-projects`,
`autofill-meeting-dates`, `autofill-task-clients`, `autofill-task-priority`,
`compose-morning-briefing`, `label-github-prs`, `route-inbox`, `run-fleet-ops-daily`
THE recovery
SHALL derive each shape from that tool's compiled module in `dist/workers/` together with its
registration schema in `dist/index.js`, and SHALL record the derivation evidence and its
confidence in `FIDELITY.json`
SO THAT the contract Custom Agents consume in production exists as a type declaration in the repo.

**FR-WIRE-04** `[NN-45, NN-04, NN-03]`
WHEN a worker's `*Input` / `*Output` types are currently exported from its own module
(`sync-zoho-projects`, `sync-crm-accounts`, `sync-hours-by-client`)
THE consolidation
SHALL move them into `packages/workers/src/shared/types.ts` and re-export them from the worker
module, and the fidelity JavaScript emit comparison SHALL remain byte-identical afterwards
SO THAT the wire contract gains a single home without changing what runs.

**FR-WIRE-05** `[NN-45 (corrected)]`
WHEN the golden records the non-conforming output shapes
THE golden
SHALL preserve `CheckUpstreamStatusOutput`, `LintAgentsFileOutput` and `CheckUrlStatusOutput` with
no discriminant and `ReadRepoFileOutput` discriminating on `found`, and SHALL annotate
`RedactClientDocumentOutput` as donor-only and **not** part of the deployed contract
SO THAT the frozen set is not padded with a shape that no live tool emits.

**FR-WIRE-06** `[NN-45]`
WHEN a change would alter any frozen output shape
THE `wire-contract` golden comparison
SHALL fail the build
SO THAT a Custom Agent consuming a deployed tool cannot be broken by a cleanup.

**FR-WIRE-07** `[NN-44]`
WHEN new code returns an internal error
THE `Result<T, PlatformError>` envelope
SHALL discriminate on `ok` and SHALL NOT introduce a `success` field
SO THAT the internal envelope can never be mistaken for the frozen wire envelope.

**FR-WIRE-08** `[NN-45 (corrected), NN-06]`
WHEN a live-only tool's reconstructed output type cannot be established with confidence from the
compiled module — for example an optional-versus-required field that the compiled code never
distinguishes
THE reconstruction
SHALL record the field as unresolved in `FIDELITY.json` rather than guessing, and the golden SHALL
mark that shape provisional
SO THAT an inferred contract is never presented as a verified one.

### Secrets and environments

**FR-SEC-01** `[NN-16]`
WHEN any command needs a credential
THE process
SHALL read it from the environment injected by `op run --environment <id>` and SHALL never invoke
`op read` or write a real secret to `.env`
SO THAT no secret is materialised on disk or in a subshell.

**FR-SEC-02** `[NN-17, NN-18]`
WHEN an as-code command starts
THE `loadAsCodeEnv()` constructor
SHALL scan `process.env` for any workers-Environment key and, if one is present, exit non-zero with
its documented code, naming the offending key on stderr
SO THAT the two-Environment separation is mechanically enforced rather than conventional.

**FR-SEC-03** `[NN-18]`
WHEN the cross-contamination guard triggers
THE CLI
SHALL exit non-zero and SHALL NOT offer any flag that downgrades it to a warning
SO THAT the guard cannot be argued past under time pressure.

**FR-SEC-04** `[NN-17]`
WHEN the as-code transport authenticates
THE transport
SHALL use the personal access token from the as-code Environment and SHALL reject an
integration/bot token with a structured error
SO THAT the only auth mode the endpoint supports is the only one attempted.

**FR-SEC-05** `[NN-21]`
WHEN `adopt` or `apply` is about to write a real Notion record id under `state/`
THE repository-visibility guard
SHALL confirm through its port that the `origin` repository is private and refuse otherwise
SO THAT primary-workspace record IDs are never committed to a public repo.

**FR-SEC-06** `[NN-19]`
WHEN any CI job runs
THE workflow
SHALL declare no repository secrets and SHALL require neither `op` nor a Notion token
SO THAT the runner cannot leak a credential it never holds.

**FR-SEC-07** `[NN-20]`
WHEN a dependency that fetches secrets at runtime is proposed
THE review gate
SHALL reject it and require `op run` injection instead
SO THAT no service-account token is introduced that would itself need a bootstrap path.

### CI gates

**FR-CI-01** `[Definition of Done, NN-01, NN-02]`
WHEN a pull request is opened
THE CI workflow
SHALL run `typecheck`, `fidelity`, `test`, `lint`, `env-parity` and `freeze-guard`, block merge on
the first five, and surface `freeze-guard`'s failure as the standing signal that the freeze is
active rather than as a merge block
SO THAT the freeze is visible on every run without making the repository unmergeable for months.
*(See Open Question 3 — the constitution states both "all seven gates must be green" and that
`freeze-guard`'s failure is the intended steady state; this requirement resolves the tension one
way and needs confirmation.)*

**FR-CI-02** `[Definition of Done 1, NN-42]`
WHEN the typecheck job runs
THE job
SHALL invoke `tsc -b` over all project references under npm
SO THAT a cold cross-package typecheck resolves project references, which `tsc --noEmit` alone
cannot.

**FR-CI-03** `[Stack, Phase-2 override 4]`
WHEN the test job runs
THE job
SHALL install with `npm ci` and execute `bun test` at the exact pinned Bun version, using `bun:test`
and `node:` stdlib only
SO THAT npm remains the lockfile authority while Bun is only the runner.

**FR-CI-04** `[NN-09, NN-59]`
WHEN the lint job runs
THE job
SHALL run `eslint --max-warnings 0` with `packages/workers/src` in `globalIgnores()` and
`prettier --check` with `tests/golden/` in `.prettierignore`
SO THAT sealed source is never autofixed and golden bytes are never reformatted out from under a
byte comparison.

**FR-CI-05** `[NN-10, intake]`
WHEN the env-parity job runs
THE job
SHALL assert that the key lists in `.env.example` (20), `.env.1p` (18 `op://` pointers) and
`scripts/deploy.sh`'s `WORKER_ENV_KEYS` (18) are identical as sets, and SHALL fail while any of the
16 further variables the canonical generation needs is absent from all three
SO THAT the measured drift is closed rather than tolerated.

**FR-CI-06** `[NN-58, NN-57]`
WHEN the weekly drift cron runs
THE job
SHALL compare the SHA-256 of the upstream `types.d.ts` against `PROVENANCE.json` and fail on
mismatch
SO THAT Layer-A drift is detected without a human remembering to look.

**FR-CI-07** `[NN-60]`
WHEN a pull request adds or bumps a dependency
THE receipt check
SHALL fail unless `context7-receipts.md` gained a receipt or a receipt-equivalent in the same change
SO THAT NN-60 is a merge precondition rather than a habit.

**FR-CI-08** `[NN-40]`
WHEN the purity check runs
THE CI grep
SHALL fail if `process.`, `fetch(`, `child_process` or `node:fs` appears outside `*/src/adapters/`
in `core`, `notion-port`, `ascode` or `cli`
SO THAT the pure core / I-O edge boundary is enforced by a machine rather than by review.

**FR-CI-09** `[Phase-2 blocking breakage]`
WHEN CI checks out the repository
THE workspace check
SHALL fail if root `package.json` declares no `workspaces` field
SO THAT `packages/workers` cannot silently remain orphaned from the workspace graph.

**FR-CI-10** `[Phase-3 defect, NN-03]`
WHEN CI checks out the repository
THE gitignore check
SHALL fail if `.gitignore` contains `packages/workers/src/_core/`
SO THAT the superseded copy-in pattern cannot be resurrected and silently change a verified emit.

**FR-CI-11** `[NN-19, NN-14]`
WHEN any CI job executes a test
THE test
SHALL reach no network endpoint outside the in-process fake server
SO THAT the offline guarantee that makes NN-19 safe is verified rather than assumed.

### Codegen and templates

> This is the thinnest group in the draft — Phases 1–3 named templating as an intent but locked no
> template set, no local-key naming scheme, and no decision on whether templates are data or code.
> See Open Question 8.

**FR-GEN-01** `[NN-48, NN-36]`
WHEN `init <template>` scaffolds a definition module
THE generator
SHALL emit TypeScript that declares records only through the recorder's `Ref`-returning helpers
SO THAT a scaffolded definition cannot hand-write a Notion ID.

**FR-GEN-02** `[NN-29, NN-37]`
WHEN a template is instantiated
THE generator
SHALL require a caller-supplied slug that becomes part of every emitted intent's stable local key
SO THAT two instantiations produce distinct state pointers instead of colliding on one.

**FR-GEN-03** `[NN-58, NN-59]`
WHEN a template is added or changed
THE golden suite
SHALL gain a committed compiled `intents.json` for it and one Layer-C fixture per intent type it
emits
SO THAT contract coverage grows with the template set rather than lagging it.

**FR-GEN-04** `[NN-54]`
WHEN a tool-registration schema is authored for a worker, after the freeze lifts
THE author
SHALL use the `j` helper for that registration only, and SHALL NOT use it for any as-code intent
schema
SO THAT the Anthropic-intersect-OpenAI structured-output subset applies only where it is correct.

---

## Non-functional Requirements

Each cites its source in `project-constitution.md`. Nothing here is a functional requirement in
disguise; anything that could be phrased as EARS is above.

**Performance and throughput**
- All as-code traffic — `POST /v1/infra_as_code` and `GET /v1/async_tasks` together — is bounded by
  **one shared limiter at 5 requests/minute**. Whether polling actually consumes that budget is
  unverified; the shared limiter is the conservative default. `[NN-27]`
- The offline test suite performs **zero real-time sleeps**: the `Clock` fake is the only sleep
  implementation registered under test, so limiter backoff advances instantly. `[NN-49, NN-22]`
- No latency target is set for CLI commands. This is an on-demand operator tool whose wall-clock
  time is dominated by a 5 req/min platform budget; a latency SLO would be theatre. `[NN-41]`

**Security**
- Credentials reach the process **only** via `op run --environment`. `op read` is prohibited and
  hook-blocked. `[NN-16]`
- **Two** 1Password Environments, never both loaded into one process: the as-code personal access
  token, and the workers' database-ID keys (canonical Environment `i6ul2k6tk5kzyszv465wzhdpnu`).
  `[NN-17, NN-18]`
- **CI holds no secrets and needs none** — every test is offline, so the runner cannot leak a
  credential it never has. `[NN-19]`
- The 1Password JS SDK is **deliberately not used**; recorded as the canonical option not taken.
  `[NN-20]`
- The GitHub repository must be **private** before any `definitions/` or `state/` content is
  committed, because state files carry real primary-workspace record IDs. `[NN-21]`

**Data integrity**
- State is **committed source**, one file per space, reviewed as a diff. It is the entire
  duplicate-prevention mechanism; Notion as Code holds no server-side state. `[NN-29]`
- Pointers are **additive-only** at the type level; removal exists only via `state forget`.
  `[NN-30]`
- Write ordering is **journal + fsync before the POST**, raw response persisted verbatim before any
  mutation, atomic tmp + rename + fsync for the merge. `[NN-31]`
- A found journal **blocks every command** until a human resolves it. `[NN-32]`
- The apply lock is `O_EXCL` with **no TTL and no force-unlock**. `[NN-33]`
- Dirty-tree refusal on `state/` and `definitions/`, **no `--allow-dirty`**. `[NN-34]`
- `schemaVersion` is an integer; a reader refuses a file newer than it knows; migrations are never
  implicit. `[NN-35]`

**Reliability and recoverability**
- **There is no rollback** — not for workers (no versioning; redeploying prior source is the only
  mechanism, and that source does not exist), and not for as-code (no delete intent, no dry-run).
  The post-apply verify pass is the *compensating control*, and it detects rather than prevents.
  `[NN-01, NN-11, NN-13]`
- **Accepted residual risk:** server-side field normalisation can cause perpetual drift. It is
  detected by the verify pass and remedied by adding a canonicaliser rule, not prevented. `[Phase 3]`

**Observability**
- Structured logging to **stderr only**. No metrics, tracing, or uptime stack — an on-demand CLI has
  no uptime between runs for one to attach to. `[NN-41]`

**Compatibility and pinning**
- Node **>= 22**; TypeScript **5.9.3** for the sealed package; `NOTION_API_VERSION` pinned to
  **`2026-03-11`** at client construction, since `@notionhq/client@5.21.0` defaults to `2025-09-03`.
  `[Stack, NN-23]`
- `ntn` pinned **exactly** at `0.13.2` as a devDependency, because `ntn workers *` speaks a private,
  unversioned `/api/v3/` RPC surface. `[NN-24]`
- `date-fns@3.6.0` is **inherited, not vetted** — it carries no receipt and belongs to the fidelity
  PR's review scope. `[Stack]`

**Cost**
- Notion Workers stop being free on **2026-08-11** at **$0.0023/run**; a `"5m"` sync is roughly
  8,640 runs/month, about **$20/month**. No phase decided whether to keep, slow, or drop the
  scheduler sync — see Open Question 10. `[intake]`

**Quality bar**
- The project's quality bar is the **CI gates plus the 15-point Agentic CLI Design Scorecard**, not
  the TypeScript Design Principles Gate — which scopes down to P5/P6/P17 here and is near-vacuous.
  Citing a green Design Principles Gate as evidence of quality is explicitly disallowed. `[NN-62]`

---

## Open questions (for the human to resolve before / during SDD Phase 2 PLAN)

1. **Does `POST /v1/infra_as_code` accept an idempotency key?** If it does, the entire
   lost-response failure class collapses and FR-STATE-09 / FR-STATE-12 (NN-31 / NN-32) could be
   substantially simplified. Unverified; first thing to settle when alpha access lands. `[NN-31, NN-32]`
2. **Does polling `GET /v1/async_tasks` consume the 5 req/min `/v1/infra_as_code` budget?** One
   shared limiter (FR-ENG-11, FR-ENG-19) is the conservative default until measured. If polling is
   free, plan fan-out concurrency can rise materially. `[NN-27]`
3. **`freeze-guard` blocking semantics.** The constitution's Definition of Done says all seven gates
   must be green, while NN-01/NN-02's framing says `freeze-guard` failing is the intended steady
   state. FR-CI-01 resolves this as "runs and fails visibly, does not block ordinary merges, does
   block anything that would deploy." Confirm or overrule.
4. **NN-45 count correction.** The constitution should be amended to the deployed surface — 34
   `tool` registrations plus 5 non-tool capabilities — and `RedactClientDocumentOutput` annotated as
   donor-only rather than deployed contract. This draft is written against the corrected surface;
   the constitution has not yet been changed.
5. **Authority for the 10 reconstructed output types.** Deriving a shape from compiled JS plus a
   registration schema is *inference*, not an oracle: the compiled code frequently cannot
   distinguish optional from required, or a union arm that never executes on the sampled path.
   FR-WIRE-08 records unresolved fields rather than guessing, but the deeper question is whether
   capturing a real production worker output is permitted as an oracle — which would require
   running a live worker, currently under freeze.
6. **Repository-visibility guard mechanism (FR-SEC-05).** Confirming that `origin` is private
   requires a GitHub API call and a GitHub token, which belongs to neither of the two 1Password
   Environments and is not covered by any `NN`. Options: a `gh`-backed `Process` port call, a
   committed one-time attestation file, or a CI-only check. Undecided.
7. **Secret redaction in stderr logs.** No constitution constraint covers redacting secret-shaped
   values from structured diagnostics. Flagged rather than invented, per the role file. `[untraced]`
8. **The templating surface is under-specified.** Phases 1–3 named "template the workspace" as
   intent but locked no template set, no local-key naming scheme, and no decision on whether a
   template is data (JSON consumed by the recorder) or code (a TypeScript function). FR-GEN-01…04
   are the weakest requirements in this draft and should be treated as placeholders until this is
   decided.
9. **`ascode` collapse criterion.** NN-51 defers the decision: if by first apply `ascode` has no
   consumer other than `cli` *and* the adapters grep has never fired on an engine file, fold it into
   `cli` and drop to four packages. This is a scheduled re-evaluation, not a requirement, so it
   lives here rather than above. `[NN-51]`
10. **Worker cost decision after 2026-08-11.** Keep the `"5m"` scheduler sync at ~$20/month, reduce
    its frequency, or drop it? No phase decided, and it changes what recovery must preserve. `[intake]`
11. **`adopt` granularity.** Can `adopt` take a teamspace and walk its subtree in one invocation, or
    is it strictly one `RecordPointer` at a time? The decision log does not say, and the answer
    interacts with FR-ENG-11's rate-limit budget.
12. **The exit-code table itself.** FR-CLI-02 requires one and names its failure classes, but no
    phase enumerated the actual numeric values. They must be fixed before implementation, since
    FR-CLI-02 makes them a public contract.
13. **The 12 donor-only tools.** Declared out of scope here. Confirm that the `client-*` /
    `agent-ops` family is genuinely abandoned rather than "deployed elsewhere", because if any of
    them is live somewhere the wire-contract surface in FR-WIRE-01 is still incomplete.

---

## Draft self-critique (EARS compliance pass)

Walked every functional requirement above. All **111** are in `WHEN / THE / SHALL / SO THAT` form
with a named trigger, a named component, a testable behaviour and a stated reason.
Counts by group: CLI 7 · ARCH 11 · ENG 25 · STATE 13 · OBS 6 · AUDIT 6 · REC 13 · WIRE 8 ·
SEC 7 · CI 11 · GEN 4.

Items rejected during the pass rather than dressed up as criteria:

- *"The constitution's NN-45 count should be corrected."* — a documentation action, not system
  behaviour. Moved to the Correction section and to Open Question 4.
- *"Evaluate the `ascode` collapse criterion at first apply."* — a scheduled human review with no
  trigger the system can detect. Moved to Open Question 9.
- *"Secrets must be redacted from logs."* — no constitution trace, and no phase decided the
  detection rule. Moved to Open Question 7 as `[untraced]` rather than invented here.
- *"The CLI should be fast."* — rejected outright. Replaced by the two measurable Non-functional
  statements that actually bind: the 5 req/min shared limiter, and zero real-time sleeps under test.
- *"Templates should be ergonomic."* — rejected; unmeasurable. The group was reduced to four
  criteria that are testable and the thinness flagged in Open Question 8.

Weakest areas of this draft, in order: **codegen/templates** (Open Question 8 — the decision log is
genuinely thin), **the reconstructed wire types' authority** (Open Question 5 — inference is being
asked to stand in for an oracle), and **FR-SEC-05's mechanism** (Open Question 6 — the constraint is
locked but the means is not).
