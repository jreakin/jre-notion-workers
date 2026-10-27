import type { GateLogBuffer } from "./gate-log-do.js";

export interface Env {
  /** SQLite-backed Durable Object holding gate_log rows until the alarm flushes them to KV. */
  GATE_LOG_DO?: DurableObjectNamespace<GateLogBuffer>;
  RELAY_KV: KVNamespace;
  AI?: Ai;
  /** Comma-separated property IDs known to be non-Submitted (optional allowlist). */
  NON_SUBMITTED_PROPERTY_IDS?: string;
  /** Alert-level console log once/day when metered RELAY_KV writes pass this (default 800). */
  KV_WRITE_ALERT_THRESHOLD?: string;
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
  /** Daily cap for false-skip checks of dedupe repeats (separate from rule-skip checks; default 100). */
  CLEF_DEDUPE_REPEAT_DAILY_CAP?: string;
  /** Fallback Clef mode when KV unset: off | shadow only. */
  CLEF_DEFAULT_MODE?: string;
  /** Comma-separated Gate Log data source / database ids — drop before rule gates. */
  GATE_LOG_DATA_SOURCE_IDS?: string;

  COS_WEBHOOK_URL: string;
  COS_WEBHOOK_AUTHORIZATION: string;
  SETUP_SECRET: string;
  /** Shared secret for unsigned Notion automation webhooks (header X-Relay-Automation-Secret). */
  NOTION_AUTOMATION_SECRET?: string;
  /** Abstract Secretary Grok Bot webhook ingress URL (plan-approved automation wake). */
  AS_WEBHOOK_URL?: string;
  /** `Authorization` header value for AS (Bearer prefix added if missing). */
  AS_WEBHOOK_AUTHORIZATION?: string;
  NOTION_VERIFICATION_TOKEN?: string;
  /** Notion integration token for shadow gate property fetch (name only in wrangler/README). */
  NOTION_API_TOKEN?: string;
  /** Comma-separated Notion user ids — comment from John always would_wake. */
  JOHN_NOTION_USER_IDS?: string;
  /** Comma-separated Notion user ids — fleet bot comments may would_skip on comment.* only. */
  FLEET_COMMENTS_BOT_NOTION_USER_IDS?: string;
  /** Comma-separated opaque property ids for Submitted — never would_skip updates touching these. */
  SUBMITTED_PROPERTY_IDS?: string;
  /**
   * Comma-separated property ids for "Needs John". Shadow rule: when this AND SUBMITTED_PROPERTY_IDS are
   * set, a page.properties_updated whose updated ids touch neither set is would_skip
   * (`no_submitted_or_needs_john_change`). Unset ⇒ rule inert (old behavior).
   */
  NEEDS_JOHN_PROPERTY_IDS?: string;
  /** Seconds a repeat event for the same item+event type is deduped before Clef (default 600; 0 = off). */
  CLEF_ITEM_DEDUPE_WINDOW_S?: string;
  /** Set to `1` to append truncated decisions to KV ring buffer (default off). */
  WAKE_GATE_KV_RING?: string;
  /**
   * CoS pre-filter (ack-only / self-echo / non-actionable property). `1` = LIVE: matching events are not
   * forwarded to CoS. Anything else (default) = SHADOW: log `would_drop` to stream cos_prefilter, forward anyway.
   */
  COS_PREFILTER_LIVE?: string;
  /** Extra comma-separated lane prefixes treated as agent self-echo ("CoS:", "[BCH]"...); added to built-ins. */
  COS_PREFILTER_LANE_PREFIXES?: string;
  /**
   * Deterministic echo + untracked-property filter (LOCK-69). LIVE by default; `off` = pass everything
   * (verdicts still logged with reason filter_disabled).
   */
  ECHO_FILTER?: string;
  /** Extra comma-separated agent lane names for the echo filter's agent_prefix rule (added to built-ins). */
  ECHO_FILTER_LANE_PREFIXES?: string;
  /**
   * Comma-separated tracked parent database / data source ids. page.properties_updated on any other
   * parent is dropped (untracked_property_edit). Unset / empty ⇒ fail open (no property drops). When set,
   * Fleet Locks and AD Docs ids are always added.
   */
  TRACKED_PARENT_IDS?: string;
  /** Set to `1` to persist page dedupe keys in KV (default off; each put counts toward RELAY_KV quota). */
  WAKE_GATE_DEDUPE?: string;
  /** Notion database id for AD Docs (2022-06-28 page parent); non-secret. Pair with data source id in gate logic. */
  AD_DOCS_DATABASE_ID?: string;
}
