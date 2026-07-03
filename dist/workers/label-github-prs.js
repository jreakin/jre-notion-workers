/**
 * label-github-prs: Scans PRs across configured GitHub sources and applies
 * labels inferred from conventional commit prefixes in the PR title.
 *
 * Mapping:
 *   fix / bugfix / hotfix / bug  →  bug
 *   feat / feature               →  feature
 *   docs / doc                   →  documentation
 *   chore                        →  chore
 *   refactor / refact            →  refactor
 *   test / tests                 →  test
 *   ci / build                   →  ci
 *   style                        →  style
 *   perf                         →  performance
 *
 * Idempotent: skips PRs that already have the inferred label.
 * Safe: never removes existing labels, only adds.
 */
import { getGitHubToken, extractErrorMessage } from "../shared/notion-client.js";
import { classifyGitHubError, GitHubApiError } from "../shared/github-utils.js";
const TAG = "[label-github-prs]";
/* ── Constants ───────────────────────────────────────────────────────────── */
const DEFAULT_SOURCES = [
    { name: "Abstract-Data", type: "org" },
    { name: "JREakin", type: "user" },
];
/** Conventional commit prefix → GitHub label name */
const COMMIT_LABEL_MAP = {
    fix: "bug",
    bugfix: "bug",
    hotfix: "bug",
    bug: "bug",
    feat: "feature",
    feature: "feature",
    docs: "documentation",
    doc: "documentation",
    chore: "chore",
    refactor: "refactor",
    refact: "refactor",
    test: "test",
    tests: "test",
    ci: "ci",
    build: "ci",
    style: "style",
    perf: "performance",
};
/** Colors for auto-created labels */
const LABEL_COLORS = {
    bug: "d73a4a",
    feature: "0075ca",
    documentation: "0075ca",
    chore: "e4e669",
    refactor: "fbca04",
    test: "0e8a16",
    ci: "f9d0c4",
    style: "bfd4f2",
    performance: "5319e7",
    // Keep existing colors consistent
    enhancement: "a2eeef",
    "good first issue": "7057ff",
};
/** Matches: type(scope)?!: rest-of-title */
const COMMIT_PREFIX_RE = /^([a-z][a-z0-9-]*)(\([^)]*\))?!?\s*:/i;
/* ── Helpers ─────────────────────────────────────────────────────────────── */
function inferLabel(title) {
    const m = title.match(COMMIT_PREFIX_RE);
    if (!m || !m[1])
        return null;
    const prefix = m[1].toLowerCase();
    const label = COMMIT_LABEL_MAP[prefix];
    if (!label)
        return null;
    return { type: prefix, label };
}
async function githubGet(url, token) {
    const res = await fetch(url, {
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
        },
    });
    if (!res.ok)
        throw new GitHubApiError(classifyGitHubError(res, url));
    return (await res.json());
}
async function paginatedGet(baseUrl, token) {
    const items = [];
    let url = baseUrl.includes("?")
        ? `${baseUrl}&per_page=100`
        : `${baseUrl}?per_page=100`;
    while (url) {
        const res = await fetch(url, {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/vnd.github+json",
            },
        });
        if (!res.ok)
            throw new GitHubApiError(classifyGitHubError(res, url));
        const data = (await res.json());
        items.push(...data);
        const link = res.headers.get("link");
        url = null;
        if (link) {
            const m = link.match(/<([^>]+)>;\s*rel="next"/);
            if (m)
                url = m[1];
        }
    }
    return items;
}
async function fetchRepos(source, token) {
    if (source.type === "org") {
        return paginatedGet(`https://api.github.com/orgs/${source.name}/repos?type=all`, token);
    }
    const all = await paginatedGet("https://api.github.com/user/repos?type=owner", token);
    return all.filter((r) => r.owner.login.toLowerCase() === source.name.toLowerCase());
}
async function fetchPRs(owner, repo, state, token, maxPrs) {
    const all = await paginatedGet(`https://api.github.com/repos/${owner}/${repo}/pulls?state=${state}`, token);
    return all.slice(0, maxPrs);
}
async function getRepoLabels(owner, repo, token) {
    const labels = await paginatedGet(`https://api.github.com/repos/${owner}/${repo}/labels`, token);
    return new Set(labels.map((l) => l.name.toLowerCase()));
}
async function createLabel(owner, repo, name, token) {
    const color = LABEL_COLORS[name] ?? "ededed";
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/labels`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ name, color }),
    });
    if (!res.ok && res.status !== 422) {
        // 422 = label already exists — safe to ignore
        throw new Error(`Failed to create label "${name}": ${res.status}`);
    }
}
async function addLabelToPR(owner, repo, prNumber, label, token) {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/labels`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ labels: [label] }),
    });
    if (!res.ok) {
        throw new Error(`Failed to add label "${label}" to PR #${prNumber}: ${res.status}`);
    }
}
/* ── Main ────────────────────────────────────────────────────────────────── */
export async function executeLabelGitHubPrs(input) {
    try {
        const token = getGitHubToken();
        const sources = input.sources ?? DEFAULT_SOURCES;
        const state = input.state ?? "open";
        const maxPrsPerRepo = input.max_prs_per_repo ?? 200;
        const createMissingLabels = input.create_missing_labels ?? true;
        const dryRun = input.dry_run ?? false;
        let reposScanned = 0;
        let prsScanned = 0;
        let labeled = 0;
        let alreadyLabeled = 0;
        let noMatch = 0;
        let errors = 0;
        const results = [];
        for (const source of sources) {
            console.log(TAG, `Fetching repos for ${source.type} "${source.name}"...`);
            const repos = await fetchRepos(source, token);
            const ownRepos = repos.filter((r) => !r.fork);
            console.log(TAG, `  → ${ownRepos.length} repos`);
            for (const repo of ownRepos) {
                const [owner, repoName] = repo.full_name.split("/");
                if (!owner || !repoName)
                    continue;
                reposScanned++;
                // Load current repo labels once per repo
                let repoLabelSet;
                try {
                    repoLabelSet = await getRepoLabels(owner, repoName, token);
                }
                catch (e) {
                    console.warn(TAG, `  Could not fetch labels for ${repo.full_name}:`, e);
                    repoLabelSet = new Set();
                }
                // Fetch PRs
                let prs;
                try {
                    prs = await fetchPRs(owner, repoName, state, token, maxPrsPerRepo);
                }
                catch (e) {
                    console.warn(TAG, `  Could not fetch PRs for ${repo.full_name}:`, e);
                    continue;
                }
                console.log(TAG, `  ${repo.full_name}: ${prs.length} PRs`);
                prsScanned += prs.length;
                for (const pr of prs) {
                    const inferred = inferLabel(pr.title);
                    if (!inferred) {
                        noMatch++;
                        results.push({
                            repo: repo.full_name,
                            pr_number: pr.number,
                            title: pr.title,
                            detected_type: "",
                            label_applied: "",
                            action: "no_match",
                        });
                        continue;
                    }
                    const { type: detectedType, label } = inferred;
                    // Check if PR already has this label
                    const existingLabels = new Set(pr.labels.map((l) => l.name.toLowerCase()));
                    if (existingLabels.has(label.toLowerCase())) {
                        alreadyLabeled++;
                        results.push({
                            repo: repo.full_name,
                            pr_number: pr.number,
                            title: pr.title,
                            detected_type: detectedType,
                            label_applied: label,
                            action: "already_labeled",
                        });
                        continue;
                    }
                    try {
                        if (!dryRun) {
                            // Ensure label exists on the repo
                            if (createMissingLabels && !repoLabelSet.has(label.toLowerCase())) {
                                await createLabel(owner, repoName, label, token);
                                repoLabelSet.add(label.toLowerCase());
                                console.log(TAG, `    Created label "${label}" on ${repo.full_name}`);
                            }
                            // Apply the label
                            await addLabelToPR(owner, repoName, pr.number, label, token);
                        }
                        labeled++;
                        results.push({
                            repo: repo.full_name,
                            pr_number: pr.number,
                            title: pr.title,
                            detected_type: detectedType,
                            label_applied: label,
                            action: "labeled",
                        });
                        console.log(TAG, `  ${dryRun ? "[DRY RUN] " : ""}${repo.full_name}#${pr.number}: "${detectedType}" → "${label}"`);
                    }
                    catch (e) {
                        const msg = e instanceof Error ? e.message : String(e);
                        errors++;
                        results.push({
                            repo: repo.full_name,
                            pr_number: pr.number,
                            title: pr.title,
                            detected_type: detectedType,
                            label_applied: label,
                            action: "error",
                            error: msg,
                        });
                        console.error(TAG, `  Error on ${repo.full_name}#${pr.number}:`, msg);
                    }
                }
            }
        }
        const prefix = dryRun ? "DRY RUN — " : "";
        const summary = `${prefix}Scanned ${reposScanned} repos, ${prsScanned} PRs. Labeled: ${labeled}, already labeled: ${alreadyLabeled}, no match: ${noMatch}, errors: ${errors}.`;
        console.log(TAG, summary);
        return {
            success: true,
            repos_scanned: reposScanned,
            prs_scanned: prsScanned,
            labeled,
            already_labeled: alreadyLabeled,
            no_match: noMatch,
            errors,
            results,
            summary,
        };
    }
    catch (e) {
        const message = extractErrorMessage(e);
        console.error(TAG, "error:", message);
        return { success: false, error: message };
    }
}
