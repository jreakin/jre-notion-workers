const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 64;

interface CacheEntry {
  page: Record<string, unknown>;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

export function resetPageFetchCache(): void {
  cache.clear();
}

export function getCachedNotionPage(pageId: string, now = Date.now()): Record<string, unknown> | null {
  const entry = cache.get(pageId);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    cache.delete(pageId);
    return null;
  }
  return entry.page;
}

export function setCachedNotionPage(
  pageId: string,
  page: Record<string, unknown>,
  ttlMs = DEFAULT_TTL_MS,
  now = Date.now(),
): void {
  if (cache.size >= DEFAULT_MAX_ENTRIES) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(pageId, { page, expiresAt: now + ttlMs });
}
