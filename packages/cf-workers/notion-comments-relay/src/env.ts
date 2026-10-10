export interface Env {
  RELAY_KV: KVNamespace;
  COS_WEBHOOK_URL: string;
  COS_WEBHOOK_AUTHORIZATION: string;
  SETUP_SECRET: string;
  NOTION_VERIFICATION_TOKEN?: string;
  /** Notion integration token for shadow gate property fetch (name only in wrangler/README). */
  NOTION_API_TOKEN?: string;
  /** Comma-separated Notion user ids — comment from John always would_wake. */
  JOHN_NOTION_USER_IDS?: string;
  /** Comma-separated Notion user ids — fleet bot comments may would_skip on comment.* only. */
  FLEET_COMMENTS_BOT_NOTION_USER_IDS?: string;
  /** Comma-separated opaque property ids for Submitted — never would_skip updates touching these. */
  SUBMITTED_PROPERTY_IDS?: string;
  /** Set to `1` to append truncated decisions to KV ring buffer (default off). */
  WAKE_GATE_KV_RING?: string;
  /** Set to `1` to persist page dedupe keys in KV (default off; each put counts toward RELAY_KV quota). */
  WAKE_GATE_DEDUPE?: string;
}
