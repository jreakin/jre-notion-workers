# DEPLOYMENTS.md — jre-notion-workers

**Version:** 1.0.0 | **Last Updated:** 2026-08-22

## What ships

The Notion Worker in `jre-notion-workers/` is deployed with `ntn workers deploy` (Node 22). Secrets are pushed from 1Password via `.github/workflows/sync-notion-secrets.yml` (`op environment read` → `ntn workers env push`).

## Versioning

Release Please owns tags for the `jre-notion-workers` package (`jre-notion-workers-vX.Y.Z`). Conventional Commits on `main` open the release PR.

## Rollout

1. `bun run check` and `bun test tests/unit` on the branch
2. Merge via PR (GitButler `but pr new`)
3. Release Please tags
4. Maintainer runs deploy (`bun run deploy` / `ntn workers deploy`) with 1Password

## Rollback

Redeploy the previous known-good worker build with `ntn`. There is no traffic-splitting layer; Notion hosts a single deployed worker.

## Monitoring

Fleet status and dead letters are themselves workers (`monitor-fleet-status`, `log-dead-letter`). Production incidents go to the Dead Letters database, not this repo's issue tracker first.
