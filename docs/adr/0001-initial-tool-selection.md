# ADR 0001: Initial tool selection

**Date:** 2026-08-22
**Status:** accepted

## Context

This repo is the live Notion Workers runtime for Abstract Data custom agents. A retrofit against Abstract Data templates needed a recorded baseline of language, runtime, secrets, and branch tools already in use.

## Decision

- Language: TypeScript (ESM, NodeNext, strict)
- Runtime: Node ≥ 22 in production (`ntn workers deploy`); Bun for local test/dev
- Framework: `@notionhq/workers` + `@notionhq/client`
- Secrets: 1Password Environment mount + `op run --env-file=.env.1p` (approach C/D mix). Stay; do not migrate to Environments SDK in this retrofit.
- Branch authority: GitButler (`but`)
- Release automation: release-please (already configured for the `jre-notion-workers` package)
- CI: GitHub Actions with Bun (`tsc` + `bun test tests/unit`)

## Consequences

- Agents must not introduce Vitest/ESLint/Prettier CI jobs unless those tools are added to the app `package.json`
- Agents must not use Bun-only APIs in `src/`
- Git write operations go through `but`, not raw git
