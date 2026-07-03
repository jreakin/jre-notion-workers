/**
 * Zoho CRM OAuth helper.
 *
 * Uses the Self-Client (server-to-server) flow:
 *   1. You hold a long-lived refresh token (never expires unless revoked).
 *   2. Before each CRM API call, exchange it for a short-lived access token (1 h TTL).
 *   3. Cache the access token in-process so a batch of calls within one worker
 *      invocation only hits the token endpoint once.
 *
 * Token endpoint is data-center specific and is derived from ZOHO_API_BASE_URL.
 */
import { getZohoClientId, getZohoClientSecret, getZohoRefreshToken, getZohoApiBaseUrl, } from "./notion-client.js";
let _tokenCache = null;
/** Buffer: refresh the token 60 s before it actually expires. */
const EXPIRY_BUFFER_MS = 60_000;
/**
 * Zoho requires token refresh requests to hit the tenant's accounts domain,
 * which varies by data center. We derive it from the configured API base URL
 * so the same environment setting works for both CRM API calls and OAuth.
 */
export function getZohoAccountsBaseUrl(apiBaseUrl) {
    let hostname;
    try {
        hostname = new URL(apiBaseUrl).hostname.toLowerCase();
    }
    catch {
        return "https://accounts.zoho.com";
    }
    const normalizedHost = hostname.replace(/^www\./, "");
    const hostMappings = [
        ["zohoapis.com", "accounts.zoho.com"],
        ["zohoapis.com.au", "accounts.zoho.com.au"],
        ["zohoapis.eu", "accounts.zoho.eu"],
        ["zohoapis.in", "accounts.zoho.in"],
        ["zohoapis.com.cn", "accounts.zoho.com.cn"],
        ["zohoapis.jp", "accounts.zoho.jp"],
        ["zohocloud.ca", "accounts.zohocloud.ca"],
        ["zohoapis.sa", "accounts.zoho.sa"],
    ];
    const match = hostMappings.find(([apiHost]) => normalizedHost === apiHost);
    if (match) {
        return `https://${match[1]}`;
    }
    return "https://accounts.zoho.com";
}
async function fetchAccessToken() {
    const tokenBaseUrl = getZohoAccountsBaseUrl(getZohoApiBaseUrl());
    const params = new URLSearchParams({
        refresh_token: getZohoRefreshToken(),
        client_id: getZohoClientId(),
        client_secret: getZohoClientSecret(),
        grant_type: "refresh_token",
    });
    const res = await fetch(`${tokenBaseUrl}/oauth/v2/token?${params.toString()}`, {
        method: "POST",
    });
    if (!res.ok) {
        throw new Error(`Zoho token exchange failed: HTTP ${res.status} ${res.statusText}`);
    }
    const body = (await res.json());
    if (body.error) {
        throw new Error(`Zoho token exchange error: ${body.error}`);
    }
    if (!body.access_token) {
        throw new Error("Zoho token exchange returned no access_token");
    }
    return body.access_token;
}
/**
 * Returns a valid Zoho access token, refreshing it if the cached one is
 * about to expire. Safe to call before every CRM API request.
 */
export async function getZohoAccessToken() {
    const now = Date.now();
    if (_tokenCache && _tokenCache.expiresAt - EXPIRY_BUFFER_MS > now) {
        return _tokenCache.accessToken;
    }
    const accessToken = await fetchAccessToken();
    // Zoho access tokens live for 3600 s (1 hour).
    _tokenCache = { accessToken, expiresAt: now + 3_600_000 };
    return accessToken;
}
/**
 * GET a Zoho CRM endpoint, returning the parsed JSON body.
 * Throws on non-2xx responses with a descriptive message.
 */
export async function zohoGet(path) {
    const token = await getZohoAccessToken();
    const base = getZohoApiBaseUrl();
    const url = `${base}${path}`;
    const res = await fetch(url, {
        headers: {
            Authorization: `Zoho-oauthtoken ${token}`,
            "Content-Type": "application/json",
        },
    });
    if (!res.ok) {
        throw new Error(`Zoho CRM GET ${path} failed: HTTP ${res.status} ${res.statusText}`);
    }
    return (await res.json());
}
/**
 * PATCH a single Zoho CRM record.
 * path example: "/crm/v2/Accounts/RECORD_ID"
 * data example: { Notion_Client_ID: "abc123" }
 */
export async function zohoPatch(path, data) {
    const token = await getZohoAccessToken();
    const base = getZohoApiBaseUrl();
    const url = `${base}${path}`;
    const res = await fetch(url, {
        method: "PUT",
        headers: {
            Authorization: `Zoho-oauthtoken ${token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ data: [data] }),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Zoho CRM PUT ${path} failed: HTTP ${res.status} ${res.statusText} — ${text}`);
    }
}
/* ── Zoho Projects API helpers ─────────────────────────────────────── */
/**
 * Zoho Projects uses a different API base (projectsapi.zoho.com) from CRM.
 * The same OAuth token works across all Zoho One apps provided the refresh
 * token was issued with ZohoProjects.* scopes.
 */
function getZohoProjectsApiBase() {
    return process.env.ZOHO_PROJECTS_API_BASE_URL ?? "https://projectsapi.zoho.com/restapi";
}
export async function zohoProjectsGet(path) {
    const token = await getZohoAccessToken();
    const base = getZohoProjectsApiBase();
    const res = await fetch(`${base}${path}`, {
        headers: {
            Authorization: `Zoho-oauthtoken ${token}`,
            "Content-Type": "application/json",
        },
    });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Zoho Projects GET ${path} failed: HTTP ${res.status} — ${text}`);
    }
    return (await res.json());
}
export async function zohoProjectsPost(path, body) {
    const token = await getZohoAccessToken();
    const base = getZohoProjectsApiBase();
    const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: {
            Authorization: `Zoho-oauthtoken ${token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Zoho Projects POST ${path} failed: HTTP ${res.status} — ${text}`);
    }
    return (await res.json());
}
export async function zohoProjectsPut(path, body) {
    const token = await getZohoAccessToken();
    const base = getZohoProjectsApiBase();
    const res = await fetch(`${base}${path}`, {
        method: "PUT",
        headers: {
            Authorization: `Zoho-oauthtoken ${token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Zoho Projects PUT ${path} failed: HTTP ${res.status} — ${text}`);
    }
    return (await res.json());
}
/**
 * POST to a Zoho CRM COQL endpoint.
 * Returns the rows from `data` array, or [] if no records found.
 */
export async function zohoCoql(query) {
    const token = await getZohoAccessToken();
    const base = getZohoApiBaseUrl();
    const url = `${base}/crm/v2/coql`;
    const res = await fetch(url, {
        method: "POST",
        headers: {
            Authorization: `Zoho-oauthtoken ${token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ select_query: query }),
    });
    // 204 No Content = query returned zero rows — not an error.
    if (res.status === 204)
        return [];
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Zoho COQL failed: HTTP ${res.status} ${res.statusText} — ${text}`);
    }
    const body = (await res.json());
    return body.data ?? [];
}
