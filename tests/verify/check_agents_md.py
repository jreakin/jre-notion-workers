"""Hard verification: AGENTS.md exists and has all required sections."""

import sys
from pathlib import Path

REQUIRED_SECTIONS = [
    "## Agent Scope Declaration",
    "## Model Configuration",
    "## Notion References",
    "## Documentation Priority",
    "## Tool Resolution Priority",
    "## Goal Proposal Protocol",
    "## Tool Permissions by Mode",
    "## Anti-Pattern Warnings",
    "## Definition of Done",
    "## Periodic Rule Reinforcement",
]


def main() -> int:
    failures = []
    agents_md = Path("AGENTS.md")
    if not agents_md.exists():
        print("FAIL: AGENTS.md missing")
        return 1

    content = agents_md.read_text()

    if "Version:" not in content[:400]:
        failures.append("AGENTS.md missing version header in first lines")

    for section in REQUIRED_SECTIONS:
        if section not in content:
            failures.append(f"AGENTS.md missing required section: {section}")

    if failures:
        for f in failures:
            print(f"FAIL: {f}")
        return 1

    print("PASS: AGENTS.md has all required sections")
    return 0


if __name__ == "__main__":
    sys.exit(main())
