export interface Env {
  RELAY_KV: KVNamespace;
  AI?: Ai;
  /** Comma-separated property IDs known to be non-Submitted (optional allowlist). */
  NON_SUBMITTED_PROPERTY_IDS?: string;
  /** Max gate_log ring KV flush writes per UTC day (default 60). */
  GATE_LOG_DAILY_WRITE_CAP?: string;
  /** Set to "1" to enable Clef shadow KV ring (default off; Workers Logs mirror console). */
  CLEF_RING?: string;
  /** Notion data source id for Fleet: Locks (adopted-change gate). */
  FLEET_LOCKS_DATA_SOURCE_ID?: string;
  /** Fleet: Locks database id (2022 API parent.database_id fallback). */
  FLEET_LOCKS_DATABASE_ID?: string;
  /** Non-secret Cloudflare AI Gateway id (optional). */
  AI_GATEWAY_ID?: string;
  /** Max Clef Workers AI calls per UTC day (default 2000). */
  CLEF_DAILY_CALL_CAP?: string;
  /** Max shadow-only Clef calls/day for rule-skipped events (default 200; 0 disables). */
  CLEF_RULE_SKIP_DAILY_CAP?: string;
  /** Percent of rule-skipped events sampled into Clef shadow scoring (default 50). */
  CLEF_RULE_SKIP_SAMPLE_PERCENT?: string;
  /** Fallback Clef mode when KV unset: off | shadow only. */
  CLEF_DEFAULT_MODE?: string;
  /** Comma-separated Gate Log data source / database ids — drop before rule gates. */
  GATE_LOG_DATA_SOURCE_IDS?: string;

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
  /** Notion database id for AD Docs (2022-06-28 page parent); non-secret. Pair with data source id in gate logic. */
  AD_DOCS_DATABASE_ID?: string;
}
