/**
 * Config for the deterministic echo + untracked-property filter (LOCK-69). One place for the fleet
 * bot ids, the LOCK-39 lane names and the tracked data source allowlist.
 *
 * - Fleet bot ids (FLEET_BOT_AUTHOR_IDS + FLEET_COMMENTS_BOT_NOTION_USER_IDS): authors whose comment.* /
 *   page.moved events are own echoes. Explicit ids only: other integrations (Zoho, BetterStack, Context7,
 *   Zoho Flow ...) are NOT fleet, and the Notion system bot is never an echo.
 * - LOCK-39 lane names (ECHO_FILTER_LANE_NAMES CSV, replaces the default list when set): a comment whose
 *   text starts with "<Lane> Agent for John Eakin —" (or "for Shadow Seeker") is an agent echo, even when
 *   the author is John's own account.
 * - Tracked data sources (TRACKED_DATA_SOURCE_IDS CSV; TRACKED_PARENT_IDS is a deprecated alias, merged):
 *   page.properties_updated on any other parent is dropped. When the list is set, Fleet Locks and AD Docs
 *   are always added. Unset / empty ⇒ the property rule FAILS OPEN (passes all).
 */
import type { Env } from "../env.js";
import { normalizeNotionUuid } from "./notion-ids.js";
import { AD_DOCS_DATA_SOURCE_ID } from "./wake-gate-types.js";

/** GrokBot Fleet Comments integration bot user (posts the fleet's comment replies). */
export const GROKBOT_FLEET_COMMENTS_BOT_ID = "3d87d7f5-6298-8165-8af9-0027a153ccbd";

/** Own-fleet bot / integration users (LOCK-69 spec rule 4). */
export const FLEET_BOT_AUTHOR_IDS = [
  GROKBOT_FLEET_COMMENTS_BOT_ID, // GrokBot Fleet Comments
  "3767d7f5-6298-8191-aff3-00273b425c98", // jre-agent-dev-cli
  "2ec7d7f5-6298-8168-bb45-0027cc92930e", // Notion MCP
  "3167d7f5-6298-81d7-b2bd-00271cbdf192", // JRE Workers
] as const;

/** Notion's own system bot. Never an echo, even if someone adds it to a config var. */
export const NOTION_SYSTEM_BOT_ID = "00000000-0000-0000-0000-000000000003";

/** Fleet: Artifacts data source. The Submitted check only applies to this parent (spec rule 6). */
export const FLEET_ARTIFACTS_DATA_SOURCE_ID = "fb951b3e-3033-41b8-9214-a66619e1776a";

/** Chief of Staff's own short lane names (the CoS pre-filter's self_echo_lane list). */
export const COS_LANE_PREFIX_NAMES = ["CoS", "Chief of Staff"] as const;

/** Default LOCK-39 lane names ("<Lane> Agent for John Eakin —"). Override with ECHO_FILTER_LANE_NAMES. */
export const DEFAULT_LOCK39_LANE_NAMES = [
  "Chief of Staff",
  "Abstract Secretary",
  "Dev Delegator",
  "Quorum Report PM",
  "QR Launch Lead",
  "QR Frontend Engineer",
  "QR Backend Engineer",
  "Inbox Triage",
  "Personal Ops",
  "Travel Desk",
  "VEP Desk",
  "UniFi Umpire",
  "Notion Steward",
  "Rundown",
  "dr eggbot",
  "Bot Computer Harness",
  "Enterprise Cartographer",
  "Enterprise Researcher",
  "Enterprise Engineer",
  "ADE Sweeps",
  "LegiScan Backfill",
  "TX Elections Engineer",
  "Quorum Report Frontend Engineer",
  "Quorum Report Backend Engineer",
  "Quorum Report Launch Lead",
] as const;

/** Webhook types that only change page properties (rule 2). page.created is never in here. */
export const PROPERTY_ONLY_EVENT_TYPES = ["page.properties_updated"] as const;

/** Comment webhook types. */
export const COMMENT_EVENT_TYPES = ["comment.created", "comment.updated", "comment.deleted"] as const;

/** Types where an all-fleet author set is an own echo (spec rule 5: never properties_updated). */
export const AUTHOR_ECHO_EVENT_TYPES = [...COMMENT_EVENT_TYPES, "page.moved"] as const;

export type EchoFilterConfig = {
  /** false when ECHO_FILTER=off (kill switch: pass everything, still logged). */
  enabled: boolean;
  johnUserIds: Set<string>;
  /** Normalized own-fleet bot ids (never contains the Notion system bot). */
  fleetBotIds: Set<string>;
  /** LOCK-39 full-form prefix matcher (apply to text with leading whitespace / ** stripped). */
  lock39Re: RegExp;
  /** Normalized tracked data source / database ids. Empty ⇒ property rule fails open. */
  trackedParentIds: Set<string>;
  /** Normalized Submitted property ids (SUBMITTED_PROPERTY_IDS, URL-decoded). */
  submittedPropertyIds: Set<string>;
  /** Normalized Needs John property ids (NEEDS_JOHN_PROPERTY_IDS, URL-decoded). */
  needsJohnPropertyIds: Set<string>;
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

export function decodePropertyId(id: string): string {
  const t = id.trim();
  try {
    return decodeURIComponent(t);
  } catch {
    return t;
  }
}

/**
 * Short lane-prefix matcher (`Name:`, `Name —`, `[Name]`, `**Name:**` ...). Used by the CoS pre-filter's
 * bot-only self_echo_lane rule. The echo filter no longer drops on short tags (bots are already own_echo).
 */
export function buildLanePrefixRe(names: readonly string[], flags = ""): RegExp {
  const alts = names.map(escapeRe).join("|");
  return new RegExp(
    `^[\\s*_]*(?:\\[(?:${alts})\\]|(?:${alts})[\\s*_]*(?::|—|–|→|->|-\\s))`,
    flags,
  );
}

/** LOCK-39 full form: ^(<Lane>) Agent for (John Eakin|Shadow Seeker)\s*[—–:-], case-insensitive. */
export function buildLock39Re(lanes: readonly string[]): RegExp {
  const alts = lanes.map(escapeRe).join("|");
  return new RegExp(`^(?:${alts}) Agent for (?:John Eakin|Shadow Seeker)\\s*[—–:-]`, "i");
}

/**
 * Strip `**` anywhere (so "**X Agent for John Eakin** —" and "**X Agent for John Eakin —**" match) and
 * leading whitespace before the start-anchored LOCK-39 match.
 */
export function stripLeadForPrefix(text: string): string {
  return text.replace(/\*\*/g, "").replace(/^\s+/, "");
}

export function echoFilterConfigFromEnv(env: Partial<Env>): EchoFilterConfig {
  const enabled = (typeof env.ECHO_FILTER === "string" ? env.ECHO_FILTER.trim().toLowerCase() : "") !== "off";
  const systemBot = normalizeNotionUuid(NOTION_SYSTEM_BOT_ID);
  const fleetBotIds = normalizedIdSet(env.FLEET_COMMENTS_BOT_NOTION_USER_IDS);
  for (const id of FLEET_BOT_AUTHOR_IDS) fleetBotIds.add(normalizeNotionUuid(id));
  fleetBotIds.delete(systemBot);

  const trackedParentIds = normalizedIdSet(env.TRACKED_DATA_SOURCE_IDS);
  for (const id of normalizedIdSet(env.TRACKED_PARENT_IDS)) trackedParentIds.add(id);
  if (trackedParentIds.size > 0) {
    // Defaults (Fleet Locks + AD Docs) are always tracked once the allowlist is on.
    for (const id of [
      env.FLEET_LOCKS_DATA_SOURCE_ID,
      env.FLEET_LOCKS_DATABASE_ID,
      env.AD_DOCS_DATABASE_ID,
      AD_DOCS_DATA_SOURCE_ID,
    ]) {
      if (typeof id === "string" && id.trim()) trackedParentIds.add(normalizeNotionUuid(id));
    }
  }

  const laneOverride = splitCsv(env.ECHO_FILTER_LANE_NAMES);
  return {
    enabled,
    johnUserIds: normalizedIdSet(env.JOHN_NOTION_USER_IDS),
    fleetBotIds,
    lock39Re: buildLock39Re(laneOverride.length > 0 ? laneOverride : DEFAULT_LOCK39_LANE_NAMES),
    trackedParentIds,
    submittedPropertyIds: new Set(splitCsv(env.SUBMITTED_PROPERTY_IDS).map(decodePropertyId)),
    needsJohnPropertyIds: new Set(splitCsv(env.NEEDS_JOHN_PROPERTY_IDS).map(decodePropertyId)),
  };
}
