import { APIResponseError, extractErrorMessage } from "./notion-client.js";
export const LOGICAL_DEPENDENCIES = [
    { envVar: "DOCS_DATABASE_ID", logicalName: "Docs database", kind: "database", required: true, target: "docs" },
    { envVar: "HOME_DOCS_DATABASE_ID", logicalName: "Home Docs database", kind: "database", required: true, target: "home_docs" },
    { envVar: "AGENT_OPS_DATABASE_ID", logicalName: "Agent Ops digest database", kind: "database", required: true, target: "agent_ops" },
    { envVar: "TASKS_DATABASE_ID", logicalName: "Tasks database", kind: "database", required: true },
    { envVar: "DEAD_LETTERS_DATABASE_ID", logicalName: "Dead Letters database", kind: "database", required: true },
    { envVar: "SYSTEM_CONTROL_PLANE_PAGE_ID", logicalName: "System Control Plane page", kind: "page", required: true },
    { envVar: "FOLLOW_UP_TRACKER_DATABASE_ID", logicalName: "Follow-Up Tracker database", kind: "database", required: false },
    { envVar: "AI_MEETINGS_DATABASE_ID", logicalName: "AI Meeting Notes database", kind: "database", required: false },
    { envVar: "CLIENTS_DATABASE_ID", logicalName: "Clients database", kind: "database", required: false },
    { envVar: "CONTACTS_DATABASE_ID", logicalName: "Contacts database", kind: "database", required: false },
    { envVar: "PROJECTS_DATABASE_ID", logicalName: "Projects database", kind: "database", required: false },
    { envVar: "DECISION_LOG_DATABASE_ID", logicalName: "Decision Log database", kind: "database", required: false },
    { envVar: "LABEL_REGISTRY_DATABASE_ID", logicalName: "Label Registry database", kind: "database", required: false },
    { envVar: "TIME_LOG_DATABASE_ID", logicalName: "Time Log database", kind: "database", required: false },
];
/** Fallback env var per TargetDatabase. Optional; opt-in by setting in env. */
const FALLBACK_ENV_BY_TARGET = {
    docs: "DOCS_DATABASE_FALLBACK_URL",
    home_docs: "HOME_DOCS_DATABASE_FALLBACK_URL",
    agent_ops: "AGENT_OPS_DATABASE_FALLBACK_URL",
};
/** Reserved for messages: workers integration display name. Optional. */
const INTEGRATION_NAME_ENV = "NOTION_INTEGRATION_NAME";
/**
 * Strip a Notion URL (page or database) down to its 32-char hex ID, dashed.
 * Accepts: raw 32-char hex (with or without dashes), or notion.so URLs.
 * Returns null if no usable ID can be extracted.
 */
export function extractNotionIdFromUrlOrId(input) {
    if (!input)
        return null;
    const cleaned = input.trim();
    if (!cleaned)
        return null;
    // Match the last 32-char hex segment in the string, dashed or not.
    const match = cleaned.match(/[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
    if (!match)
        return null;
    const stripped = match[0].replace(/-/g, "");
    if (stripped.length !== 32)
        return null;
    return [
        stripped.slice(0, 8),
        stripped.slice(8, 12),
        stripped.slice(12, 16),
        stripped.slice(16, 20),
        stripped.slice(20),
    ].join("-");
}
/** Truncate a Notion ID to first 8 chars for safe display in error notices. */
export function shortId(id) {
    if (!id)
        return "(unset)";
    return `${id.slice(0, 8)}…`;
}
/**
 * Best-effort: get the configured fallback URL/ID for a TargetDatabase.
 * Returns null if not configured or unparseable.
 */
export function getFallbackDatabaseId(target) {
    const envName = FALLBACK_ENV_BY_TARGET[target];
    return extractNotionIdFromUrlOrId(process.env[envName]);
}
/** Get a friendly integration name for messages, or a sensible default. */
export function getIntegrationName() {
    return process.env[INTEGRATION_NAME_ENV] || "the workers integration (NTN_API_TOKEN)";
}
export function classifyNotionError(e) {
    if (e instanceof APIResponseError) {
        if (e.code === "object_not_found")
            return { code: "object_not_found", rawMessage: e.message };
        if (e.code === "unauthorized")
            return { code: "unauthorized", rawMessage: e.message };
        if (e.code === "restricted_resource")
            return { code: "restricted_resource", rawMessage: e.message };
        if (e.code === "validation_error")
            return { code: "validation_error", rawMessage: e.message };
        return { code: "other", rawMessage: `[${e.code}] ${e.message}` };
    }
    return { code: "other", rawMessage: extractErrorMessage(e) };
}
/**
 * Translate a caught Notion API error into a deterministic, actionable payload.
 * Workers should call this in their catch blocks instead of just `extractErrorMessage`.
 */
export function formatNotionResourceError(e, context) {
    const { code, rawMessage } = classifyNotionError(e);
    const integration = getIntegrationName();
    const idDisplay = shortId(context.attemptedId);
    const kindLabel = context.kind === "database" ? "database" : "page";
    let message;
    let remediation;
    switch (code) {
        case "object_not_found":
            message = `Notion ${kindLabel} not found: ${context.logicalName} (${idDisplay}, env ${context.envVar})`;
            remediation = [
                `Open the ${context.logicalName} in Notion.`,
                `Click "..." → "Connections" → add ${integration}.`,
                `Verify ${context.envVar} matches the ${kindLabel} ID (32 hex chars, no dashes).`,
                `If the ${kindLabel} was renamed/moved, copy the new link and update ${context.envVar}.`,
            ];
            break;
        case "unauthorized":
        case "restricted_resource":
            message = `Notion ${kindLabel} access denied: ${context.logicalName} (${idDisplay}, env ${context.envVar})`;
            remediation = [
                `Open the ${context.logicalName} in Notion.`,
                `Click "..." → "Connections" → add ${integration}.`,
                `Confirm the parent page also grants access (Notion permission cascades from the parent).`,
            ];
            break;
        case "validation_error":
            message = `Notion validation error reading ${context.logicalName} (${idDisplay}, env ${context.envVar}): ${rawMessage}`;
            remediation = [
                `Verify ${context.envVar} is a 32-char hex Notion ID (with or without dashes).`,
                `If you pasted a URL, use only the ID portion.`,
            ];
            break;
        default:
            message = `Notion API error reading ${context.logicalName} (${idDisplay}, env ${context.envVar}): ${rawMessage}`;
            remediation = [
                `Re-run \`bun run preflight\` to confirm whether the resource is reachable.`,
                `Check Notion status / your network if this persists.`,
            ];
    }
    const notice = `⚠️ ${message} — Remediation: ${remediation.join(" ")}`;
    return { code, message, remediation, notice };
}
/**
 * Walk every LOGICAL_DEPENDENCY and check reachability against the live Notion API.
 * Use to power `bun run preflight` and as a fast CI smoke test.
 */
export async function preflightValidate(notion) {
    const checks = [];
    for (const dep of LOGICAL_DEPENDENCIES) {
        const raw = process.env[dep.envVar];
        const attemptedId = extractNotionIdFromUrlOrId(raw);
        const configured = !!attemptedId;
        if (!configured) {
            checks.push({
                envVar: dep.envVar,
                logicalName: dep.logicalName,
                kind: dep.kind,
                required: dep.required,
                configured: false,
                attemptedId: null,
                accessible: false,
                errorCode: dep.required ? "validation_error" : null,
                remediation: dep.required
                    ? [`Set ${dep.envVar} in your .env (or via 1Password / ntn workers env set).`]
                    : null,
            });
            continue;
        }
        try {
            if (dep.kind === "database") {
                await notion.databases.retrieve({ database_id: attemptedId });
            }
            else {
                await notion.pages.retrieve({ page_id: attemptedId });
            }
            checks.push({
                envVar: dep.envVar,
                logicalName: dep.logicalName,
                kind: dep.kind,
                required: dep.required,
                configured: true,
                attemptedId,
                accessible: true,
                errorCode: null,
                remediation: null,
            });
        }
        catch (e) {
            const formatted = formatNotionResourceError(e, {
                logicalName: dep.logicalName,
                envVar: dep.envVar,
                attemptedId,
                kind: dep.kind,
            });
            checks.push({
                envVar: dep.envVar,
                logicalName: dep.logicalName,
                kind: dep.kind,
                required: dep.required,
                configured: true,
                attemptedId,
                accessible: false,
                errorCode: formatted.code,
                remediation: formatted.remediation,
            });
        }
    }
    const passing = checks.filter((c) => c.accessible).length;
    const failing = checks.filter((c) => !c.accessible && c.configured).length;
    const missingRequired = checks.filter((c) => c.required && !c.configured).length;
    const ok = failing === 0 && missingRequired === 0;
    const summary = ok
        ? `Preflight OK: ${passing}/${checks.length} Notion resources reachable.`
        : `Preflight FAILED: ${failing} broken, ${missingRequired} missing required (${passing}/${checks.length} OK).`;
    return { ok, checked: checks.length, passing, failing, missingRequired, checks, summary };
}
