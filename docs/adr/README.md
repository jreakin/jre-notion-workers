# ADRs (AI Decision Records)

Append-only. Never delete an ADR; mark it `superseded` and point at the replacement.

Naming: `{NNNN}-{slug}.md` (example: `0001-initial-tool-selection.md`).

## Template

```markdown
# ADR {NNNN}: {Title}
**Date:** {YYYY-MM-DD}
**Status:** proposed | accepted | superseded by ADR-{NNNN}
## Context
{What situation prompted this decision?}
## Decision
{What was decided and why?}
## Consequences
{What are the trade-offs?}
```
