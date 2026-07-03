export const AGENT_DIGEST_PATTERNS = {
    "Inbox Manager": ["Email Triage"],
    "Personal Ops Manager": ["Personal Triage"],
    "GitHub Insyncerator": ["GitHub Sync"],
    "Client Repo Auditor": ["Client Repo Audit"],
    "Docs Librarian": ["Docs Quick Scan", "Docs Cleanup Report"],
    "VEP Weekly Reporter": ["VEP Weekly Activity Report"],
    "Home & Life Task Watcher": ["Home & Life Weekly Digest"],
    "Time Log Auditor": ["Time Log Audit"],
    "Client Health Scorecard": ["Client Health Scorecard"],
    "Morning Briefing": ["Morning Briefing"],
    "Drift Watcher": ["Drift Watcher"],
    "Fleet Ops Agent": ["Fleet Ops"],
    "Response Drafter": ["Response Drafter", "Draft Status"],
    "Client Briefing Agent": ["Client Briefing", "Heartbeat Digest"],
    "Dev Environment Health": ["Dev Environment Health"],
};
export const AGENT_TARGET_DB = {
    "Inbox Manager": "agent_ops",
    "Personal Ops Manager": "home_docs",
    "GitHub Insyncerator": "agent_ops",
    "Client Repo Auditor": "agent_ops",
    "Docs Librarian": "agent_ops",
    "VEP Weekly Reporter": "agent_ops",
    "Home & Life Task Watcher": "home_docs",
    "Time Log Auditor": "agent_ops",
    "Client Health Scorecard": "agent_ops",
    "Morning Briefing": "agent_ops",
    "Drift Watcher": "agent_ops",
    "Fleet Ops Agent": "agent_ops",
    "Response Drafter": "agent_ops",
    "Client Briefing Agent": "agent_ops",
    "Dev Environment Health": "agent_ops",
};
export const VALID_AGENT_NAMES = Object.keys(AGENT_DIGEST_PATTERNS);
/**
 * Maps Notion display names (which may include workspace prefixes) to the
 * canonical short names used as keys in AGENT_DIGEST_PATTERNS and friends.
 * Add entries here when a Notion agent's display name diverges from its
 * canonical config name.
 */
const AGENT_NAME_ALIASES = {
    "Abstract Data - Inbox Manager": "Inbox Manager",
};
/**
 * Resolves an agent name to its canonical form.
 * Accepts both the short canonical name ("Inbox Manager") and the Notion
 * display name ("Abstract Data - Inbox Manager"). Returns the canonical
 * name if matched, or the original string unchanged if not recognised.
 */
export function resolveAgentName(name) {
    if (VALID_AGENT_NAMES.includes(name))
        return name;
    return AGENT_NAME_ALIASES[name] ?? name;
}
/** Agents that are suspended and should be skipped by fleet-wide scans. */
export const SUSPENDED_AGENTS = [
    "Personal Ops Manager",
    "VEP Weekly Reporter",
    "Client Health Scorecard",
    "Client Repo Auditor",
    "Drift Watcher",
    "Home & Life Task Watcher",
    "Docs Librarian",
    "Client Briefing Agent",
];
/** Agents that produce digest pages (used by fleet monitor). Excludes Fleet Ops Agent itself. */
export const MONITORED_AGENTS = VALID_AGENT_NAMES.filter((name) => !SUSPENDED_AGENTS.includes(name) && name !== "Fleet Ops Agent");
export const AGENT_CADENCE = {
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
    // Time Log Auditor moved daily → 36h staleness threshold matches the agent-to-worker
    // conversion (audit-time-log runs daily now; a 36h silence is a real signal).
    "Time Log Auditor": "daily",
    "Drift Watcher": "weekly",
    "Client Health Scorecard": "monthly",
    "Dev Environment Health": "weekly",
};
export const STALENESS_THRESHOLDS = {
    daily: 36,
    weekly: 216,
    biweekly: 432,
    monthly: 960,
};
export function isValidAgentName(name) {
    return VALID_AGENT_NAMES.includes(resolveAgentName(name));
}
/** First digest pattern for an agent — used as default digest type in page titles. */
export function getDefaultDigestType(agentName) {
    const patterns = AGENT_DIGEST_PATTERNS[agentName];
    if (!patterns || patterns.length === 0)
        return agentName;
    const first = patterns[0];
    return first ?? agentName;
}
