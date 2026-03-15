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
  "Home & Life Task Watcher": ["Home & Life Weekly Digest"],
  "Template Freshness Watcher": ["Setup Template Freshness Report"],
  "Time Log Auditor": ["Time Log Audit"],
  "Client Health Scorecard": ["Client Health Scorecard"],
  "Morning Briefing": ["Morning Briefing"],
  "Drift Watcher": ["Drift Watcher"],
  "Fleet Ops Agent": ["Fleet Ops"],
  "Response Drafter": ["Response Drafter", "Draft Status"],
  "Client Briefing Agent": ["Client Briefing"],
};

export const AGENT_TARGET_DB: Record<string, TargetDatabase> = {
  "Inbox Manager": "docs",
  "Personal Ops Manager": "home_docs",
  "GitHub Insyncerator": "docs",
  "Client Repo Auditor": "docs",
  "Docs Librarian": "docs",
  "VEP Weekly Reporter": "docs",
  "Home & Life Task Watcher": "home_docs",
  "Template Freshness Watcher": "docs",
  "Time Log Auditor": "docs",
  "Client Health Scorecard": "docs",
  "Morning Briefing": "docs",
  "Drift Watcher": "docs",
  "Fleet Ops Agent": "docs",
  "Response Drafter": "docs",
  "Client Briefing Agent": "docs",
};

export const VALID_AGENT_NAMES = Object.keys(AGENT_DIGEST_PATTERNS);

/** Agents that are suspended and should be skipped by fleet-wide scans. */
export const SUSPENDED_AGENTS: string[] = ["Template Freshness Watcher"];

/** Agents that produce digest pages (used by fleet monitor). Excludes Fleet Ops Agent itself. */
export const MONITORED_AGENTS = VALID_AGENT_NAMES.filter(
  (name) => !SUSPENDED_AGENTS.includes(name) && name !== "Fleet Ops Agent"
);

export type AgentCadence = "daily" | "weekly" | "biweekly" | "monthly";

export const AGENT_CADENCE: Record<string, AgentCadence> = {
  "Inbox Manager": "daily",
  "Personal Ops Manager": "daily",
  "GitHub Insyncerator": "daily",
  "Morning Briefing": "daily",
  "Fleet Ops Agent": "daily",
  "Response Drafter": "daily",
  "Client Briefing Agent": "daily",
  "Client Repo Auditor": "weekly",
  "Docs Librarian": "biweekly",
  "VEP Weekly Reporter": "weekly",
  "Home & Life Task Watcher": "weekly",
  "Time Log Auditor": "weekly",
  "Drift Watcher": "weekly",
  "Client Health Scorecard": "monthly",
  "Template Freshness Watcher": "monthly",
};

export const STALENESS_THRESHOLDS: Record<AgentCadence, number> = {
  daily: 36,
  weekly: 216,
  biweekly: 432,
  monthly: 960,
};

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
