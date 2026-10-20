/**
 * Config for the deterministic echo + untracked-property filter (LOCK-69). One place for the agent
 * lane prefix list and the tracked-parent allowlist, so neither is scattered across the code.
 *
 * - Lane prefixes: the fleet's agent lane names. A comment whose text starts with one of these
 *   (`CoS:`, `[Steward]`, `EC →`, `**BCH:**` ...) is an agent echo. The CoS pre-filter
 *   (cos-prefilter.ts) reuses COS_LANE_PREFIX_NAMES from here for its own self_echo_lane rule.
 *   Extend at deploy time with ECHO_FILTER_LANE_PREFIXES (comma-separated names).
 * - Tracked parents: TRACKED_PARENT_IDS (comma-separated database / data source ids). When set, the
 *   relay's existing tracked parents (FLEET_LOCKS_DATA_SOURCE_ID / FLEET_LOCKS_DATABASE_ID and the
 *   AD Docs data source / AD_DOCS_DATABASE_ID) are always added, so the existing gates never lose
 *   their events. When TRACKED_PARENT_IDS is unset or empty the property rule FAILS OPEN (passes all).
 */
import type { Env } from "../env.js";
import { normalizeNotionUuid } from "./notion-ids.js";
import { AD_DOCS_DATA_SOURCE_ID } from "./wake-gate-types.js";

/** GrokBot Fleet Comments integration bot user (posts the fleet's comment replies). Always own-fleet. */
export const GROKBOT_FLEET_COMMENTS_BOT_ID = "3d87d7f5-6298-8165-8af9-0027a153ccbd";

/** Chief of Staff's own lane names (the CoS pre-filter's self_echo_lane list). */
export const COS_LANE_PREFIX_NAMES = ["CoS", "Chief of Staff"] as const;

/** Every fleet agent lane name. Matched case-sensitively at the start of the comment text. */
export const AGENT_LANE_PREFIX_NAMES = [
  ...COS_LANE_PREFIX_NAMES,
  "BCH",
  "AS",
  "Abstract Secretary",
  "Steward",
  "Notion Steward",
  "EC",
] as const;

/** Webhook types that only change page properties (rule 2). page.created is never in here. */
export const PROPERTY_ONLY_EVENT_TYPES = ["page.properties_updated"] as const;

/** Comment webhook types (rule 1). */
export const COMMENT_EVENT_TYPES = ["comment.created", "comment.updated", "comment.deleted"] as const;

/** Webhook author `type` values that mean a bot / integration user (never a human). */
export const BOT_AUTHOR_TYPES = ["bot"] as const;

export type EchoFilterConfig = {
  /** false when ECHO_FILTER=off (kill switch: pass everything, still logged). */
  enabled: boolean;
  johnUserIds: Set<string>;
  /** Own-fleet bot user ids (Fleet Comments bot + FLEET_COMMENTS_BOT_NOTION_USER_IDS). Normalized. */
  fleetBotIds: Set<string>;
  lanePrefixRe: RegExp;
  /** Normalized tracked parent ids. Empty ⇒ property rule fails open. */
  trackedParentIds: Set<string>;
};

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function splitCsv(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizedIdSet(raw: unknown): Set<string> {
  return new Set(splitCsv(raw).map(normalizeNotionUuid));
}

/**
 * Lane-prefix matcher: `Name:`, `Name —`, `Name →`, `Name ->`, `[Name]`, `**Name:**` at the very start.
 * Shared by this filter (case-sensitive) and the CoS pre-filter (case-insensitive).
 */
export function buildLanePrefixRe(names: readonly string[], flags = ""): RegExp {
  const alts = names.map(escapeRe).join("|");
  return new RegExp(
    `^[\\s*_]*(?:\\[(?:${alts})\\]|(?:${alts})[\\s*_]*(?::|—|–|→|->|-\\s))`,
    flags,
  );
}

export function echoFilterConfigFromEnv(env: Partial<Env>): EchoFilterConfig {
  const enabled = (typeof env.ECHO_FILTER === "string" ? env.ECHO_FILTER.trim().toLowerCase() : "") !== "off";
  const fleetBotIds = normalizedIdSet(env.FLEET_COMMENTS_BOT_NOTION_USER_IDS);
  fleetBotIds.add(normalizeNotionUuid(GROKBOT_FLEET_COMMENTS_BOT_ID));
  const trackedParentIds = normalizedIdSet(env.TRACKED_PARENT_IDS);
  if (trackedParentIds.size > 0) {
    // Existing relay-tracked parents are always tracked once the allowlist is on.
    for (const id of [
      env.FLEET_LOCKS_DATA_SOURCE_ID,
      env.FLEET_LOCKS_DATABASE_ID,
      env.AD_DOCS_DATABASE_ID,
      AD_DOCS_DATA_SOURCE_ID,
    ]) {
      if (typeof id === "string" && id.trim()) trackedParentIds.add(normalizeNotionUuid(id));
    }
  }
  return {
    enabled,
    johnUserIds: normalizedIdSet(env.JOHN_NOTION_USER_IDS),
    fleetBotIds,
    lanePrefixRe: buildLanePrefixRe([...AGENT_LANE_PREFIX_NAMES, ...splitCsv(env.ECHO_FILTER_LANE_PREFIXES)]),
    trackedParentIds,
  };
}
