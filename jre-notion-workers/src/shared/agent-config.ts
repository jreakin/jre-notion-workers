/**
 * Agent name → digest title pattern and target DB. Used by check-upstream-status and write-agent-digest.
 */
import type { TargetDatabase } from "./types.js";

export const AGENT_DIGEST_PATTERNS: Record<string, string[]> = {
  "Inbox Manager": ["Email Triage"],
  "Personal Ops Manager": ["Personal Triage"],
  "GitHub Insyncerator": ["GitHub Sync"],
  "Client Repo Auditor": ["Client Repo Audit"],
  "Docs Librarian": ["Docs Quick Scan", "Docs Cleanup Report"],
  "VEP Weekly Reporter": ["VEP Weekly Activity Report"],
  "Home & Life Watcher": ["Home & Life Weekly Digest"],
  "Template Freshness Watcher": ["Setup Template Freshness Report"],
  "Time Log Auditor": ["Time Log Audit"],
  "Client Health Scorecard": ["Client Health Scorecard"],
  "Morning Briefing": ["Morning Briefing"],
  "Fleet Monitor": [],
  "Dead Letter Logger": ["Dead Letter Log"],
  "Credit Forecast Tracker": ["Credit Forecast"],
};

export const AGENT_TARGET_DB: Record<string, TargetDatabase> = {
  "Inbox Manager": "docs",
  "Personal Ops Manager": "home_docs",
  "GitHub Insyncerator": "docs",
  "Client Repo Auditor": "docs",
  "Docs Librarian": "docs",
  "VEP Weekly Reporter": "docs",
  "Home & Life Watcher": "home_docs",
  "Template Freshness Watcher": "docs",
  "Time Log Auditor": "docs",
  "Client Health Scorecard": "docs",
  "Morning Briefing": "docs",
  "Fleet Monitor": "docs",
  "Dead Letter Logger": "docs",
  "Credit Forecast Tracker": "docs",
};

export const VALID_AGENT_NAMES = Object.keys(AGENT_DIGEST_PATTERNS);

/** Agents that are suspended and should be skipped by fleet-wide scans. */
export const SUSPENDED_AGENTS: string[] = ["Template Freshness Watcher"];

/** Agents that produce digest pages (used by fleet monitor). Excludes Fleet Monitor itself (heartbeat comment only). */
export const MONITORED_AGENTS = VALID_AGENT_NAMES.filter(
  (name) => !SUSPENDED_AGENTS.includes(name) && name !== "Fleet Monitor"
);

export function isValidAgentName(name: string): boolean {
  return VALID_AGENT_NAMES.includes(name);
}

/** First digest pattern for an agent — used as default digest type in page titles. */
export function getDefaultDigestType(agentName: string): string {
  const patterns = AGENT_DIGEST_PATTERNS[agentName];
  if (!patterns || patterns.length === 0) return agentName;
  const first = patterns[0];
  return first ?? agentName;
}
