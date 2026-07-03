/**
 * Shared Notion SDK client.
 * Uses NTN_API_TOKEN env var (NOTION_TOKEN is a reserved prefix in the Workers SDK).
 */
import { Client, APIResponseError, isNotionClientError } from "@notionhq/client";
/**
 * Pinned Notion API version.
 * Locking this prevents behaviour drift when upgrading @notionhq/client.
 * Bump explicitly (and audit all workers) when migrating to a newer API version.
 *
 * 2026-03-11 breaking changes (all handled in this codebase):
 *   - `archived` → `in_trash` (we never wrote `archived` to the API)
 *   - `after` → `position` in block append (we write pages via markdown API now)
 *   - `transcription` → `meeting_notes` block type (not used)
 */
const NOTION_API_VERSION = "2026-03-11";
let cachedClient = null;
export function getNotionClient() {
    const token = process.env.NTN_API_TOKEN;
    if (!token) {
        throw new Error("NTN_API_TOKEN is not set");
    }
    if (!cachedClient) {
        cachedClient = new Client({
            auth: token,
            notionVersion: NOTION_API_VERSION,
        });
    }
    return cachedClient;
}
export { APIResponseError, isNotionClientError };
/**
 * Extracts a human-readable error message from any caught value.
 * If it's a Notion API error, prefixes with the API error code (e.g. "object_not_found")
 * so agent digests and dead letters carry actionable diagnostics.
 */
/** Returns the raw NTN_API_TOKEN for use in direct fetch calls (e.g. markdown API). */
export function getNtnApiToken() {
    const token = process.env.NTN_API_TOKEN;
    if (!token)
        throw new Error("NTN_API_TOKEN is not set");
    return token;
}
export function extractErrorMessage(e) {
    if (e instanceof APIResponseError) {
        return `[${e.code}] ${e.message}`;
    }
    if (e instanceof Error) {
        return e.message;
    }
    return String(e);
}
export function getDocsDatabaseId() {
    const id = process.env.DOCS_DATABASE_ID;
    if (!id)
        throw new Error("DOCS_DATABASE_ID is not set");
    return id;
}
export function getHomeDocsDatabaseId() {
    const id = process.env.HOME_DOCS_DATABASE_ID;
    if (!id)
        throw new Error("HOME_DOCS_DATABASE_ID is not set");
    return id;
}
export function getAgentOpsDatabaseId() {
    const id = process.env.AGENT_OPS_DATABASE_ID;
    if (!id)
        throw new Error("AGENT_OPS_DATABASE_ID is not set");
    return id;
}
/**
 * Resolves a TargetDatabase value to its corresponding Notion database ID.
 * Centralises the mapping so workers don't repeat the if/else chain.
 */
export function resolveTargetDatabaseId(target) {
    switch (target) {
        case "home_docs":
            return getHomeDocsDatabaseId();
        case "agent_ops":
            return getAgentOpsDatabaseId();
        case "docs":
        default:
            return getDocsDatabaseId();
    }
}
export function getTasksDatabaseId() {
    const id = process.env.TASKS_DATABASE_ID;
    if (!id)
        throw new Error("TASKS_DATABASE_ID is not set");
    return id;
}
export function getSystemControlPlanePageId() {
    const id = process.env.SYSTEM_CONTROL_PLANE_PAGE_ID;
    if (!id)
        throw new Error("SYSTEM_CONTROL_PLANE_PAGE_ID is not set");
    return id;
}
export function getDeadLettersDatabaseId() {
    const id = process.env.DEAD_LETTERS_DATABASE_ID;
    if (!id)
        throw new Error("DEAD_LETTERS_DATABASE_ID is not set");
    return id;
}
/** The native Worker.sync() database — updated automatically every 30 minutes. */
export function getGitHubItemsSyncDatabaseId() {
    const id = process.env.GITHUB_ITEMS_SYNC_DATABASE_ID;
    if (!id)
        throw new Error("GITHUB_ITEMS_SYNC_DATABASE_ID is not set");
    return id;
}
export function getGitHubToken() {
    const token = process.env.GITHUB_TOKEN;
    if (!token)
        throw new Error("GITHUB_TOKEN is not set");
    return token;
}
export function getFollowUpTrackerDatabaseId() {
    const id = process.env.FOLLOW_UP_TRACKER_DATABASE_ID;
    if (!id)
        throw new Error("FOLLOW_UP_TRACKER_DATABASE_ID is not set");
    return id;
}
export function getAiMeetingsDatabaseId() {
    const id = process.env.AI_MEETINGS_DATABASE_ID;
    if (!id)
        throw new Error("AI_MEETINGS_DATABASE_ID is not set");
    return id;
}
export function getClientsDatabaseId() {
    const id = process.env.CLIENTS_DATABASE_ID;
    if (!id)
        throw new Error("CLIENTS_DATABASE_ID is not set");
    return id;
}
export function getContactsDatabaseId() {
    return process.env.CONTACTS_DATABASE_ID || null;
}
export function getProjectsDatabaseId() {
    const id = process.env.PROJECTS_DATABASE_ID;
    if (!id)
        throw new Error("PROJECTS_DATABASE_ID is not set");
    return id;
}
export function getDecisionLogDatabaseId() {
    const id = process.env.DECISION_LOG_DATABASE_ID;
    if (!id)
        throw new Error("DECISION_LOG_DATABASE_ID is not set");
    return id;
}
export function getLabelRegistryDatabaseId() {
    const id = process.env.LABEL_REGISTRY_DATABASE_ID;
    if (!id)
        throw new Error("LABEL_REGISTRY_DATABASE_ID is not set");
    return id;
}
export function getTimeLogDatabaseId() {
    const id = process.env.TIME_LOG_DATABASE_ID;
    if (!id)
        throw new Error("TIME_LOG_DATABASE_ID is not set");
    return id;
}
/* ── AI Agent Dev Environment Setup workspace ──────────────────────
 * Optional databases. audit-dev-environment skips any that are unset.
 */
export function getReferenceDocsDatabaseId() {
    return process.env.REFERENCE_DOCS_DATABASE_ID || null;
}
export function getAgentSkillsDatabaseId() {
    return process.env.AGENT_SKILLS_DATABASE_ID || null;
}
export function getSetupTemplatesDatabaseId() {
    return process.env.SETUP_TEMPLATES_DATABASE_ID || null;
}
/** Plans database — agent-authored implementation plans reviewed via comments. */
export function getPlansDatabaseId() {
    const id = process.env.PLANS_DATABASE_ID;
    if (!id)
        throw new Error("PLANS_DATABASE_ID is not set");
    return id;
}
/** Submissions data source — audit rows for implementation confirmations.
 *  Lives inside the same "Plans and Submissions" database as the Plans
 *  data source, so we identify it by data_source_id rather than database_id. */
export function getSubmissionsDataSourceId() {
    const id = process.env.SUBMISSIONS_DATA_SOURCE_ID;
    if (!id)
        throw new Error("SUBMISSIONS_DATA_SOURCE_ID is not set");
    return id;
}
/** Plans data source — the other half of the "Plans and Submissions" multi-
 *  source DB. Needed by the plan-webhook dispatcher to route incoming events
 *  by their page's parent data source. Find via
 *  `ntn api v1/databases/$PLANS_DATABASE_ID` → look for the data source named
 *  "Plans". */
export function getPlansDataSourceId() {
    const id = process.env.PLANS_DATA_SOURCE_ID;
    if (!id)
        throw new Error("PLANS_DATA_SOURCE_ID is not set");
    return id;
}
export function getZohoClientId() {
    const v = process.env.ZOHO_CLIENT_ID;
    if (!v)
        throw new Error("ZOHO_CLIENT_ID is not set");
    return v;
}
export function getZohoClientSecret() {
    const v = process.env.ZOHO_CLIENT_SECRET;
    if (!v)
        throw new Error("ZOHO_CLIENT_SECRET is not set");
    return v;
}
export function getZohoRefreshToken() {
    const v = process.env.ZOHO_REFRESH_TOKEN;
    if (!v)
        throw new Error("ZOHO_REFRESH_TOKEN is not set");
    return v;
}
/** Zoho API base URL — defaults to US data center. */
export function getZohoApiBaseUrl() {
    return process.env.ZOHO_API_BASE_URL ?? "https://www.zohoapis.com";
}
export function getZohoProjectsPortalId() {
    const id = process.env.ZOHO_PROJECTS_PORTAL_ID;
    if (!id)
        throw new Error("ZOHO_PROJECTS_PORTAL_ID is not set");
    return id;
}
/**
 * Resolve any ID (parent database OR data source) to a data_source ID.
 *
 * Under API 2026-03-11, multi-source databases have a parent `database_id`
 * AND one-or-more child `data_source_id`s. `dataSources.query()` requires
 * the data_source ID. Historically, some env vars in this project stored
 * the parent DB ID instead of the data_source ID — this helper accepts
 * either kind so workers don't care which one is in the env var.
 *
 * Algorithm:
 *   1. If we've resolved this input ID before, return the cached value.
 *   2. Try `dataSources.retrieve()` — succeeds when the input IS already
 *      a data_source ID. Cache as-is and return.
 *   3. On `object_not_found`, try `databases.retrieve()` — if the input
 *      is a parent DB ID, take the first child data_source's ID, cache,
 *      return.
 *   4. Otherwise propagate the error.
 *
 * The cache lives for the worker's process lifetime — one extra retrieve
 * call per unique env var per cold start, then zero overhead.
 */
const dataSourceCache = new Map();
export async function resolveDataSourceId(client, inputId) {
    const cached = dataSourceCache.get(inputId);
    if (cached)
        return cached;
    try {
        await client.dataSources.retrieve({ data_source_id: inputId });
        dataSourceCache.set(inputId, inputId);
        return inputId;
    }
    catch (e) {
        if (!(e instanceof APIResponseError) || e.code !== "object_not_found") {
            throw e;
        }
    }
    // Input wasn't a data_source ID — try treating it as a parent database ID.
    const db = (await client.databases.retrieve({ database_id: inputId }));
    const first = db.data_sources?.[0]?.id;
    if (!first) {
        throw new Error(`Could not resolve ${inputId} to a data_source — neither a data_source ID nor a parent database with data_sources`);
    }
    dataSourceCache.set(inputId, first);
    return first;
}
export async function queryDatabase(client, databaseId, params = {}) {
    const dataSourceId = await resolveDataSourceId(client, databaseId);
    const res = await client.dataSources.query({ data_source_id: dataSourceId, ...params });
    if (res.request_status?.type === "incomplete") {
        console.warn(`[queryDatabase] Result truncated for database ${databaseId}: ${res.request_status.incomplete_reason ?? "unknown reason"}. Use queryAllDatabase to fetch all pages.`);
    }
    return res;
}
/**
 * queryAllDatabase — auto-paginating wrapper around queryDatabase.
 *
 * Fetches every page from a database by following next_cursor until has_more
 * is false. Logs a warning if the API reports the result was truncated at the
 * query level (request_status.type === "incomplete").
 *
 * Usage:
 *   const pages = await queryAllDatabase(notion, databaseId, { filter, sorts });
 */
export async function queryAllDatabase(client, databaseId, params = {}) {
    const results = [];
    let cursor = undefined;
    do {
        const res = await queryDatabase(client, databaseId, {
            ...params,
            page_size: 100,
            ...(cursor ? { start_cursor: cursor } : {}),
        });
        results.push(...res.results);
        cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
    } while (cursor);
    return results;
}
