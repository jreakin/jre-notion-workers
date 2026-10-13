/** Defensive PII masking for subject/snippet. Box side should already mask; we re-mask anyway. */
const EMAIL_RE = /[A-Z0-9._%+'-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi;
/** URL-encoded `@` (user%40example.com). */
const EMAIL_ENC_RE = /[A-Z0-9._+'-]+%40[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi;
/**
 * Secret-looking tokens: Stripe sk_/pk_/rk_ live|test, GitHub ghp_/gho_/ghs_/ghu_/github_pat_,
 * Slack xox?-, AWS AKIA…, Google AIza…, Notion ntn_/secret_, OpenAI-style sk-…, Bearer tokens.
 */
const SECRET_RE =
  /\b(?:(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{6,}|(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|(?:ntn|secret)_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9_-]{16,})|\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g;
/** Scheme-less host (+ optional path) on common TLDs, e.g. evil.example/x, docs.foo.io. */
const BARE_DOMAIN_RE =
  /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|io|co|dev|app|ai|us|me|info|biz|xyz|gov|edu|example|test|cloud|site|online|tech|ly|gg|so|sh|to)\b(?::\d{2,5})?(?:\/[^\s"'<>)]*)?/gi;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
const PHONE_RE = /\+?\(?\d[\d\s().-]{7,}\d/g;
const DIGIT_RUN_RE = /\d[\d\s-]{4,}\d/g;

function maskDigitRun(m: string): string {
  return m.replace(/\D/g, "").length >= 6 ? "[num]" : m;
}

export function maskPii(text: string): string {
  return text
    .replace(SECRET_RE, "[secret]")
    .replace(EMAIL_RE, "[email]")
    .replace(EMAIL_ENC_RE, "[email]")
    .replace(URL_RE, "[url]")
    .replace(BARE_DOMAIN_RE, "[url]")
    .replace(PHONE_RE, (m) => (m.replace(/\D/g, "").length >= 7 ? "[phone]" : m))
    .replace(DIGIT_RUN_RE, maskDigitRun)
    .replace(/\d{6,}/g, "[num]");
}

/** Strip control chars, collapse whitespace, mask, then clip to max. */
export function cleanMaskClip(raw: string, max: number): string {
  const flat = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return maskPii(flat).slice(0, max);
}
