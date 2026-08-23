# jre-notion-workers

[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-1.1+-fbf0df?logo=bun&logoColor=black)](https://bun.sh/)
[![Node](https://img.shields.io/badge/Node-%3E%3D22-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![coverage](https://img.shields.io/badge/coverage-CI%20unit-lightgrey)](.github/workflows/ci-tests.yml)

Notion Workers for Abstract Data's custom-agent fleet. The git root is a thin wrapper; the app package is [`jre-notion-workers/`](jre-notion-workers/README.md).

## Quick start

```bash
cd jre-notion-workers
bun install
bun run check
bun test tests/unit
```

## Docs

- [AGENTS.md](AGENTS.md) — agent config (canonical)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/TESTING.md](docs/TESTING.md)
- [docs/GUARDRAILS.md](docs/GUARDRAILS.md)
- [docs/DEPLOYMENTS.md](docs/DEPLOYMENTS.md)
- [docs/RUNBOOK.md](docs/RUNBOOK.md)
- [docs/adr/](docs/adr/)
- [prompts/](prompts/)
- [plans/](plans/)
- [REVIEWERS.md](REVIEWERS.md)

## Coverage

CI runs `bun test tests/unit --coverage` on every PR (see `.github/workflows/ci-tests.yml`). Integration tests stay env-gated and are not part of the default gate.
