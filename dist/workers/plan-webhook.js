/**
 * plan-webhook: Single-entry dispatcher for all Notion webhook events flowing
 * to the `plan-events` URL. Notion's Connections feature caps webhook
 * subscriptions at one per connection, so both the Plans-side flows
 * (comments + Status changes) AND the Submissions-side flow (page.created)
 * arrive here. This handler reads the page's parent data source and routes
 * each event to the right logic; events for unrelated data sources are
 * logged and dropped.
 *
 * Event routing:
 *
 *   Plans data source (PLANS_DATA_SOURCE_ID):
 *     - comment.created / comment.updated → mark plan pending
 *     - page.properties_updated → if Status flipped to Approved, stamp
 *       Approved At; if terminal, clear Has Open Comments.
 *     - page.content_updated → if the Plan is currently Approved, revert
 *       Status to Changes Requested and clear Approved At so the agent
 *       re-pauses (covers direct edits AND accepted "Suggest edits"
 *       proposals — both fire page.content_updated).
 *
 *   Submissions data source (SUBMISSIONS_DATA_SOURCE_ID):
 *     - page.created → propagate the new Submission's PR URL to the linked
 *       Plan (via applyPlanUpdate, folded into this file — ADR-0009).
 *
 *   Anything else: logged and dropped.
 *
 * Signature verification:
 *   Notion sends X-Notion-Signature: sha256=<hex>, computed as
 *   HMAC-SHA256(PLAN_WEBHOOK_SECRET, rawBody). The secret is the
 *   verification_token shown when you create the subscription. Throw
 *   WebhookVerificationError to fail closed.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { WebhookVerificationError } from "@notionhq/workers";
import { extractErrorMessage, getPlansDataSourceId, getSubmissionsDataSourceId, } from "../shared/notion-client.js";
/** Constant-time signature check. Returns false on any malformed input
 *  rather than throwing — caller decides whether to fail closed. */
export function verifyNotionSignature(rawBody, headers, secret) {
    if (!secret)
        return false;
    const headerRaw = headers["x-notion-signature"] ?? headers["X-Notion-Signature"];
    const provided = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;
    if (!provided)
        return false;
    const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length)
        return false;
    try {
        return timingSafeEqual(a, b);
    }
    catch {
        return false;
    }
}
async function readPlanStatus(notion, pageId) {
    try {
        const page = (await notion.pages.retrieve({ page_id: pageId }));
        const statusProp = page.properties?.["Status"];
        return statusProp?.status?.name ?? null;
    }
    catch {
        return null;
    }
}
/** Look up the parent data source ID of a page so the dispatcher can route
 *  Plans vs Submissions events. Returns null on any failure (caller drops). */
async function getPageDataSourceId(notion, pageId) {
    try {
        const page = (await notion.pages.retrieve({ page_id: pageId }));
        const parent = page.parent;
        if (!parent)
            return null;
        if (parent.type === "data_source_id" && parent.data_source_id) {
            return parent.data_source_id;
        }
        if (parent.type === "database_id" && parent.database_id) {
            return parent.database_id;
        }
        return null;
    }
    catch {
        return null;
    }
}
/** Notion IDs are sometimes presented with dashes, sometimes without.
 *  Normalise both sides before comparing. */
function normalizeId(id) {
    return (id ?? "").replace(/-/g, "").toLowerCase();
}
const TERMINAL_STATUSES = new Set([
    "Approved",
    "Implemented",
    "Abandoned",
]);
async function handleCommentEvent(notion, pageId, timestamp) {
    try {
        await notion.pages.update({
            page_id: pageId,
            properties: {
                "Has Open Comments": { checkbox: true },
                "Last Comment At": { date: { start: timestamp } },
            },
        });
        console.log(`[plan-webhook] comment → marked ${pageId} pending`);
    }
    catch (e) {
        console.error(`[plan-webhook] failed to mark ${pageId} pending:`, extractErrorMessage(e));
    }
}
async function handleStatusEvent(notion, pageId, timestamp) {
    const status = await readPlanStatus(notion, pageId);
    if (!status)
        return;
    const updates = {};
    if (status === "Approved") {
        updates["Approved At"] = { date: { start: timestamp } };
        updates["Has Open Comments"] = { checkbox: false };
    }
    else if (TERMINAL_STATUSES.has(status)) {
        updates["Has Open Comments"] = { checkbox: false };
    }
    if (Object.keys(updates).length === 0)
        return;
    try {
        await notion.pages.update({
            page_id: pageId,
            properties: updates,
        });
        console.log(`[plan-webhook] status=${status} → updated ${pageId}`);
    }
    catch (e) {
        console.error(`[plan-webhook] failed to apply status update for ${pageId}:`, extractErrorMessage(e));
    }
}
/** When a Plan's body changes after it was Approved, the goalposts moved
 *  on the agent. Flip Status back to Changes Requested and clear Approved
 *  At so the agent re-pauses on the next poll. We don't touch terminal
 *  states (Implemented, Abandoned) — once shipped, body edits become
 *  retroactive notes and shouldn't restart the loop. */
async function handleContentUpdatedEvent(notion, pageId) {
    const status = await readPlanStatus(notion, pageId);
    if (!status)
        return;
    if (status !== "Approved") {
        console.log(`[plan-webhook] content_updated on plan ${pageId} (status=${status}); not auto-reverting`);
        return;
    }
    try {
        await notion.pages.update({
            page_id: pageId,
            properties: {
                Status: { status: { name: "Changes Requested" } },
                "Approved At": { date: null },
            },
        });
        console.log(`[plan-webhook] content_updated on Approved plan ${pageId} → reverted to Changes Requested`);
    }
    catch (e) {
        console.error(`[plan-webhook] failed to revert plan ${pageId} after content change:`, extractErrorMessage(e));
    }
}
/** Webhook handler — registered as `worker.webhook("plan-events", …)`
 *  in src/index.ts. Exported as a function so unit tests can drive it
 *  with synthetic events. */
/** Detects Notion's one-time subscription verification ping.
 *  Body shape: `{"verification_token": "secret_..."}`. Returns the token if
 *  this is a verification request, otherwise null. */
function readVerificationToken(body) {
    if (!body || typeof body !== "object")
        return null;
    const token = body.verification_token;
    return typeof token === "string" && token.length > 0 ? token : null;
}
export async function handlePlanWebhookEvents(events, notion) {
    for (const event of events) {
        // 1. Verification ping — log the token so the user can retrieve it from
        //    `ntn workers logs` if the Notion UI doesn't display it directly,
        //    then return 200 OK without further processing. Notion will only
        //    send this once per subscription.
        const verificationToken = readVerificationToken(event.body);
        if (verificationToken) {
            console.log(`[plan-webhook] VERIFICATION TOKEN RECEIVED — copy this into PLAN_WEBHOOK_SECRET in 1Password: ${verificationToken}`);
            continue;
        }
        // 2. Normal event delivery — require signature verification.
        const secret = process.env.PLAN_WEBHOOK_SECRET;
        if (!secret) {
            throw new Error("PLAN_WEBHOOK_SECRET is not set — cannot verify incoming event delivery");
        }
        if (!verifyNotionSignature(event.rawBody, event.headers, secret)) {
            throw new WebhookVerificationError("Invalid X-Notion-Signature for plan-events");
        }
        const body = event.body;
        const type = body.type ?? "";
        const pageId = body.data?.page_id ?? body.entity?.id ?? "";
        const timestamp = body.timestamp ?? new Date().toISOString();
        if (!pageId) {
            console.warn(`[plan-webhook] delivery ${event.deliveryId} type=${type} had no page_id; skipping`);
            continue;
        }
        // Route by data source. A single Notion subscription fans every event
        // type into this URL, so we need to look up which data source the page
        // belongs to before deciding what to do (or whether to do anything).
        const dsId = await getPageDataSourceId(notion, pageId);
        if (!dsId) {
            console.log(`[plan-webhook] could not resolve data source for page ${pageId} (type=${type}); skipping`);
            continue;
        }
        const dsNorm = normalizeId(dsId);
        const plansDs = normalizeId(getPlansDataSourceId());
        const submissionsDs = normalizeId(getSubmissionsDataSourceId());
        if (dsNorm === plansDs) {
            if (type === "comment.created" || type === "comment.updated") {
                await handleCommentEvent(notion, pageId, timestamp);
            }
            else if (type === "page.properties_updated") {
                await handleStatusEvent(notion, pageId, timestamp);
            }
            else if (type === "page.content_updated") {
                await handleContentUpdatedEvent(notion, pageId);
            }
            else {
                console.log(`[plan-webhook] ignoring ${type} on plan page ${pageId}`);
            }
        }
        else if (dsNorm === submissionsDs) {
            if (type === "page.created") {
                await applyPlanUpdate(notion, pageId);
            }
            else {
                console.log(`[plan-webhook] ignoring ${type} on submission page ${pageId}`);
            }
        }
        else {
            console.log(`[plan-webhook] event from unrelated data source ${dsId} (page ${pageId}, type ${type}); dropping`);
        }
    }
}
// ════════════════════════════════════════════════════════════════════
// Submission → Plan propagation (folded in from submission-webhook.ts —
// ADR-0009). When a page.created event fires on the Submissions data
// source, the dispatcher above calls applyPlanUpdate directly. Notion
// caps subscriptions at one per Connection, so all events flow through
// the plan-events URL; there is no standalone submission-events webhook.
//
// applyPlanUpdate reads the new Submission's PR URL + Plan relation and
// patches the linked Plan (Status=Implemented, Implementation PR, Has
// Open Comments=false). For rows that arrive without the Plan relation
// (direct "+ New", other automations), it recovers the page id from a
// rich_text "Plan Page URL" property and backfills the relation so the
// audit row matches confirm-implementation-tool-created rows.
//
// Idempotent: pages.update writes the same values when state already
// matches, so duplicate deliveries (or both the tool and webhook firing)
// are harmless.
// ════════════════════════════════════════════════════════════════════
/** Read a single-value relation property and return the first related page ID. */
function readFirstRelationId(prop) {
    if (!prop || typeof prop !== "object")
        return null;
    const relation = prop.relation;
    if (!relation?.length)
        return null;
    return relation[0]?.id ?? null;
}
/** Read a URL property's value. */
function readUrl(prop) {
    if (!prop || typeof prop !== "object")
        return null;
    const url = prop.url;
    return url ?? null;
}
/** Read a date property's start value. */
function readDateStart(prop) {
    if (!prop || typeof prop !== "object")
        return null;
    const date = prop.date;
    return date?.start ?? null;
}
/** Pull a Notion page id out of a rich_text property in any of three forms:
 *
 *   1. Notion auto-mention — user typed/pasted a Notion URL and the UI
 *      converted it to a page mention. Comes through as
 *      { type: "mention", mention: { type: "page", page: { id } } }.
 *      `plain_text` for these is the rendered page title, not a URL, so we
 *      have to read `mention.page.id` directly.
 *   2. Notion URL as href on an inline text item (linked text).
 *   3. Plain Notion URL pasted as raw text (no auto-conversion).
 *
 * Returns the dashed-UUID form of the page id, or null if no segment of the
 * rich_text looks like a Notion page reference. */
export function readPlanIdFromRichText(prop) {
    if (!prop || typeof prop !== "object")
        return null;
    const rt = prop.rich_text;
    if (!rt?.length)
        return null;
    for (const item of rt) {
        if (item.type === "mention" && item.mention?.type === "page") {
            const id = item.mention.page?.id;
            if (id)
                return id.includes("-") ? id : extractPageIdFromNotionUrl(id);
        }
        if (item.href) {
            const fromHref = extractPageIdFromNotionUrl(item.href);
            if (fromHref)
                return fromHref;
        }
        if (item.plain_text) {
            const fromText = extractPageIdFromNotionUrl(item.plain_text);
            if (fromText)
                return fromText;
        }
    }
    return null;
}
/** Notion page IDs are 32-char hex (no dashes) or 36-char dashed UUIDs.
 *  Pull either form out of a Notion URL — last segment of the path, ignoring
 *  any title slug like "My-Plan-3637d7f5...". Returns the dashed UUID form. */
export function extractPageIdFromNotionUrl(input) {
    const trimmed = input.trim();
    if (!trimmed)
        return null;
    // Strip query/hash and pick the last path segment.
    const noQuery = trimmed.split(/[?#]/)[0] ?? trimmed;
    const lastSeg = noQuery.split("/").pop() ?? "";
    // Within the last segment, find the trailing 32-char hex run.
    const hex = lastSeg.match(/[0-9a-fA-F]{32}/)?.[0];
    if (!hex)
        return null;
    const lower = hex.toLowerCase();
    return `${lower.slice(0, 8)}-${lower.slice(8, 12)}-${lower.slice(12, 16)}-${lower.slice(16, 20)}-${lower.slice(20)}`;
}
/** Patch the Plan linked to this Submission row. Called by the dispatcher
 *  above when a page.created event fires on the Submissions data source. */
export async function applyPlanUpdate(notion, submissionPageId) {
    const submission = (await notion.pages.retrieve({
        page_id: submissionPageId,
    }));
    const props = submission.properties ?? {};
    let planId = readFirstRelationId(props["Plan"]);
    // Notion forms can ask for relations, but rows created via "+ New" in a
    // table view, by automations, or by other paths may arrive without the
    // Plan relation set. Fall back to a rich_text "Plan Page URL" field —
    // paste a Notion URL there and we recover the page id (mention, linked
    // text, or plain text), then backfill the Plan relation so the audit row
    // matches confirm-implementation-tool-created rows.
    let planIdRecoveredFromUrl = false;
    if (!planId) {
        planId = readPlanIdFromRichText(props["Plan Page URL"]);
        planIdRecoveredFromUrl = planId !== null;
    }
    const prUrl = readUrl(props["PR URL"]);
    if (!planId) {
        console.warn(`[submission-webhook] submission ${submissionPageId} has no Plan relation and no parseable Plan Page URL; skipping`);
        return;
    }
    if (!prUrl) {
        console.warn(`[submission-webhook] submission ${submissionPageId} has no PR URL; skipping`);
        return;
    }
    // Backfill missing fields on the submission row. The form view doesn't
    // include Date as an input (and direct-add paths often skip it), so we
    // stamp it with the page's created_time so the audit table always shows
    // when the submission was made.
    const submissionUpdates = {};
    if (planIdRecoveredFromUrl) {
        submissionUpdates["Plan"] = { relation: [{ id: planId }] };
    }
    const existingDate = readDateStart(props["Date"]);
    if (!existingDate && submission.created_time) {
        submissionUpdates["Date"] = { date: { start: submission.created_time } };
    }
    if (Object.keys(submissionUpdates).length > 0) {
        try {
            await notion.pages.update({
                page_id: submissionPageId,
                properties: submissionUpdates,
            });
            const backfilled = Object.keys(submissionUpdates).join(", ");
            console.log(`[submission-webhook] backfilled on submission ${submissionPageId}: ${backfilled}`);
        }
        catch (e) {
            console.error(`[submission-webhook] could not backfill on submission ${submissionPageId}:`, extractErrorMessage(e));
        }
    }
    try {
        await notion.pages.update({
            page_id: planId,
            properties: {
                Status: { status: { name: "Implemented" } },
                "Implementation PR": { url: prUrl },
                "Has Open Comments": { checkbox: false },
            },
        });
        console.log(`[submission-webhook] plan ${planId} marked Implemented (PR=${prUrl}, from submission ${submissionPageId})`);
    }
    catch (e) {
        console.error(`[submission-webhook] failed to update plan ${planId}:`, extractErrorMessage(e));
    }
}
