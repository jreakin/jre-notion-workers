/** Defensive PII masking for subject/snippet. Box side should already mask; we re-mask anyway. */
const EMAIL_RE = /[A-Z0-9._%+'-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
const PHONE_RE = /\+?\(?\d[\d\s().-]{7,}\d/g;
const DIGIT_RUN_RE = /\d[\d\s-]{4,}\d/g;

function maskDigitRun(m: string): string {
  return m.replace(/\D/g, "").length >= 6 ? "[num]" : m;
}

export function maskPii(text: string): string {
  return text
    .replace(EMAIL_RE, "[email]")
    .replace(URL_RE, "[url]")
    .replace(PHONE_RE, (m) => (m.replace(/\D/g, "").length >= 7 ? "[phone]" : m))
    .replace(DIGIT_RUN_RE, maskDigitRun)
    .replace(/\d{6,}/g, "[num]");
}

/** Strip control chars, collapse whitespace, mask, then clip to max. */
export function cleanMaskClip(raw: string, max: number): string {
  const flat = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return maskPii(flat).slice(0, max);
}
