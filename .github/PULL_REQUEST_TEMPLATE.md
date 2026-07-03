## PR title (required for release-please)

This repo uses **squash merge only**. The squashed commit title becomes the changelog entry.
Use [Conventional Commits](https://www.conventionalcommits.org/) format:

- `feat: add worker for X`
- `fix: prevent timeout in sync-github-items`
- `docs: update WORKERS.md`
- `chore: bump dependency`

Breaking changes: `feat!: rename output field` or include `BREAKING CHANGE:` in the body.

## Summary

<!-- What changed and why. One paragraph is enough. -->

Related issue / ticket: <!-- Notion task URL, GitHub issue #, or N/A -->

## Changes

<!-- What specifically was added, modified, or removed. Be concrete. -->

-
-

## Type of change

- [ ] Bug fix
- [ ] New feature / new worker
- [ ] Refactor (no behavior change)
- [ ] Breaking change (output schema or env var renamed)
- [ ] Documentation / configuration only
- [ ] Other: _______________

## Testing

<!-- How was this tested? Check all that apply. -->

- [ ] Unit tests pass (`bun test tests/unit/`)
- [ ] Integration tests pass (or N/A: _______________)
- [ ] Schema contract test added for new worker output shape
- [ ] No tests needed — reason: _______________

## Checklist

- [ ] `npm run check` (tsc --noEmit) passes with no errors
- [ ] `bun test` passes locally with zero failures
- [ ] No new `any` types; `strict: true` preserved
- [ ] No Bun-specific APIs in `src/` (ADR-003)
- [ ] All new relative imports use `.js` extension (ESM / NodeNext)
- [ ] No secrets or credentials hardcoded in source
- [ ] `.env.example` updated if new env vars were added
- [ ] `WORKERS.md` updated if worker registration changed
- [ ] Documentation updated if behavior or output schema changed
- [ ] For Zoho sync workers: governance review sign-off obtained (ADR-004)
