"""Wraps tests/verify/check_agents_md.py for verify-completion pytest hook."""

import subprocess
import sys
from pathlib import Path


def test_agents_md_required_sections() -> None:
    script = Path(__file__).resolve().parents[1] / "verify" / "check_agents_md.py"
    repo_root = Path(__file__).resolve().parents[2]
    result = subprocess.run(
        [sys.executable, str(script)],
        cwd=repo_root,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
