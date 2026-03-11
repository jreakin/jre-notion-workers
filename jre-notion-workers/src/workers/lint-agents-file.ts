/**
 * lint-agents-file: Fetches an AGENTS.md file (or overlay) from a GitHub repo
 * and validates it against the AGENTS.md CI Linter Spec.
 * Returns a structured pass/fail report with per-rule findings.
 */
import type { LintAgentsFileInput, LintAgentsFileOutput, LintFinding } from "../shared/types.js";

export async function executeLintAgentsFile(
  input: LintAgentsFileInput
): Promise<LintAgentsFileOutput> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN is not set — required to fetch files from GitHub");
  }

  const repo = input.repo;
  const path = input.path ?? "AGENTS.md";
  const ref = input.ref ?? "main";
  const rawUrl = `https://raw.githubusercontent.com/${repo}/${ref}/${path}`;

  const res = await fetch(rawUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 404) {
    return {
      file: `${repo}/${path}`,
      ref,
      passed: false,
      score: "0/0 rules passed",
      findings: [
        { rule: "file_fetch", status: "FAIL", message: `File not found at ${rawUrl}` },
      ],
      raw_url: rawUrl,
    };
  }

  if (!res.ok) {
    throw new Error(`GitHub fetch failed: HTTP ${res.status} for ${rawUrl}`);
  }

  const content = await res.text();
  const isOverlay = path !== "AGENTS.md";
  const findings: LintFinding[] = [];

  // 1. Version header: <!-- version: X.Y.Z -->
  findings.push(
    /<!--\s*version:\s*\d+\.\d+\.\d+\s*-->/.test(content)
      ? { rule: "has_version_header", status: "PASS", message: "" }
      : { rule: "has_version_header", status: "FAIL", message: "Missing version header (<!-- version: X.Y.Z -->)" }
  );

  // 2. Model pin: model: followed by a specific model string (not wildcard/latest)
  const modelMatch = content.match(/model:\s*(.+)/i);
  const modelPinned = modelMatch != null && !/\*|latest/i.test(modelMatch[1]!.trim());
  findings.push(
    modelPinned
      ? { rule: "has_model_pin", status: "PASS", message: "" }
      : { rule: "has_model_pin", status: "FAIL", message: "Missing or unpinned model declaration" }
  );

  // 3. Scope section: ## Scope or ### Scope
  findings.push(
    /^#{2,3}\s+Scope\b/m.test(content)
      ? { rule: "has_scope_declaration", status: "PASS", message: "" }
      : { rule: "has_scope_declaration", status: "FAIL", message: "Missing Scope section" }
  );

  // 4. Last reviewed date: Last reviewed: YYYY-MM-DD
  findings.push(
    /Last reviewed:\s*\d{4}-\d{2}-\d{2}/i.test(content)
      ? { rule: "has_last_reviewed", status: "PASS", message: "" }
      : { rule: "has_last_reviewed", status: "FAIL", message: "Missing Last reviewed date" }
  );

  // 5. Reference Documentation section
  findings.push(
    /^#{2,3}\s+Reference Documentation\b/m.test(content)
      ? { rule: "has_reference_documentation_section", status: "PASS", message: "" }
      : { rule: "has_reference_documentation_section", status: "FAIL", message: "Missing Reference Documentation section" }
  );

  // 6. Changelog section
  findings.push(
    /^#{2,3}\s+Changelog\b/m.test(content)
      ? { rule: "has_changelog", status: "PASS", message: "" }
      : { rule: "has_changelog", status: "FAIL", message: "Missing Changelog section" }
  );

  // 7. Overlay extends declaration (overlays only)
  if (isOverlay) {
    findings.push(
      /[Ee]xtends:\s*.*AGENTS\.md/i.test(content)
        ? { rule: "overlay_has_extends", status: "PASS", message: "" }
        : { rule: "overlay_has_extends", status: "FAIL", message: "Overlay is missing 'extends: AGENTS.md' declaration" }
    );
  }

  const passCount = findings.filter((f) => f.status === "PASS").length;
  const totalCount = findings.length;

  return {
    file: `${repo}/${path}`,
    ref,
    passed: passCount === totalCount,
    score: `${passCount}/${totalCount} rules passed`,
    findings,
    raw_url: rawUrl,
  };
}
