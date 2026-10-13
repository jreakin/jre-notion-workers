import { cleanMaskClip } from "./mask.js";

export const MAX_BODY_BYTES = 8192;
export const SUBJECT_MAX = 140;
export const SNIPPET_MAX = 400;
export const LABEL_MAX_CHARS = 40;
export const EXISTING_LABELS_MAX = 5;
export const TRIAGE_LABELS_MAX = 10;

export const OVERRIDES = [
  "known_person",
  "money",
  "security",
  "calendar",
  "legal",
  "tesla",
  "x_notify",
  "grokbot_inbox",
] as const;
export type Override = (typeof OVERRIDES)[number];
export const DISPOSITIONS = ["spam", "archive_fyi", "escalate_john", "handoff_lane", "leave"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];
export const LANES = ["cos", "vep_desk", "qr_pm", "abstract_secretary", "none"] as const;
export type Lane = (typeof LANES)[number];
const FROM_KINDS = ["known_person", "known_lane", "service", "unknown"] as const;
const CATEGORIES = ["primary", "updates", "promotions", "forums", "social"] as const;

export type EmailShadowItem = {
  mailbox: "personal" | "work";
  msg_id_hash: string;
  thread_id_hash: string | null;
  received_at: string | null;
  run_id: string | null;
  from_domain: string | null;
  from_kind: (typeof FROM_KINDS)[number];
  to_john_direct: boolean;
  cc_count: number;
  list_unsubscribe: boolean;
  has_attachment: boolean;
  gmail_category: (typeof CATEGORIES)[number] | null;
  existing_labels: string[];
  /** Masked + clipped. Transient only: NEVER log. */
  subject: string;
  /** Masked + clipped. Transient only: NEVER log. */
  snippet: string;
  override: Override | null;
  triage: {
    disposition: Disposition;
    lane: Lane;
    labels_applied: string[];
    escalated: boolean;
  };
};

export type ParseResult =
  | { ok: true; item: EmailShadowItem }
  | { ok: false; reason: string; excluded?: boolean; msg_id_hash?: string };

const HASH_RE = /^[a-f0-9]{16,128}$/;
const DOMAIN_RE = /^(?=.{1,253}$)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
const RUN_ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T[0-9:.+\-Z]{1,30}$/;

export {
  EXCLUDED_ADDRESS,
  EXCLUDED_ADDRESS_RE,
  EXCLUDED_DOMAIN,
} from "../../../clef-core/src/exclusion.js";
import { EXCLUDED_ADDRESS_RE, EXCLUDED_DOMAIN } from "../../../clef-core/src/exclusion.js";

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function oneOf<T extends string>(v: unknown, list: readonly T[]): T | null {
  return typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : null;
}
function bool(v: unknown): boolean {
  return v === true;
}
function hash(v: unknown): string | null {
  return typeof v === "string" && HASH_RE.test(v) ? v : null;
}
function labels(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string")
    .slice(0, max)
    .map((x) => cleanMaskClip(x, LABEL_MAX_CHARS))
    .filter((x) => x.length > 0);
}

/** Free-text fields a sender controls; never used for exclusion (a sender could hide mail from shadow data). */
const FREE_TEXT_FIELDS = new Set(["subject", "snippet"]);

function isExcludedDomain(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const d = v.trim().toLowerCase().replace(/\.$/, "");
  return d === EXCLUDED_DOMAIN || d.endsWith(`.${EXCLUDED_DOMAIN}`);
}

/**
 * True when the item concerns the bot's own inbox — excluded entirely (John, 2026-10-13).
 * Payload v1 carries no to/cc/delivered-to addresses: for those, Inbox Triage MUST send
 * override:"grokbot_inbox" (box-side contract). Here we also catch the address (any +alias/case)
 * in structured fields (not subject/snippet) and a mail.grokbot.com sender domain.
 */
export function isExcludedGrokbot(_rawBody: string, body: Record<string, unknown>): boolean {
  if (body.override === "grokbot_inbox") return true;
  if (isExcludedDomain(body.from_domain)) return true;
  // Scan only structured fields (decoded, so \u0040 escapes are covered); never subject/snippet.
  const structured: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (!FREE_TEXT_FIELDS.has(k)) structured[k] = v;
  }
  return EXCLUDED_ADDRESS_RE.test(JSON.stringify(structured));
}

export function parseEmailShadowBody(rawBody: string): ParseResult {
  if (new TextEncoder().encode(rawBody).length > MAX_BODY_BYTES) {
    return { ok: false, reason: "payload_too_large" };
  }
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  const b = rec(json);
  if (!b) return { ok: false, reason: "invalid_payload" };
  const msgIdHash = hash(b.msg_id_hash);
  if (isExcludedGrokbot(rawBody, b)) {
    return { ok: false, reason: "excluded_grokbot", excluded: true };
  }
  if (b.v !== 1) return { ok: false, reason: "unsupported_version", msg_id_hash: msgIdHash ?? undefined };
  const mailbox = oneOf(b.mailbox, ["personal", "work"] as const);
  if (!mailbox) return { ok: false, reason: "invalid_mailbox", msg_id_hash: msgIdHash ?? undefined };
  if (!msgIdHash) return { ok: false, reason: "invalid_msg_id_hash" };
  const t = rec(b.triage);
  const disposition = t ? oneOf(t.disposition, DISPOSITIONS) : null;
  if (!t || !disposition) return { ok: false, reason: "invalid_triage", msg_id_hash: msgIdHash };
  if (b.override !== null && b.override !== undefined && !oneOf(b.override, OVERRIDES)) {
    return { ok: false, reason: "invalid_override", msg_id_hash: msgIdHash };
  }
  if (typeof b.subject !== "string" || typeof b.snippet !== "string") {
    return { ok: false, reason: "invalid_text", msg_id_hash: msgIdHash };
  }
  const fromDomainRaw = typeof b.from_domain === "string" ? b.from_domain.trim().toLowerCase() : "";
  const cc = typeof b.cc_count === "number" && Number.isInteger(b.cc_count) ? Math.min(Math.max(b.cc_count, 0), 999) : 0;
  return {
    ok: true,
    item: {
      mailbox,
      msg_id_hash: msgIdHash,
      thread_id_hash: hash(b.thread_id_hash),
      received_at: typeof b.received_at === "string" && ISO_RE.test(b.received_at) ? b.received_at : null,
      run_id: typeof b.run_id === "string" && RUN_ID_RE.test(b.run_id) ? b.run_id : null,
      from_domain: DOMAIN_RE.test(fromDomainRaw) ? fromDomainRaw : null,
      from_kind: oneOf(b.from_kind, FROM_KINDS) ?? "unknown",
      to_john_direct: bool(b.to_john_direct),
      cc_count: cc,
      list_unsubscribe: bool(b.list_unsubscribe),
      has_attachment: bool(b.has_attachment),
      gmail_category: oneOf(b.gmail_category, CATEGORIES),
      existing_labels: labels(b.existing_labels, EXISTING_LABELS_MAX),
      subject: cleanMaskClip(b.subject, SUBJECT_MAX),
      snippet: cleanMaskClip(b.snippet, SNIPPET_MAX),
      override: oneOf(b.override, OVERRIDES),
      triage: {
        disposition,
        lane: oneOf(t.lane, LANES) ?? "none",
        labels_applied: labels(t.labels_applied, TRIAGE_LABELS_MAX),
        escalated: bool(t.escalated),
      },
    },
  };
}
