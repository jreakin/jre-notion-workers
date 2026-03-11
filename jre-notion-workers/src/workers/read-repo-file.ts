/**
 * read-repo-file: Fetches the raw text content of any file from a GitHub repo.
 * Used by agents to read AGENTS.md overlays, config files, etc.
 */
import type { ReadRepoFileInput, ReadRepoFileOutput } from "../shared/types.js";

export async function executeReadRepoFile(
  input: ReadRepoFileInput
): Promise<ReadRepoFileOutput> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN is not set — required to fetch files from GitHub");
  }

  const repo = input.repo;
  const path = input.path;
  const ref = input.ref ?? "main";
  const maxChars = input.max_chars ?? 8000;
  const rawUrl = `https://raw.githubusercontent.com/${repo}/${ref}/${path}`;

  const res = await fetch(rawUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 404) {
    return {
      found: false,
      content: null,
      message: `File not found: ${path} in ${repo}@${ref}`,
    };
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error("GitHub auth failed — check GITHUB_TOKEN secret");
  }

  if (!res.ok) {
    throw new Error(`GitHub fetch failed: HTTP ${res.status} for ${rawUrl}`);
  }

  const fullContent = await res.text();
  const truncated = fullContent.length > maxChars;
  const content = truncated ? fullContent.slice(0, maxChars) : fullContent;

  return {
    found: true,
    content,
    repo,
    path,
    ref,
    char_count: fullContent.length,
    truncated,
    raw_url: rawUrl,
  };
}
