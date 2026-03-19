/**
 * GitHub API utilities — error classification for actionable diagnostics.
 */
import type { ClassifiedGitHubError } from "./types.js";

/**
 * Classifies a non-OK GitHub API response into an actionable error code.
 * Distinguishes between missing repos, permission issues, rate limits,
 * renamed repos, and server errors.
 */
export function classifyGitHubError(
  res: Response,
  url: string
): ClassifiedGitHubError {
  const status = res.status;

  if (status === 404) {
    return {
      code: "repo_not_found",
      status,
      message: `Item not found (404): ${url}. Repo may be deleted or the token lacks access.`,
    };
  }

  if (status === 403) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    const resetHeader = res.headers.get("x-ratelimit-reset");
    if (remaining === "0") {
      const retryAfter = resetHeader
        ? Math.max(0, parseInt(resetHeader, 10) - Math.floor(Date.now() / 1000))
        : 60;
      return {
        code: "rate_limited",
        status,
        message: `GitHub API rate limit exceeded for ${url}`,
        retry_after_seconds: retryAfter,
      };
    }
    return {
      code: "permission_denied",
      status,
      message: `Forbidden: ${url}. Check GitHub token permissions or org SSO authorization.`,
    };
  }

  if (status === 401) {
    return {
      code: "permission_denied",
      status,
      message: `Unauthorized: ${url}. GITHUB_TOKEN may be expired or invalid.`,
    };
  }

  if (status === 301) {
    const location = res.headers.get("location");
    return {
      code: "repo_renamed",
      status,
      message: `Renamed/moved: ${url} → ${location ?? "unknown destination"}`,
    };
  }

  if (status >= 500) {
    return {
      code: "server_error",
      status,
      message: `GitHub server error: HTTP ${status} for ${url}`,
    };
  }

  return {
    code: "unknown",
    status,
    message: `Unexpected HTTP ${status} for ${url}`,
  };
}

/**
 * Wraps classifyGitHubError into an Error subclass for throw/catch flows.
 */
export class GitHubApiError extends Error {
  readonly classified: ClassifiedGitHubError;

  constructor(classified: ClassifiedGitHubError) {
    super(classified.message);
    this.name = "GitHubApiError";
    this.classified = classified;
  }
}
