# prompts/

Version-controlled home for agent system prompts used by this project.

Convention per agent:

```
prompts/{agent-name}/
├── current.md          # copy of the active snapshot
├── v{MAJOR.MINOR.PATCH}.md
└── CHANGELOG.md        # append-only
```

Header required on every prompt file:

```
# {agent-name} — System Prompt
# Version:
# Model:
# Last Updated:
# Maintainer:
```

`current.md` is never edited in place — copy a new snapshot, then replace `current.md`. Promotion path: dev → alpha → staging → prod.

Worker execute handlers are TypeScript, not prompt files. Add a subdirectory here when a Custom Agent system prompt for this repo is versioned in git.
