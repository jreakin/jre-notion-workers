/** Bot's own inbox — excluded entirely from Clef shadow data (John, 2026-10-13; #36). */
export const EXCLUDED_ADDRESS = "jre@mail.grokbot.com";
export const EXCLUDED_DOMAIN = "mail.grokbot.com";
/**
 * jre@ with any +alias, any case, URL-encoded `@`/`+` (%40/%2B), optional subdomain of mail.grokbot.com.
 * Bounded on both sides so notjre@…, …grokbot.community and …grokbot.com.attacker do not match.
 */
export const EXCLUDED_ADDRESS_RE =
  /(?<![a-z0-9._%+-])jre(?:(?:\+|%2b)[^@\s"%]*)?(?:@|%40)(?:[a-z0-9-]+\.)*mail\.grokbot\.com(?![a-z0-9-]|\.[a-z0-9])/i;

/**
 * Deep-scan structured fields only: keys in `freeTextKeys` (sender/author-controlled text) are
 * dropped at every depth, so free text can never trigger (or hide data via) exclusion.
 */
export function structuredMentionsExcludedAddress(
  value: unknown,
  freeTextKeys: ReadonlySet<string>,
): boolean {
  const strip = (v: unknown, depth: number): unknown => {
    if (depth > 12 || v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map((x) => strip(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (!freeTextKeys.has(k)) out[k] = strip(x, depth + 1);
    }
    return out;
  };
  try {
    return EXCLUDED_ADDRESS_RE.test(JSON.stringify(strip(value, 0)) ?? "");
  } catch {
    return false;
  }
}
