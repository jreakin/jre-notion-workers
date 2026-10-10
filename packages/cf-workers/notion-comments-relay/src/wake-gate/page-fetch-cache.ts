const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 64;

/** Cached parent resolution for comment.* only — never caches page properties. */
export type CommentParentResolution = "ad_docs" | "not_ad_docs";

interface CacheEntry {
  resolution: CommentParentResolution;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

export function resetPageFetchCache(): void {
  cache.clear();
}

export function getCachedCommentParentResolution(
  pageId: string,
  now = Date.now(),
): CommentParentResolution | null {
  const entry = cache.get(pageId);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    cache.delete(pageId);
    return null;
  }
  return entry.resolution;
}

export function setCachedCommentParentResolution(
  pageId: string,
  resolution: CommentParentResolution,
  ttlMs = DEFAULT_TTL_MS,
  now = Date.now(),
): void {
  if (cache.size >= DEFAULT_MAX_ENTRIES) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(pageId, { resolution, expiresAt: now + ttlMs });
}
