/**
 * Parse a GitHub issue or PR URL into owner, repo, and number.
 * Returns null for repo-level URLs (no number).
 */
export function parseGitHubUrl(url) {
    if (!url)
        return null;
    try {
        const u = new URL(url);
        const parts = u.pathname.split("/").filter(Boolean);
        // e.g. /Abstract-Data/my-app/issues/42  or  /Abstract-Data/my-app/pull/10
        if (parts.length < 4)
            return null;
        const owner = parts[0];
        const repo = parts[1];
        const kind = parts[2];
        const num = parseInt(parts[3], 10);
        if (isNaN(num))
            return null;
        if (kind === "issues")
            return { owner, repo, number: num, type: "issue" };
        if (kind === "pull")
            return { owner, repo, number: num, type: "pr" };
        return null;
    }
    catch {
        return null;
    }
}
