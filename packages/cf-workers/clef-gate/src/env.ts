export interface Env {
  CLEF_KV: KVNamespace;
  AI?: Ai;
  /** Bearer token for /clef/email-shadow* (wrangler secret). Unset ⇒ every request 401. */
  CLEF_EMAIL_SHADOW_TOKEN?: string;
  /** Non-secret AI Gateway id (clef-shadow-gate). */
  AI_GATEWAY_ID?: string;
  /** Max Clef calls per UTC day for gate clef_email (default 1000). */
  CLEF_EMAIL_DAILY_CALL_CAP?: string;
  /** Fallback mode when KV unset: off | shadow (default shadow). */
  CLEF_DEFAULT_MODE?: string;
}
