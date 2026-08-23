#!/usr/bin/env bash
# sessionStart: inject project governance reminders.
set -euo pipefail
source "$(dirname "$0")/_common.sh"
read_hook_input

jq -n '{
  additional_context: "Abstract Data governance hooks are active (see .cursor/hooks/README.md and AGENTS.md). Default stack assumption: TanStack Start on Cloudflare Workers (bun, vitest) — use `bun run test` (not `bun test`). Server-only I/O (D1/R2/Workflows/browser) goes through createServerFn in src/server/functions/; never in route loaders or client components. Incremental fixes only — no architecture swaps without approval. Hooks enforce safety: protected files, dangerous-command blocks, secret/test gates on commit, and tsc/lint/test on stop. Adapt AGENTS.md to this project; remove hooks that do not fit the stack."
}'
exit 0
