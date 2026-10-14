/**
 * Notion database-automation "Send webhook" → Abstract Secretary (AS) wake.
 *
 * Notion automation webhooks are unsigned, so this route authenticates with a
 * shared secret header compared in constant time against NOTION_AUTOMATION_SECRET.
 * Only Kind=Plan, Status=Approved, non-empty Project is forwarded; everything else
 * is acknowledged and ignored. Dedupe key = page id + Approved At (one KV get per
 * request; one KV put only after a successful AS wake).
 *
 * Double-wake: the KV get→put is not atomic. Two identical posts that arrive
 * concurrently (or a re-fire while the first AS wake is still in flight, up to
 * AS_WAKE_TIMEOUT_MS) can both pass the dedupe read and both wake AS. Notion
 * automations fire once per trigger so this is rare; AS must treat the wake as
 * idempotent (key: page_id + approved_at).
 */
import type { Env } from "./env.js";
import { kvTtl } from "./kv-ttl.js";

export const PLAN_APPROVED_PATH = "/notion/automation/plan-approved";
export const AUTOMATION_SECRET_HEADER = "X-Relay-Automation-Secret";
export const PLAN_APPROVED_DEDUPE_PREFIX = "plan_approved:v1:";
/** 7 days: covers Notion automation re-fires / manual re-runs of the same approval. */
export const PLAN_APPROVED_DEDUPE_TTL_SECONDS = 7 * 24 * 60 * 60;
export const MAX_BODY_BYTES = 256 * 1024;
/** Outbound AS wake timeout; a timeout returns 502 (not deduped, so a re-fire can retry). */
export const AS_WAKE_TIMEOUT_MS = 10_000;
/** Exact Notion property names the "Send webhook" action must have ticked. */
export const PINNED_PROPERTIES = ["ID", "Kind", "Status", "Project", "Approved At"] as const;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Constant-time compare via SHA-256 digests (no early exit on length mismatch). */
export async function secretMatches(provided: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(provided)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

/** Flatten a Notion property value (API shape) or a plain scalar to a trimmed string. */
export function propText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(propText).filter(Boolean).join(", ");
  if (typeof v !== "object") return "";
  const o = v as Record<string, unknown>;
  const t = typeof o.type === "string" ? o.type : undefined;
  if (t && t in o) return propText(o[t]);
  if ("plain_text" in o) return propText(o.plain_text);
  if ("name" in o) return propText(o.name);
  if ("start" in o) return propText(o.start);
  if ("prefix" in o || "number" in o) {
    const n = o.number == null ? "" : String(o.number);
    return o.prefix ? `${o.prefix}-${n}` : n;
  }
  if ("id" in o) return propText(o.id);
  if ("string" in o) return propText(o.string);
  return "";
}

export type PlanApprovedFields = {
  pageId: string;
  id: string;
  kind: string;
  status: string;
  project: string;
  approvedAt: string;
};

/** Names of pinned properties absent from the payload (Send webhook only sends ticked ones). */
export function missingPinnedProperties(parsed: Record<string, unknown>): string[] {
  const data =
    parsed.data && typeof parsed.data === "object" ? (parsed.data as Record<string, unknown>) : parsed;
  const props =
    data.properties && typeof data.properties === "object"
      ? (data.properties as Record<string, unknown>)
      : data;
  return PINNED_PROPERTIES.filter((n) => findProp(props, n) === undefined);
}

function findProp(props: Record<string, unknown>, name: string): unknown {
  if (name in props) return props[name];
  const want = name.toLowerCase().replace(/[\s_]/g, "");
  for (const [k, v] of Object.entries(props)) {
    if (k.toLowerCase().replace(/[\s_]/g, "") === want) return v;
  }
  return undefined;
}

/** Accepts Notion's automation body ({ source, data: page }) or a flat object. */
export function extractFields(parsed: Record<string, unknown>): PlanApprovedFields {
  const data =
    parsed.data && typeof parsed.data === "object"
      ? (parsed.data as Record<string, unknown>)
      : parsed;
  const props =
    data.properties && typeof data.properties === "object"
      ? (data.properties as Record<string, unknown>)
      : data;
  const pageId = typeof data.id === "string" ? data.id.replace(/-/g, "").toLowerCase() : "";
  return {
    pageId,
    id: propText(findProp(props, "ID")),
    kind: propText(findProp(props, "Kind")),
    status: propText(findProp(props, "Status")),
    project: propText(findProp(props, "Project")),
    approvedAt: propText(findProp(props, "Approved At")),
  };
}

export type Validation = { ok: true } | { ok: false; reason: string };

export function validatePlanApproved(f: PlanApprovedFields): Validation {
  if (f.kind !== "Plan") return { ok: false, reason: "kind_not_plan" };
  if (f.status !== "Approved") return { ok: false, reason: "status_not_approved" };
  if (!f.project) return { ok: false, reason: "project_empty" };
  if (!f.pageId && !f.id) return { ok: false, reason: "missing_page_id" };
  if (!f.approvedAt) return { ok: false, reason: "missing_approved_at" };
  return { ok: true };
}

export function dedupeKey(f: PlanApprovedFields): string {
  return `${PLAN_APPROVED_DEDUPE_PREFIX}${f.pageId || f.id}:${f.approvedAt}`;
}

/** Normalise to `Bearer <token>`; an existing prefix is matched case-insensitively. */
export function bearerHeader(raw: string): string {
  const v = raw.trim();
  const m = /^bearer\s+(.*)$/i.exec(v);
  return `Bearer ${m ? m[1]!.trim() : v}`;
}

/** Secrets that are missing or whitespace-only count as unset. */
export function secretSet(v: string | undefined): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export async function handlePlanApprovedAutomation(request: Request, env: Env): Promise<Response> {
  if (!secretSet(env.NOTION_AUTOMATION_SECRET)) {
    return json({ error: "unauthorized" }, 401);
  }
  const provided = request.headers.get(AUTOMATION_SECRET_HEADER);
  if (!provided || !(await secretMatches(provided, env.NOTION_AUTOMATION_SECRET))) {
    return json({ error: "unauthorized" }, 401);
  }

  // Reject declared-oversize bodies before reading; re-check actual size after.
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return json({ error: "payload_too_large" }, 413);
  }
  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return json({ error: "invalid_json" }, 400);
  }

  const missing = missingPinnedProperties(parsed as Record<string, unknown>);
  if (missing.length > 0) {
    console.warn(JSON.stringify({ event: "plan_approved_missing_properties", missing }));
  }
  const fields = extractFields(parsed as Record<string, unknown>);
  const v = validatePlanApproved(fields);
  if (!v.ok) {
    console.log(JSON.stringify({ event: "plan_approved_ignored", reason: v.reason }));
    return json({ ok: true, ignored: true, reason: v.reason });
  }

  if (!secretSet(env.AS_WEBHOOK_URL) || !secretSet(env.AS_WEBHOOK_AUTHORIZATION)) {
    console.log(JSON.stringify({ event: "plan_approved_as_not_configured" }));
    return json({ error: "as_wake_not_configured" }, 503);
  }

  const key = dedupeKey(fields);
  if ((await env.RELAY_KV.get(key)) !== null) {
    console.log(JSON.stringify({ event: "plan_approved_duplicate" }));
    return json({ ok: true, duplicate: true });
  }

  const wakeBody = JSON.stringify({
    source: "notion-comments-relay",
    event: "notion.automation.plan_approved",
    page_id: fields.pageId || null,
    id: fields.id || null,
    kind: fields.kind,
    status: fields.status,
    project: fields.project,
    approved_at: fields.approvedAt,
  });
  let status = 0;
  try {
    const upstream = await fetch(env.AS_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: bearerHeader(env.AS_WEBHOOK_AUTHORIZATION) },
      body: wakeBody,
      signal: AbortSignal.timeout(AS_WAKE_TIMEOUT_MS),
    });
    status = upstream.status;
    await upstream.body?.cancel();
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    console.log(JSON.stringify({ event: "plan_approved_wake_error", error: name }));
    const timedOut = name === "TimeoutError" || name === "AbortError";
    return json({ error: timedOut ? "as_wake_timeout" : "as_wake_failed" }, 502);
  }
  console.log(JSON.stringify({ event: "plan_approved_forwarded", status }));
  if (status < 200 || status >= 300) {
    return json({ error: "as_wake_failed", status }, 502);
  }
  // Single KV write, only after a successful wake, so failed wakes stay retryable.
  try {
    await env.RELAY_KV.put(key, "1", { expirationTtl: kvTtl(PLAN_APPROVED_DEDUPE_TTL_SECONDS) });
  } catch {}
  return json({ ok: true, forwarded: true, status });
}
