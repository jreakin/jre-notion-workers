# GITBUTLER.md — Virtual Branch Reference

**Version:** 1.0.0 | **Last Updated:** 2026-08-22

⚠️ This project runs in a GitButler virtual branch workspace. HEAD is always on gitbutler/workspace. Never run raw git write commands — use but equivalents. The .git/hooks/pre-commit blocks git commit; block-raw-git.sh catches violations earlier with clearer messages.

Official GitButler skill: https://github.com/gitbutlerapp/claude — install into .claude/skills/gitbutler/SKILL.md as the canonical source.

## Mental model (read first)

GitButler virtual branches are hunk-level lane assignments inside one shared working directory. Multiple branches are applied simultaneously — you see the union of all their work. When you but commit <branch>, GitButler computes that branch's isolated tree and writes a real Git commit, then rebuilds the workspace union.

HEAD stays on gitbutler/workspace — a synthetic merge commit GitButler rebuilds automatically. Its commit message lists all currently applied branches with their refs. Never git checkout anything else.

## Your session context

```javascript
Assigned branch: [FILL IN]
File scope:      [FILL IN]
Task:            [FILL IN]
```

## Non-negotiable rules

1. Never use git write commands — use but equivalents

2. Always add --json --status-after to mutation commands

3. Use CLI IDs from but status --json — never hardcode

4. Run but status --json before any mutation so IDs are current

## Command reference

### Inspect

```bash
but status                    # workspace overview
but status --files            # unstaged changes + bookmarks + common base
but status --json             # machine-readable IDs for branches (fe), files (g0), hunks (j0)
```

### Commit

```bash
but commit <branch> -m "msg" --json --status-after
but commit <branch> -m "msg" --changes g0,h0 --json --status-after
```

### Multi-branch pattern (one session → multiple PRs)

```bash
but status --json
but commit feat/my-feature -m "Add endpoint" --changes g0,h0 --json --status-after
but commit docs/my-feature -m "Document endpoint" --changes i0 --json --status-after
```

### Absorb — fold fixes into existing commits

```bash
but absorb                    # auto-amend into appropriate commits
but absorb --dry-run          # preview first
but absorb --new              # create new commits instead of amending
but absorb <file-id>          # specific file only
but absorb <stack-id>         # specific stack only
```

### rub — Swiss-army editing

```bash
but rub <file-id> <commit-sha>      # amend file into commit
but rub <sha1> <sha2>              # squash two commits
but rub <file-id> <branch>         # stage file to branch
but rub <commit-sha> <branch>      # move commit to branch
but rub <id> zz                    # un-stage or un-commit to unassigned
```

### Reword (corrected syntax)

```bash
but reword -m "new message" <commit-sha>    # rename commit
but reword -m "new-branch-name" <branch-sha>  # rename branch
```

Always takes a SHA — never a bare branch name.

### Recovery

```bash
but undo
but oplog
but oplog restore <snapshot-id>
```

### Branch management

```bash
but branch new <name>
but branch new -a <anchor> <name>    # stacked (dependent on anchor)
but branch list
but apply <branch>
but unapply <branch>
but push <branch>
but pr
```

### Stacks — dependent branches

```bash
but branch new -a <anchor-branch> <new-name>
but commit <stacked-branch> -m "msg"
but push <anchor-branch>              # pushes entire stack
```

PRs: create and merge bottom-up. After bottom PR merges, force push to reflect remotely.

### Pre-push cleanup

```bash
but absorb
but rub <sha1> <sha2>
but reword -m "better message" <sha>
but push <branch>
but pr
```

## git commands — allowed vs blocked

| Command | Allowed? | Use instead |

| git log, git diff, git status, git show, git blame | ✅ Yes | — |

| git commit | ❌ | but commit <branch> -m "msg" |

| git checkout / git switch | ❌ | but apply / but unapply |

| git push | ❌ | but push <branch> |

| git merge / git rebase | ❌ | but pull |

| git reset | ❌ | but undo / but oplog restore |

| git pull | ❌ | but pull |

| git stash | ❌ | but unapply <branch> |

| git cherry-pick | ❌ | but rub <commit-sha> <branch> |

## Common recovery scenarios

Changes in zz (unassigned):

```bash
but status --json
but rub <id> <branch>     # or: but absorb
```

Committed to wrong branch:

```bash
but rub <commit-sha> <correct-branch>
but rub <commit-sha> zz    # un-commit, then restage correctly
```

Exited GitButler mode:

```bash
git checkout gitbutler/workspace
# or: but setup
```

Hit GITBUTLER_ERROR: Work is not lost. but status to confirm, then but commit <branch> -m "msg".

Sync with upstream:

```bash
but pull
but resolve <commit-id>
but resolve finish
```

## NEVER DO

- git commit → but commit <branch> -m "msg"

- git checkout / git switch → but apply / but unapply

- git push → but push <branch>

- git merge / git rebase / git pull → but pull

- git reset → but undo or but oplog restore

- git stash → but unapply <branch>

- git cherry-pick → but rub <commit-sha> <branch>

- but claim (does not exist) → but mark

- but reword <branch-name> (wrong syntax) → but reword -m <name> <sha>

- Mutations without --json --status-after

- Editing files in another agent's scope without checking but status

## Four Claude Code integration paths

| Path | When to use |

| Desktop Agents Tab | Supervised sessions; auto-ties to one branch |

| Lifecycle hooks (but claude pre-tool/post-tool/stop) | Headless claude -p; auto-commits per tool call |

| but skill + AGENTS.md | Single session → multiple branches via --changes |

| MCP server (but mcp → gitbutler_update_branches) | Cursor/VSCode; add to CLAUDE.md: "When done with a task where files were edited, run the gitbutler mcp update_branches command" |

## Sources

Official skill: https://github.com/gitbutlerapp/claude

Docs: https://docs.gitbutler.com

CLI ref: https://docs.gitbutler.com/cli-overview

Verified via Context7 (/gitbutlerapp/gitbutler-docs): 2026-05-16