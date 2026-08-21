# ADR (Draft): Stack and Architecture Selection — Notion Platform Tool

**Status:** Proposed
**Date:** 2026-07-26

## Context

`jre-notion-workers` is being reworked from a Notion-Workers-only repo into an all-in-one
Notion platform maintenance tool spanning three surfaces: the `ntn` CLI / Notion public REST
API, Notion Workers, and Notion as Code. Today every structural change to the workspace is
made by hand through the Notion MCP, one call at a time; the goal is for coding agents to
configure, template, audit and repair the workspace programmatically.

Four facts dominate the design. (1) Notion as Code has **no server-side state and no
server-side plan** — the client-supplied `existingResources` mapping is the only thing
preventing duplicate creation on re-apply, and `plan` is therefore a client-side prediction
and the single largest value the tool adds. (2) There is **no delete intent and no rollback**;
the blast radius is the maintainer's primary Notion workspace and every mistake is manual
cleanup. (3) `packages/workers` is **sealed** — some of its tools are live in production and
its TypeScript was never committed, so fidelity is established only by comparing a plain `tsc`
emit against the committed sourceless build. (4) The repo holds **two divergent worker
generations** under a deploy freeze.

Phase 1 locked TypeScript 5.x / Node >= 22. Phase 2 locked npm workspaces, `parseArgs` plus a
hand-rolled registry, one ajv instance, a vendored pinned `types.d.ts`, `tsc` with no bundler,
Bun as test runner only, and the seal on `packages/workers`.

## Decision

Adopt **routing → prompt chaining** with bounded parallelization, over a **Pure core / I-O
edge** (Ports & Adapters) layout in five npm workspaces: `workers` (sealed, untouched),
`core` (pure), `notion-port` (the only package that constructs `@notionhq/client`), `ascode`
(the engine), and `cli` (registry and sole composition root). Direction is enforced at compile
time by `tsc` project references; `process.*`, `fetch`, `child_process` and `node:fs` are
confined to `*/src/adapters` by a CI grep. The seal is one-directional: the workers package
exports its `.d.ts` outward and imports nothing new, so it requires no edits.

Adopt **"the check is the constructor"** as the organising device: every dangerous
precondition is a branded type whose sole constructor is the check — `ObservedIntent`
(`observe`), `ClosedIntentDocument` (`checkClosure`), `ApprovedPlan` (`confirmApply`),
`GuardedTarget` (`resolveTarget`), `AsCodeEnv` (`loadAsCodeEnv`). Each is paired with a
runtime re-check, since brands are compile-time only.

`plan` and `adopt` are two compositions of one primitive, `observe(pointer)`, the sole
producer of `ObservedIntent`; the same canonicaliser is applied to both sides of the diff; and
the create-versus-update decision comes from the state pointer, never from the diff. Intents
are recorded through an `AsyncLocalStorage`-scoped recorder that returns opaque `Ref` handles,
not a module-level global. State is one committed JSON file per space, additive-only for
pointers, guarded by an O_EXCL lock and a dirty-tree refusal, with the apply request journalled
and fsynced before the POST and every raw task response persisted verbatim before any state
mutation. `plan` is a saved artifact consumed by `apply`, hash-verified. `verified` versus
`unverifiable` labels are derived from `observe` coverage rather than authored.

New code uses an internal `Result<T, PlatformError>` discriminated on `ok`; the 33 deployed
worker output shapes are frozen as-is and mechanically protected by a golden comparison of the
emitted `types.d.ts`. The two worker generations converge by Strangler Fig against a
three-lane fidelity manifest, ending in a **no-op deploy** of a tree proven token-identical to
what is already running.

## Consequences

**This commits the project to:**
- A five-package workspace with `tsc -b` project references, and a `"bun"` export condition per
  package so the Bun test runner resolves source rather than a stale `dist/`.
- One composition root, and the discipline that ports are injected everywhere else.
- `retry: false` on every Notion client, because the SDK's built-in retry uses real timers and
  would defeat the `Clock` port.
- Building the as-code transport on the public `Client.request()`, so base URL, API version,
  auth and error narrowing have exactly one implementation.
- A plan/apply workflow with a saved, hash-verified plan file and a mandatory post-apply verify
  pass, which is the compensating control for having no rollback.
- Refusing to apply from a dirty working tree, with no `--allow-dirty` escape hatch.
- Deleting the `deploy` npm script for the duration of the freeze, and making `scripts/deploy.sh`
  fail closed on any unresolved `WORKER_ENV_KEYS` entry.
- Writing characterisation tests that assert the 22 catalogued bugs, so fixing one and losing
  its fidelity proof are the same atomic commit.

**This forecloses:**
- Any runtime import crossing into `packages/workers`, including a shared error envelope — the
  boundary adapter is duplicated inside the sealed package by design.
- Rewriting the 21 both-generations tools rather than recovering them; a rewrite has no `dist/`
  oracle and could not be fidelity-verified.
- Adding any Lane C (unverifiable) file to the workers package while the freeze holds.
- Treating the TypeScript Design Principles Gate as this project's quality bar: with no React,
  only P5, P6 and P17 are in scope, so CI (typecheck, fidelity, test, lint, env-parity,
  freeze-guard, drift) and the Agentic CLI Design Scorecard carry that weight instead.

**Accepted residual risks:**
- Server-side normalisation of a field can produce perpetual drift; this is detected by the
  post-apply verify pass, not prevented, and is remedied by adding a canonicaliser rule.
- Whether `/v1/infra_as_code` accepts an idempotency key is unverified. If it does, the entire
  lost-response failure class collapses; until then the pre-POST journal plus refusal-to-proceed
  is the mitigation. This is the first question to settle when alpha access is granted.
- Whether polling `/v1/async_tasks` counts against the 5 req/min budget is unverified; one
  shared limiter across both endpoints is the conservative default.

---
> **Promotion status:** Not yet promoted. This draft becomes part of the project's ADR log only
> if this spec proceeds — see the abstract-data-spec-brainstorm SKILL.md section
> "ADR lifecycle: draft → promoted."
