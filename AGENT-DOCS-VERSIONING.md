# Agent Docs Versioning Criteria

This project enforces strict versioning across every AI-agent-facing artifact. This file is the criteria `agent-config-conformance-auditor` checks against — read it before every audit; it wins over inference from other docs if they ever disagree.

## What must carry a version

| Artifact | Version location | Format |
|---|---|---|
| Skills (`.claude/skills/*/SKILL.md`) | HTML comment, first 20 lines | `<!-- Version: X.Y.Z \| Last Updated: YYYY-MM-DD -->` |
| Subagents (`.claude/agents/*.md`) | YAML frontmatter | `version: X.Y.Z` |
| Agent docs (AGENTS.md, GUARDRAILS.md, TESTING.md, ARCHITECTURE.md) | Header, first 10 lines | `Version: X.Y.Z \| Last Updated: YYYY-MM-DD` |
| Playbooks (Notion Reference Documentation DB) | `Last Reviewed` date (no dedicated version field exists yet — known gap) | ISO date |
| Plans (`plans/{NNNN}-{slug}/`) | Folder number + a `Version:` line in the plan doc itself | Sequential folder number; semver inside if revised |
| Cursor rules (`.cursor/rules/*.mdc`) | HTML comment immediately after the closing `---` of the YAML frontmatter | `<!-- Version: X.Y.Z \| Last Updated: YYYY-MM-DD -->` (added 2026-07-04 — gap found by agent-config-conformance-auditor when `.cursor/rules/` was first deployed to this project; same comment-based convention as SKILL.md, adapted since `.mdc` frontmatter is reserved for Cursor's own `alwaysApply`/`description`/`globs` keys) |

## Bump rules

- **Patch** (X.Y.**Z**): typo fixes, clarifications with no behavior change.
- **Minor** (X.**Y**.0): new capability, new section, new enforcement — backward compatible.
- **Major** (**X**.0.0): breaking change to the artifact's contract (a subagent's expected input/output shape changes; a skill's invocation interface changes).

Every bump gets a `CHANGELOG.md` entry. No silent version bumps, no silent skips.

## plans/ folder structure (not yet created in this project — reference for when one is)

```
plans/
├── README.md              # explains this convention
├── 0001-{slug}/
│   ├── PLAN.md             # output of /power-skills-bundle:writing-plans
│   └── STATUS.md           # draft | in-progress | complete | abandoned
├── 0002-{slug}/
│   └── ...
```

No plan file lives directly in `plans/` root. Numbers are sequential and never reused, mirroring `docs/adr/`'s numbering convention.
