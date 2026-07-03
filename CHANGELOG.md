# Changelog

All notable changes to this project are documented in this file.
Release Please maintains this file going forward from v1.0.0.

## [1.1.0](https://github.com/jreakin/jre-notion-workers/compare/jre-notion-workers-v1.0.0...jre-notion-workers-v1.1.0) (2026-07-03)


### Features

* bounded/resumable sync, cadence-aware freshness, robust upstream discovery, GitHub error classification, graceful degradation ([096989e](https://github.com/jreakin/jre-notion-workers/commit/096989e7fb235b99126eba84d4d3945d23361f7a))
* deploy jre-notion-workers ([b3cb6b8](https://github.com/jreakin/jre-notion-workers/commit/b3cb6b84d770ae7058da1328bc8ed9ba2d6c4222))
* deploy jre-notion-workers ([3daa892](https://github.com/jreakin/jre-notion-workers/commit/3daa8923ef81c9bb2db2288bd4090184e3b57bcc))


### Bug Fixes

* agent config corrections and audit remediation ([2301e29](https://github.com/jreakin/jre-notion-workers/commit/2301e299d7a32588ce0afed7657e83701863128a))
* extract changelog sections correctly for reverse-chronological order ([94919f8](https://github.com/jreakin/jre-notion-workers/commit/94919f8dbe6d6ff14baed8818c7e7ff6bbb1108c))
* prevent sync-github-items timeout with 180-day default lookback and lower write cap ([df5cdd9](https://github.com/jreakin/jre-notion-workers/commit/df5cdd9f0a4676510e61f5bf6aebd89be8942db6))
* use status property type instead of select for GitHub Items Status field ([678ef3e](https://github.com/jreakin/jre-notion-workers/commit/678ef3ea754c06c15c3b70e6beb43a6d12634663))


### Documentation

* add NEXT-STEPS.md with P0/P1 remediation instructions ([4a15321](https://github.com/jreakin/jre-notion-workers/commit/4a153217d199539b694f2219d26856f8f04945b8))

## [1.0.0](https://github.com/jreakin/jre-notion-workers/compare/v0.4.0...v1.0.0) (2026-05-03)

### Features

* **client publishing:** add MVP client-safe publishing pipeline (12 workers + shared logic) ([#1](https://github.com/jreakin/jre-notion-workers/pull/1))
* **agent ops:** add canonical Run Status mapping, heartbeat validation, and `write-agent-ops-run` worker ([#1](https://github.com/jreakin/jre-notion-workers/pull/1))
* **dead letters:** dedupe open dead-letter records on (agent, failure type, expected run date) ([#1](https://github.com/jreakin/jre-notion-workers/pull/1))
* **briefing:** add agent-name allowlist to `scan-briefing-failures` to filter parser artifacts ([#1](https://github.com/jreakin/jre-notion-workers/pull/1))

### Bug Fixes

* **agent ops:** add one-shot `normalize-agent-ops-options` migration for stale status values ([#1](https://github.com/jreakin/jre-notion-workers/pull/1))

## [0.4.0](https://github.com/jreakin/jre-notion-workers/compare/v0.3.0...v0.4.0) (2026-04-03)

### Features

* **devops:** initial project setup with 1Password Environment integration and preflight scripts

## [0.3.0](https://github.com/jreakin/jre-notion-workers/compare/v0.2.0...v0.3.0) (2026-03-19)

### Features

* **sync:** add bounded/resumable `sync-github-items` with wall-clock timer, resume cursor, and instrumentation
* **upstream:** replace hardcoded 48h staleness with per-agent cadence thresholds in `check-upstream-status`
* **fleet:** use per-agent cadence lookup in `monitor-fleet-status`
* **github:** add `classifyGitHubError()` for repo_not_found, permission_denied, rate_limited, repo_renamed, server_error
* **handoff:** return success with degraded capabilities when task creation fails in `create-handoff-marker`

### Bug Fixes

* **github items:** use status property type instead of select for GitHub Items Status field
* **sync:** prevent `sync-github-items` timeout with 180-day default lookback and lower write cap
* **home docs:** fix title property lookup (`Name` → `Doc`) in upstream discovery

## [0.2.0](https://github.com/jreakin/jre-notion-workers/compare/v0.1.0...v0.2.0) (2026-03-15)

### Bug Fixes

* **agent config:** rename Home & Life Watcher → Home & Life Task Watcher; set Drift Watcher cadence to weekly
* **retention:** update digest retention from 90 → 30 days
* **handoff:** fix circuit breaker in `create-handoff-marker` to check all tasks, not just open
* **dead letters:** expand DetectedBy enum for dead letter logging
* **sync:** add `open_only` filter to `sync-github-items`
* **fleet:** fix Home Docs title property lookup in fleet monitor

## [0.1.0](https://github.com/jreakin/jre-notion-workers/compare/v0.0.0...v0.1.0) (2026-03-11)

### Features

* **workers:** initial Notion Workers fleet — digest writing, upstream checks, handoffs, fleet monitoring, dead letters, credit forecast
* **deploy:** first production deploy of jre-notion-workers
* **ci:** add GitHub Actions workflow for PR path-based labeling

### Documentation

* add NEXT-STEPS.md with P0/P1 remediation instructions

## 0.0.0 (2026-03-01)

* Initial commit
