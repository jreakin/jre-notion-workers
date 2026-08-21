# project-constitution.md
## Project: Notion Platform Tool (`jre-notion-workers`)
## Created: 2026-07-26

> Formalized by Phase 4 of `abstract-data-spec-brainstorm` from the APPROVE-locked decisions in
> `docs/spec/notion-platform-tool/brainstorm-intake.md` (Phases 1, 2 and 3, all locked 2026-07-26).
> This is a constitution, not a task list. Nothing here gets checked off.
>
> **Source tags.** Every non-negotiable carries where it came from:
> `[intake]` = human-stated constraint or session-verified platform fact ·
> `[Phase 1]` / `[Phase 2]` / `[Phase 3]` = locked decision ·
> `[JS/TS Base]` = implied by the selected AGENTS.md base template.
> A constraint with no source does not belong in this file.
>
> **Scope note.** The human elected (recorded in the intake) to treat the platform tool as **new
> scope** and run the full brainstorm rather than hand off to `project-alignment` first. Repo
> alignment proceeds as a separate, non-blocking track. This is therefore the full constitution,
> not an evergreen addendum — the repo has no root-level `project-constitution.md` to extend.

---

## Stack (immutable)

- **Language:** TypeScript 5.x — fidelity-locked at `typescript@5.9.3` for the sealed workers
  package. Single language across all three surfaces (CLI/REST, Workers, as-code). Not a split.
  `[Phase 1]`
- **Runtime:** Node.js **>= 22**. `[intake]` `[Phase 1]`
- **Package manager:** **npm** is the lockfile authority (`npm ci` in CI), with **npm workspaces**.
  **Bun is the test runner only**, pinned exactly (`1.3.11` in CI and in `packageManager`) —
  no LTS-range policy. `[Phase 1]` `[Phase 2]`
- **Framework:** **none.** This is a local CLI / operator tool. `@notionhq/workers@0.4.0` is a
  platform SDK, not an application framework. `[Phase 2]`
- **CLI argument parsing:** `node:util` **`parseArgs`** (Node 22 stdlib) plus a hand-rolled
  command registry. No third-party CLI framework. `[Phase 2]`
- **Runtime validation:** **ajv 8.18.0 + ajv-formats 3.0.1**, promoted transitive -> direct.
  One shared instance: `new Ajv({ allErrors: true, discriminator: true, strict: true })`.
  `[Phase 2]`
- **Build:** **`tsc` only** — `tsc -b` over project references. No bundler anywhere, for the CLI
  or for workers. `[Phase 2]`
- **Data layer:** **none.** Notion is the system of record; local state is a committed JSON file.
  `[Phase 2]`
- **Lint / format:** ESLint 9 flat config + typescript-eslint `recommended` (syntax-only, *not*
  type-checked) + Prettier 3, scoped to the new packages. `[Phase 2]`
- **Package layout (5 workspaces):** `workers` (sealed, untouched) · `core` (pure) ·
  `notion-port` (the only package that constructs `@notionhq/client`) · `ascode` (the engine) ·
  `cli` (registry and sole composition root). Direction:
  `cli -> ascode -> notion-port -> core`; `cli -> notion-port -> core`; **nothing -> `workers`**
  (`cli --import type--> workers`). `[Phase 3]`
- **Deploy target:** Workers deploy manually via `scripts/deploy.sh` under `op run` — and is
  **frozen** (see NN-01). The CLI has no deploy target. No deploy workflow in CI. `[Phase 2]`
- **Secrets:** 1Password Environments via `op run --environment`, two separate Environments.
  `[intake]` `[Phase 2]`
- **Fidelity-locked pins inherited from the canonical generation (not re-decided here):**
  `@notionhq/client@5.21.0`, `@notionhq/workers@0.4.0`, `typescript@5.9.3`, `esbuild@0.27.4`,
  `ntn@0.13.2`, `date-fns@3.6.0`. `date-fns` is explicitly **inherited, not vetted** — it carries
  no receipt and belongs to the fidelity PR's review scope. `[intake]` `[Phase 2]`
- **Net-new third-party packages introduced by this brainstorm: three** — `eslint`,
  `typescript-eslint`, `prettier`. Everything else is a promotion, a pin, a committed file, or
  Node stdlib. `[Phase 2]`

---

## Non-negotiable constraints

<!-- Every prohibition below carries its paired alternative on the same line. -->

### A. The deploy freeze and the fidelity seal

**NN-01 — The deploy freeze is in force until the lost worker generation is recovered.** `[intake]`
The reason is not caution, it is arithmetic: the repo's committed root `dist/` is a 34-tool build
**whose TypeScript was never committed**, and *that sourceless generation is what is deployed* —
some of its 13 unique tools are live in production. Notion Workers have **no versioning and no
rollback**; redeploying prior source is the only rollback mechanism that exists, **and that source
does not exist.** A deploy today is therefore irreversible by construction. Recovery's purpose is
not tidiness; it is to restore the ability to roll back.
🚫 Never deploy a worker while the freeze marker exists — ✅ transcribe the outstanding tools from
`dist/` until fidelity is proven, then cut over with a **no-op deploy** of a tree already shown
token-identical to what is running.

**NN-02 — The `deploy` npm script is deleted for the duration of the freeze.** `[Phase 3]`
A missing script is a stronger guard than a documented prohibition or a CI job, neither of which
stops a local invocation.
🚫 Never re-add a `deploy` script "temporarily" to run one thing — ✅ invoke `scripts/deploy.sh`
by explicit path, under `op run`, only in the commit that lifts the freeze.

**NN-03 — `packages/workers` is sealed. No runtime import crosses into it, in either direction.**
`[Phase 2]` `[Phase 3]` A bundler, a path alias, or a cross-package runtime import changes the
emit and destroys the only evidence of what is running in production.
🚫 Never import a runtime value across the workers boundary — ✅ let **types** cross (they erase),
and duplicate the ~10-line `toWorkerOutput` boundary adapter *inside* the sealed package. Honest
duplication across an intentional seal beats a runtime import that breaks fidelity.
Enforced by `verbatimModuleSyntax` in the new packages plus a CI check that `packages/workers/src`
has zero imports resolving outside itself.

**NN-04 — Fidelity is verified by plain `tsc` emit comparison against the committed sourceless
build.** `[Phase 2]` The `fidelity` job is a **required check** and is the mechanical guard on
the freeze.
🚫 Never introduce a bundler or path alias that alters the workers emit — ✅ keep the workers
build a plain `tsc` invocation, and resolve the compiler via
`createRequire(import.meta.url).resolve("typescript/bin/tsc")` rather than a hard-coded
`node_modules/.bin/tsc` path that does not survive workspaces hoisting.

**NN-05 — `packages/workers/tsconfig.json` receives no changes at all.** `[Phase 3]`
No `composite`, no `verbatimModuleSyntax`, no project references. The seal is one-directional:
workers *exports* `./types` and imports nothing new, so it needs no edit.
🚫 Never "just add `composite: true`" to make project references tidy — ✅ leave the file byte-
identical and let `cli` consume workers' types through a plain type-only import.

**NN-06 — Lane C (`new`, no `dist/` oracle) files are forbidden in `packages/workers` while the
freeze holds.** `[Phase 3]` The three-lane manifest lives in machine-readable
`packages/workers/FIDELITY.json`: **A `recovered`** (transcribed from `dist/`, token-identical),
**B `ported-and-proven`** (donor source as transcription *hint*, `dist/` as the oracle),
**C `new`** (no oracle).
🚫 Never add an unverifiable file to the sealed package — ✅ land new behaviour in `core`, `ascode`
or `cli`, where it is testable, and bring it into `workers` only after the freeze lifts.
CI asserts: every `src/` file appears in the manifest, no lane downgrades, and the verified count
never decreases.

**NN-07 — The nested `jre-notion-workers/` generation is a frozen, read-only donor.** `[Phase 3]`
`packages/workers` is the destination. Porting the 21 both-generations tools is **recovery, not
rewrite**. The canonical generation already migrated the 25 deprecated `notion.databases.query`
call sites and the result is compiled into root `dist/`.
🚫 Never rewrite a tool that has a `dist/` oracle — ✅ transcribe against the oracle, because a
rewrite has nothing to fidelity-verify against and can never be proven equivalent.

**NN-08 — The 22 catalogued behavioural bugs stay unfixed while their file is fidelity-locked.**
`[intake]` `[Phase 3]` They carry IDs `REC-01`…`REC-22` and get **characterisation tests
asserting the buggy behaviour, written now**.
🚫 Never fix a catalogued bug as a drive-by — ✅ fix bug N, flip that file to Lane C, and update
its characterisation test **in one atomic commit**, so losing the fidelity proof is visible in the
same diff as the fix.

**NN-09 — ESLint does not lint `packages/workers/src` while the freeze holds.** `[Phase 2]`
Listed in `globalIgnores()` (a v9-only helper — global ignores can match directories, non-global
`ignores` cannot). Reverts when the freeze lifts.
🚫 Never let a lint autofix touch sealed source — ✅ keep the exclusion in `globalIgnores()` and
lint the new packages at `--max-warnings 0`.

**NN-10 — `scripts/deploy.sh` must fail closed on any unresolved `WORKER_ENV_KEYS` entry.**
`[Phase 3]` Today it fails **open** — its push loop is `if [[ -n "$val" ]]` and it errors only
when *every* key is absent. That is the highest-severity latent defect in the repo: a deploy would
silently push a partial environment to live workers that cannot be rolled back.
🚫 Never let a missing key be skipped silently — ✅ abort the whole deploy on the first key that
does not resolve, and keep the `env-parity` CI job as the *separate* check that the key **lists**
agree. Both are required; neither substitutes for the other.

### B. As-code apply safety

**NN-11 — No automated as-code apply. Ever.** `[intake]` `[Phase 2]` There is no scratch
workspace, no delete intent, and no server-side plan or dry-run. The target is the maintainer's
**primary workspace** and every mistake is manual cleanup.
🚫 Never let CI, a cron, a test, or an agent invoke `apply` — ✅ the first and every real apply is
a human at a terminal, passing the explicit guard flag and typing the confirmation. The offline
contract test stops at `plan`.

**NN-12 — `apply` consumes a saved, hash-verified plan artifact.** `[Phase 3]`
`plan -o <file>` writes it; `apply --plan <file>` verifies its hash before acting. This closes the
approve-P / execute-P′ TOCTOU.
🚫 Never re-derive the plan inside `apply` — ✅ read the artifact the human actually reviewed, and
refuse if its hash does not match.

**NN-13 — Every apply runs a post-apply verify pass** reporting confirmed / drifted /
unverifiable. `[Phase 3]` This is the compensating control for having no rollback.
🚫 Never treat a 2xx task response as proof the workspace is correct — ✅ read the affected
records back and report what could not be confirmed.

**NN-14 — As-code apply is feature-flagged, and the full build -> validate -> plan pipeline must
run entirely offline while alpha access is pending.** `[intake]` `[Phase 2]`
🚫 Never make a test or a CI job require live as-code access — ✅ run the pipeline against the fake
`SupportedFetch` server, whose error fixtures come from Layer-B captures.

**NN-15 — Applies target the primary workspace only, guarded.** `[intake]` The `GuardedTarget`
brand is minted solely by `resolveTarget()`, which matches the workspace id against a live
`whoami` — the compile-time brand is paired with that runtime re-check.
🚫 Never accept a workspace target from a config file alone — ✅ resolve it against live `whoami`
on every run, since brands erase at runtime.

### C. Secrets

**NN-16 — Secrets flow only through 1Password Environments via `op run --environment`.**
`[intake]` `[JS/TS Base]`
🚫 Never call `op read`, and never write a real secret to `.env` — ✅ launch the process
under `op run --environment`, with `.env.1p` holding `op://` pointers only. `op read` is
prohibited and hook-blocked.

**NN-17 — Two separate 1Password Environments.** `[intake]` The as-code **personal access token**
(as-code authenticates with a PAT, *not* an integration/bot token) lives in a different
Environment from the workers' database-ID keys. Canonical workers Environment:
`i6ul2k6tk5kzyszv465wzhdpnu`.
🚫 Never load both Environments into one process — ✅ pick exactly one per invocation, chosen by
which surface the command belongs to.

**NN-18 — The cross-contamination guard is mandatory.** `[Phase 2]` An as-code command **refuses
to run** if any workers-Environment key is present in `process.env`. This is the only *mechanical*
enforcement of NN-17; without it the separation is a convention that erodes on first misuse.
🚫 Never downgrade the guard to a warning — ✅ exit non-zero with a documented code and name the
offending key on stderr.

**NN-19 — CI holds no secrets and needs none.** `[Phase 2]` Every test is offline, so the runner
never needs `op` or a PAT and therefore cannot leak one.
🚫 Never add a repository secret to make a test "more realistic" — ✅ extend the fake as-code
server with a captured fixture instead.

**NN-20 — The 1Password JS SDK is not used**, despite being canonical in DEV-ENV-INDEX. `[Phase 2]`
It needs a service-account token — itself a secret requiring its own bootstrap path — and adds a
runtime dependency to a CLI a human already invokes from a shell. Recorded as the canonical option
deliberately not taken.
🚫 Never add a programmatic secrets-fetch dependency — ✅ let `op run` inject the environment from
outside the process.

**NN-21 — The GitHub repo must be private before any as-code definitions or state are
committed.** `[intake]`
🚫 Never commit `definitions/` or `state/` to a public repo — ✅ flip visibility first; the state
files carry real Notion record IDs for the primary workspace.

### D. Notion clients and the platform's hard limits

**NN-22 — `retry: false` on every Notion client.** `[Phase 3]` The SDK's `retry` defaults **ON**
with `maxRetries: 2` and **real timers**, which would make the `Clock` port a lie and tests
non-deterministic.
🚫 Never leave SDK retry at its default — ✅ set `retry: false` and implement backoff in the
`Clock`-driven limiter, where a fake clock can advance it instantly.

**NN-23 — Pin the API version: `NOTION_API_VERSION=2026-03-11`.** `[intake]` The default is
fetched live and can shift, and `@notionhq/client@5.21.0`'s own `defaultNotionVersion` is
`2025-09-03` — one generation behind the target. This is a measured fact, not a hypothetical.
🚫 Never rely on the SDK's default `notionVersion` — ✅ pass the pinned version explicitly at
client construction.

**NN-24 — Pin `ntn` as an exact devDependency: `"ntn": "0.13.2"`.** `[intake]` `[Phase 2]`
`ntn workers *` speaks a **private, unversioned `/api/v3/` RPC surface**. It is currently pinned
nowhere in any `package.json` in the repo, despite being an intake constraint.
🚫 Never use a range or a globally-installed `ntn` — ✅ pin the exact version in `devDependencies`
so the private RPC surface cannot shift underneath a deploy.

**NN-25 — Never parse `ntn doctor`; it writes to stderr and always exits 0.** `[intake]` `[Phase 3]`
🚫 Never shell out to `ntn doctor` for a health signal — ✅ use `ntn whoami --json` as the auth
probe, through the `Ntn` port — which **has no `doctor()` method at all**, making the violation
unstatable rather than merely documented.

**NN-26 — The as-code transport is built on the public `Client.request<T>({ path, … })`.**
`[Phase 3]` It accepts an arbitrary path, so base URL, API version, auth and `APIResponseError`
narrowing have exactly one implementation.
🚫 Never hand-roll a second HTTP client for `/v1/infra_as_code` — ✅ route it through
`Client.request()`, and reach response headers and verbatim 4xx bodies through the injected
`fetch` port, which is the only place they are visible.

**NN-27 — One shared rate limiter across `/v1/infra_as_code` and `/v1/async_tasks`, at
5 requests/minute.** `[intake]` `[Phase 3]` Whether polling consumes the same budget is
**unverified**; one shared limiter is the conservative default until it is settled.
🚫 Never give polling its own budget on the assumption it is free — ✅ semaphore all as-code
traffic through the one limiter, driven by the `Clock` port.

**NN-28 — `custom_agent` cannot bind Worker tools, and as-code cannot create a space.** `[intake]`
Agent-to-tool wiring is permanently manual; the intent union is exactly
`space | teamspace | database | page | view | file_attachment | custom_agent`, and page content is
Notion-flavored **Markdown strings, not block objects**.
🚫 Never model agent-to-tool wiring as an as-code intent — ✅ document it as a manual post-apply
step in the plan output, so the human sees what the tool cannot do for them.

### E. State is precious

**NN-29 — State is committed: `state/<space-slug>.json`, one file per space, with a `space`
header** guarding against a wrong-workspace apply. `[Phase 3]` Notion as Code has **no server-side
state** — the client-supplied `existingResources` / `existingProperties` mapping is the only thing
standing between a re-apply and a duplicated workspace.
🚫 Never gitignore or regenerate the state files — ✅ commit them and review their diffs like
source, because they are the entire duplicate-prevention mechanism.

**NN-30 — Pointers are additive-only.** `[Phase 3]` The merge function's *type* has no removal
path.
🚫 Never delete a pointer during a merge — ✅ remove one only through the explicit `state forget`
command, which exists precisely so removal is a deliberate, named act.

**NN-31 — Journal before the POST, fsync before the POST.** `[Phase 3]` The dangerous window is
**send -> first-response**, not response -> merge: a POST that succeeded with a lost response is
indistinguishable from one that never landed.
🚫 Never send an as-code POST with nothing durable on disk — ✅ write and fsync
`{ planHash, requestBody }` first, persist the raw task response **verbatim** before any state
mutation, and merge with atomic tmp + rename + fsync.

**NN-32 — A found journal blocks every command.** `[Phase 3]`
🚫 Never auto-recover or auto-discard a journal — ✅ refuse to proceed and make the human resolve
it, since only they can check the workspace and decide whether the POST landed.

**NN-33 — The apply lock is `O_EXCL` and never auto-expires.** `[Phase 3]` Auto-expiry is exactly
how two concurrent applies happen.
🚫 Never add a lock TTL or a `--force-unlock` convenience — ✅ require a deliberate manual removal
after the human has confirmed no apply is in flight.

**NN-34 — Refuse to apply from a dirty working tree, with no escape hatch.** `[Phase 3]`
Dirty-tree refusal covers `state/` and `definitions/`.
🚫 Never add `--allow-dirty` — ✅ commit or stash first, so the plan that was reviewed and the
definitions that were applied are the same reviewable git object.

**NN-35 — `schemaVersion` is an integer; a reader refuses a file newer than it knows; migrations
are explicit and never implicit during `apply`.** `[Phase 3]`
🚫 Never migrate state as a side effect of an apply — ✅ fail with a clear message pointing at the
explicit migration command, and run it as its own reviewed commit.

**NN-36 — Referential closure is checked twice, and `plan` accepts only a
`ClosedIntentDocument`.** `[Phase 3]` Authoring-time by construction (`database()` returns an
opaque `Ref<'database'>`; `view()` takes a `Ref`, not a string, so an undeclared reference is
unconstructible) and validate-time as a pure graph walk over the wire format, **before the first
network call**.
🚫 Never accept a raw string where a `Ref` is expected — ✅ mint references through the recorder,
and re-walk the closure on the deserialised document because brands do not survive JSON.

**NN-37 — Create-vs-update comes from the state pointer, never from the diff.** `[Phase 3]`
Pointer present -> update; absent -> create. All duplication risk therefore concentrates in one
place, the state model, where it can be defended.
🚫 Never infer "this must be new" from an empty diff — ✅ look up the pointer, because the same
canonicaliser runs on **both** sides of the diff, so a canonicaliser bug cancels out and biases
toward **under**-reporting change (recoverable) rather than over-reporting it (duplication).

**NN-38 — `verified` vs `unverifiable` is derived from `observe` coverage, never authored.**
`[Phase 3]` Permanently unverifiable: page content (lossy markdown -> blocks server transform),
`custom_agent` internals, view config beyond `/v1/views`, and anything evidenced only by the
`createdRecordCounts` aggregate.
🚫 Never hand-mark a record verified — ✅ let the label fall out of whether `observe()` can read it
back, so nothing can claim verification it cannot demonstrate.

**NN-39 — `plan` and `adopt` are two compositions of one primitive, `observe(pointer)`** — the
sole producer of `ObservedIntent`, whose constructor is not exported. `[Phase 3]`
🚫 Never give `adopt` its own read path — ✅ compose both from `observe`, so they are structurally
incapable of diverging.
Acceptance: `adopt -> plan` must be a fixpoint (empty) for every fixture, and `apply -> re-plan`
must converge to empty.

### F. Architecture and code shape

**NN-40 — Pure core / I-O edge.** `process.*`, `fetch`, `child_process` and `node:fs` appear
**only** in `*/src/adapters/`, enforced by a CI grep. `[Phase 3]`
🚫 Never reach for `process.env` or `fetch` inside engine or domain code — ✅ inject the `Clock`,
`HttpFetch`, `FileStore`, `Process`, `Git` or `Ntn` port, all of which have fakes.

**NN-41 — `core` and `cli` are console-free.** `[JS/TS Base]` `[Phase 2]` Observability is
**structured logging to stderr only** — an on-demand CLI has no uptime between runs, so there is
nothing for a metrics or tracing stack to attach to.
🚫 Never call `console.log` in `core` or `cli` — ✅ emit machine-readable results to **stdout** and
structured diagnostics to **stderr**, through the logging port.

**NN-42 — `cli` is the sole composition root, and dependency direction is enforced at compile
time** by `tsc` project references. `[Phase 3]`
🚫 Never construct a client or an adapter outside the composition root — ✅ wire it once in `cli`
and pass ports down.

**NN-43 — `notion-port` is the only package that constructs `@notionhq/client`.** `[Phase 3]`
🚫 Never `new Client()` in `core`, `ascode` or `cli` — ✅ take the already-configured client
through `notion-port`, so NN-22 and NN-23 hold in exactly one place.

**NN-44 — New code uses `Result<T, PlatformError>` in `core`, discriminated on `ok`.** `[Phase 3]`
Deliberately **not** `success`, so the internal envelope can never be mistaken for the frozen wire
envelope. `PlatformError.path` is ajv's `instancePath` JSON Pointer.
🚫 Never throw across a package boundary in new code — ✅ return a `Result` and convert at the two
boundary adapters.

**NN-45 — The 33 deployed worker output shapes are contract and are snapshotted as-is.**
`[Phase 3]` That is **28** copy-pasted `{ success: false }` arms plus **five** non-conforming
outputs: `CheckUpstreamStatusOutput`, `LintAgentsFileOutput`, `CheckUrlStatusOutput` and
`RedactClientDocumentOutput` carry no discriminant, and `ReadRepoFileOutput` discriminates on
`found`. All five are deployed contract.
🚫 Never "clean up" a frozen output shape to match the new `Result` envelope — ✅ leave it exactly
as deployed and protect it mechanically by golden-comparing the emitted
`dist/shared/types.d.ts` against `tests/golden/wire-contract.d.ts`.

**NN-46 — The check is the constructor, and every brand is paired with a runtime re-check.**
`[Phase 3]` `ObservedIntent` <- `observe()`, `ClosedIntentDocument` <- `checkClosure()`,
`ApprovedPlan` <- `confirmApply()`, `GuardedTarget` <- `resolveTarget()`,
`AsCodeEnv` <- `loadAsCodeEnv()`.
🚫 Never cast into a branded type to get past the compiler — ✅ call the constructor, and keep the
paired runtime re-check (plan-hash re-verification, closure re-walk on the deserialised document,
workspace-id match against live `whoami`), because brands erase at runtime. Two layers, stated as
two.

**NN-47 — The intent recorder is `AsyncLocalStorage`-scoped, never a module-level global.**
`[Phase 3]` The decisive reason is test isolation: a module global would depend on resetting the
ESM module cache.
🚫 Never hold recorder state in a module-level variable — ✅ scope it per build with
`node:async_hooks`, and **cache-bust the definition loader** (`import(url + '?b=' + nonce)`) or a
second import in one process silently records nothing.

**NN-48 — References to pre-existing records are `AdoptedRef`, minted only by the state loader
from a real `RecordPointer`.** `[Phase 3]`
🚫 Never hand-write a Notion ID into a definition file — ✅ adopt it into state first, then
reference the `AdoptedRef` the loader mints.

**NN-49 — `NOTION_API_BASE_URL` is a first-class config seam, and `Clock` (`now()` / `sleep()`) is
a port.** `[Phase 2]` `baseUrl` is documented by the SDK itself as the mock-server mechanism, so
this is the intended path, not an improvisation. Without the seam the fake server is unreachable
and the whole offline pipeline is untestable; without the `Clock` port the 5 req/min limiter makes
tests sleep in real time.
🚫 Never hard-code the API base URL or call `setTimeout` directly — ✅ read the configured base URL
and advance a fake clock.

**NN-50 — Test doubles are interface implementations, not shell scripts.** `[Phase 3]` The fake
`ntn` implements the `Ntn` port; the fake as-code server is written as a `SupportedFetch` function
first, with the `node:http` server as a thin adapter around it.
🚫 Never put a fake binary on `PATH` for a test — ✅ implement the port, so the double is
type-checked against the same interface production uses.

**NN-51 — The `ascode` package carries a recorded collapse criterion.** `[Phase 3]` Self-identified
as possible ceremony for a solo maintainer. **If, by first apply, `ascode` has no consumer other
than `cli` *and* the adapters grep has never fired on an engine file, fold it into `cli` and drop
to four packages.** Two costs are named and accepted meanwhile: project references require
`tsc -b` before a cold cross-package typecheck, and **each package needs a `"bun"` export
condition pointing at `src/index.ts`** or Bun resolves a stale `dist/` and the golden tests
validate the wrong build.
🚫 Never let the fifth package survive on inertia — ✅ evaluate the criterion at first apply and
collapse it if it is met.

### G. Agent-consumable contract, schemas, and provenance

**NN-52 — Every command is agent-consumable.** `[intake]` `[Phase 1]` `--json` on **stdout**,
diagnostics on **stderr**, documented non-zero exit codes, TTY detection. The **15-point Agentic
CLI Design Scorecard** binds regardless of language and is carried into TypeScript explicitly —
this is the condition on which the human approved diverging from the Python/Typer house playbook.
🚫 Never mix human prose into the `--json` stdout stream — ✅ keep stdout machine-parseable and put
every human-facing word on stderr.

**NN-53 — The `commands --json` catalog *is* the registry.** `[Phase 2]` A hand-rolled registry
makes the catalog structurally incapable of drifting from the implementation, whereas reflecting
over a framework's internal AST can silently diverge. This is the reason `parseArgs` needed no
override: it is the better answer, not a concession.
🚫 Never maintain a second, hand-written list of commands — ✅ generate the catalog from the
registry object the dispatcher already uses.

**NN-54 — `j` is for tool registrations only; as-code intents use plain JSON Schema.** `[Phase 2]`
`@notionhq/workers`' `json-schema.d.ts` enforces at the type level: no recursive schemas, all
object properties required, `additionalProperties: false`, no string/number constraints, no
`allOf` / `not` / `if` / `then` / `else`. That is the Anthropic-intersect-OpenAI structured-output
intersection — correct for the 34 tool registrations, wrong for nested intents with genuinely
optional fields and Notion-ID `pattern` validation.
🚫 Never author an as-code intent schema with `j` — ✅ write plain JSON Schema and feed it to the
same single ajv instance. One instance, two authoring styles.

**NN-55 — Validate narrowly, at exactly three boundaries.** `[Phase 2]` (1) the intent
discriminator (`discriminator: true` + `oneOf`); (2) `existingResources` / `existingProperties` —
validated hard, **including a referential-closure graph walk that is not a schema check**;
(3) the `/v1/infra_as_code` and `/v1/async_tasks` envelopes.
🚫 Never re-express the 1,998-line intent type surface as runtime schema — ✅ let Notion's server
be the authoritative validator and spend client-side validation where it prevents an
unrecoverable mistake.

**NN-56 — Zod is not used.** `[Phase 2]` It is a genuinely new dependency, and inferring types
from schema would put it in competition with the vendored `types.d.ts` for source-of-truth,
guaranteeing drift.
🚫 Never add a second schema/validation library — ✅ use the one ajv instance, whose
`ErrorObject.instancePath` is already a JSON Pointer and maps one-to-one onto the scorecard's
structured-error requirement.

**NN-57 — The vendored `types.d.ts` stays byte-verbatim, with `PROVENANCE.json` beside it.**
`[Phase 2]` Provenance records upstream repo, commit SHA, path, `retrievedAt`, `sha256`, and the
corresponding `notionApiVersion`.
🚫 Never edit the vendored file, even to fix an obvious error — ✅ put corrections in a sibling
`overrides.d.ts`, so the drift hash never goes stale for a local reason.

**NN-58 — Three-layer drift detection, and Layer B is the one that matters.** `[Phase 2]`
Layer A: weekly CI SHA-256 of upstream `types.d.ts` vs `PROVENANCE.json`.
**Layer B: every 4xx from `POST /v1/infra_as_code` persisted verbatim to
`tests/fixtures/api-errors/`** — a rejected field the vendored types call valid *is* drift
evidence, and it is the only detector that can see the unpublished **server** schema change.
Layer C: offline build -> validate -> plan contract test over one fixture per intent type.
🚫 Never discard an as-code 4xx body after logging it — ✅ persist it verbatim as a fixture, which
also feeds the fake server, so the test double gets more faithful every time production rejects
something.

**NN-59 — Golden files, not `toMatchSnapshot()`.** `[Phase 2]` A compiled `intents.json` is a
human review artifact; reviewers must be able to read the diff.
🚫 Never use `toMatchSnapshot()` for a reviewable artifact — ✅ commit an explicit golden file, and
list `tests/golden/` in `.prettierignore` or Prettier reformats the fixtures out from under the
byte comparison.

**NN-60 — Every library needs a Context7 receipt, or a recorded receipt-equivalent naming its
substitute source of truth.** `[JS/TS Base]` `[Phase 2]` Where coverage genuinely does not exist —
Notion as Code, the `notion-as-code-template` `types.d.ts`, the `ntn` binary — the log records the
substitute rather than omitting the entry. Version-sensitive claims about `@notionhq/*` were
cross-checked against the on-disk `.d.ts` at the fidelity-locked versions, not taken from Context7
alone.
🚫 Never add or bump a dependency without a receipt — ✅ append to `context7-receipts.md`, and if
Context7 has no coverage, write a receipt-equivalent that names the substitute source and the
drift mechanism.

**NN-61 — Treat the vendored types as a strong hypothesis, not ground truth.** `[Phase 2]`
The same upstream repo documents a `notion-as-code` CLI subcommand that **does not exist** in
`ntn` 0.21.2 (verified at intake). The repo is demonstrably capable of being out of step with the
platform.
🚫 Never treat an upstream template's documentation as a platform guarantee — ✅ verify against the
live API and correct via Layer B.

**NN-62 — The TypeScript Design Principles Gate is not this project's quality bar.** `[Phase 3]`
The playbook's own `Exclude When` reads "Pure Node.js backends with no React," and the Gate's
Step 2 scoping leaves only **P5, P6, P17** in scope. It is near-vacuous here and must be scoped
honestly rather than performed.
🚫 Never cite a green Design Principles Gate as evidence of quality here — ✅ point at the seven CI
gates and the 15-point Agentic CLI Design Scorecard, which is where the weight actually sits.

---

## Definition of done

TypeScript branch, extended with this project's actual CI gates rather than the generic list.
Note the deviation from the template's `bun run tsc`: **npm is the lockfile authority and Bun is
the test runner only** `[Phase 1]` `[Phase 2]`, so typecheck runs under npm and only the test gate
runs under Bun.

**The seven CI gates — all must be green:** `[Phase 2]` `[Phase 3]`

1. **typecheck** — `npm run typecheck` (`tsc -b`) passes with **zero errors** across all project
   references. Cold cross-package typechecks require `tsc -b` first; `tsc --noEmit` alone is not
   sufficient with project references.
2. **fidelity** — *required check.* Plain `tsc` emit for `packages/workers` compares clean against
   the committed sourceless build. Every `src/` file appears in `FIDELITY.json`; no lane
   downgrades; the verified count never decreases.
3. **test** — `bun test` green (built-in runner, exact Bun pin). `bun:test` + `node:` stdlib only;
   no fixture, HTTP-mock, fake-timer or snapshot libraries. Golden byte-comparisons included.
4. **lint** — `eslint --max-warnings 0` (flat config, `packages/workers/src` in `globalIgnores()`)
   and `prettier --check` clean.
5. **env-parity** — `.env.example`, `.env.1p` (`op://` pointers), and `scripts/deploy.sh`'s
   `WORKER_ENV_KEYS` agree as **lists**. This checks the lists, not that values resolve; `deploy.sh`
   failing closed (NN-10) is the separate, equally required half.
6. **freeze-guard** — fails while the deploy-freeze marker exists. Its failure is the intended
   steady state today, not a bug to route around.
7. **drift** — weekly cron: Layer-A SHA-256 of upstream `types.d.ts` against `PROVENANCE.json`.

**Per-change criteria:**

- No secrets in CI, and none needed — every test is offline. `[Phase 2]`
- Any new or bumped library has a Context7 receipt or receipt-equivalent appended to
  `context7-receipts.md` before merge (NN-60).
- Any new file in `packages/workers/src` is registered in `FIDELITY.json` with a lane, and Lane C
  is unavailable while frozen (NN-06).
- Any change to a frozen worker output shape is rejected; the golden `wire-contract.d.ts`
  comparison enforces it (NN-45).
- Fixing a catalogued bug `REC-NN` and flipping its file's lane happen in one atomic commit
  (NN-08).
- New public functions and exported types carry explicit types; `strict` +
  `noUncheckedIndexedAccess` + `verbatimModuleSyntax` hold in the new packages (and **only** the
  new packages — NN-05).
- Acceptance invariants hold for as-code work: `adopt -> plan` fixpoint empty for every fixture,
  and `apply -> re-plan` convergence empty (NN-39).
- All `TASK.md` items checked off.
- `task-critic` subagent returns **PASS** before the task is declared complete.

---

## AGENTS.md base

- **Primary:** `AGENTS.md (JS/TS Base)` **v1.1.0** (live Notion pull, last reviewed 2026-07-02) —
  sole base, **no type-specific overlay**. `JS/TS Project Setup & Retrofit` routes
  `project_type: worker` to "Use JS/TS Base only — Worker patterns are in the base," with
  `deploy_target: ntn`, `node_version: 22`, `repo_visibility: private`. `[Phase 1]`
- **Environment overlays, split by surface** — the timeline is production/months and the two
  surfaces have genuinely different risk profiles: `[Phase 1]`
  - **`AGENTS.prod.md`** — the Workers / deploy surface (live tools, no rollback, under freeze).
  - **`AGENTS.alpha.md`** — the gated as-code apply surface (access applied for, not yet granted).
- **Companions:** `WORKERS.md (Notion Workers)`, `GUARDRAILS.md`, `ARCHITECTURE.md`,
  `TESTING.md (JS/TS)`. `[Phase 1]`
- **Also binding:** the **TypeScript Design Principles Playbook** (P1–P17, scoped honestly to
  P5/P6/P17 here — see NN-62) and the playbook `Notion CLI & API — Deterministic Ops for Project
  Setup (2026)`, whose `data_source_id`-not-`database_id` callout bears directly on the 25
  deprecated `notion.databases.query` call sites in the legacy generation. `[Phase 1]`

---

## Context7 receipt log

- See `context7-receipts.md` in this run's output path
  (`docs/spec/notion-platform-tool/context7-receipts.md`).
- Nine full receipts (`@notionhq/workers` 0.4.0, `@notionhq/client` 5.21.0, ajv 8.18.0,
  ajv-formats 3.0.1, Node.js 22 `parseArgs`, Bun `bun:test`, TypeScript 5.9.3, ESLint 9,
  typescript-eslint, Prettier 3) plus three **receipt-equivalents** where Context7 has no coverage
  at all (Notion as Code `/v1/infra_as_code`, the `makenotion/notion-as-code-template`
  `types.d.ts`, and the `ntn` CLI 0.13.2), and two explicit non-entries (Node stdlib; the
  inherited, unvetted `date-fns@3.6.0` pin).
- The log is **append-only**. NN-60 makes appending to it a merge precondition.

---

## Open questions that bear on this constitution

Recorded, not resolved — both are the first things to settle when as-code alpha access lands, and
either answer could relax a constraint above. `[Phase 3]`

1. **Does `POST /v1/infra_as_code` accept an idempotency key?** If it does, the entire
   lost-response failure class collapses and NN-31/NN-32 could be simplified. Until then the
   pre-POST journal plus refusal-to-proceed is the mitigation.
2. **Does polling `/v1/async_tasks` consume the 5 req/min `/v1/infra_as_code` budget?** One shared
   limiter (NN-27) is the conservative default until measured.

**Accepted residual risk:** server-side field normalisation can cause perpetual drift. This is
**detected** by the post-apply verify pass (NN-13), not prevented, and is remedied by adding a
canonicaliser rule.
