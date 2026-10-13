import {
  CLEF_FLASH_MODEL,
  CLEF_FLASH_MODEL_NAME,
  CLEF_FULL_MODEL,
  CLEF_FULL_MODEL_NAME,
  CLEF_STATE_MAX_CHARS,
  clefAnswers,
  clefErrorReason,
  readChoice,
  readConfidence,
  readNoul,
  readScore,
  runClefModel,
  type AiRunBinding,
} from "../../../clef-core/src/index.js";
import { LANES, type EmailShadowItem, type Lane } from "./payload.js";

export const EMAIL_QUESTIONS = {
  q_person: { type: "noul", instructions: "Is a real person writing to John personally and expecting a reply?" },
  q_money_sec: {
    type: "noul",
    instructions: "Is this about money due or failing, a credential/security event, or a lockout?",
  },
  q_lane: {
    type: "choice",
    instructions: "Which of John's lanes owns this email, if any?",
    criteria: {
      cos: "Chief of Staff: John's personal admin, scheduling, household, accounts",
      vep_desk: "VEP Desk: voter/election data products and their customers",
      qr_pm: "QR PM: Quorum Report publication, editors, subscribers",
      abstract_secretary: "Abstract Secretary: Abstract Data business, clients, contracts, invoices",
      none: "No lane needs it",
    },
  },
  q_bulk: { type: "noul", instructions: "Is this marketing, a newsletter, or spam?" },
  q_calendar: { type: "noul", instructions: "Is this a calendar or meeting change?" },
  q_urgency: {
    type: "score",
    instructions: "How urgent is this for John?",
    criteria: ["Not urgent", "This week", "Today", "Right now"],
  },
} as const;

/** Placeholder thresholds, fixed before shadow starts; calibrate on held-out days. */
export const EMAIL_THRESHOLDS = {
  ESCALATE_P_PERSON: 0.5,
  ESCALATE_P_MONEY_SEC: 0.3,
  ESCALATE_P_CALENDAR: 0.5,
  SKIP_P_BULK_MIN: 0.9,
  SKIP_P_PERSON_MAX: 0.05,
  SKIP_P_MONEY_SEC_MAX: 0.05,
} as const;

export const FLASH_SAMPLE_MOD = 10;

export type ShadowLabel = "escalate" | "fyi" | "would_skip";

export type ParsedEmailRun = {
  p_person: number;
  p_money_sec: number;
  lane: Lane;
  p_bulk: number;
  p_calendar: number;
  urgency: number | null;
  confidence: number | null;
};

export function parseEmailClefResponse(raw: unknown): ParsedEmailRun | null {
  const a = clefAnswers(raw);
  if (!a) return null;
  const p_person = readNoul(a, "q_person");
  const p_money_sec = readNoul(a, "q_money_sec");
  const lane = readChoice(a, "q_lane", LANES);
  const p_bulk = readNoul(a, "q_bulk");
  const p_calendar = readNoul(a, "q_calendar");
  const confidence = readConfidence(a, "q_lane");
  if (p_person === null || p_money_sec === null || lane === null || p_bulk === null || p_calendar === null) {
    return null;
  }
  if (confidence === "bad") return null;
  // urgency is log-only: a bad/missing score does not invalidate the run.
  return { p_person, p_money_sec, lane, p_bulk, p_calendar, urgency: readScore(a, "q_urgency", 3), confidence };
}

export function deriveShadowLabel(p: ParsedEmailRun | null): ShadowLabel {
  if (!p) return "escalate"; // uncertain / error / timeout / bad output
  const t = EMAIL_THRESHOLDS;
  if (
    p.p_person >= t.ESCALATE_P_PERSON ||
    p.p_money_sec >= t.ESCALATE_P_MONEY_SEC ||
    p.p_calendar >= t.ESCALATE_P_CALENDAR ||
    p.lane !== "none"
  ) {
    return "escalate";
  }
  if (p.p_bulk >= t.SKIP_P_BULK_MIN && p.p_person <= t.SKIP_P_PERSON_MAX && p.p_money_sec <= t.SKIP_P_MONEY_SEC_MAX) {
    return "would_skip";
  }
  return "fyi";
}

/** Deterministic 10% flash side-by-side sample: hash mod 10 = 0. */
export function isFlashSample(msgIdHash: string): boolean {
  const tail = msgIdHash.slice(-8);
  const n = Number.parseInt(tail, 16);
  return Number.isFinite(n) && n % FLASH_SAMPLE_MOD === 0;
}

/** Compact state for Clef. Contains masked subject/snippet — transient, never logged. */
export function buildEmailState(item: EmailShadowItem): string {
  const meta = [
    `mailbox: ${item.mailbox}`,
    `from_domain: ${item.from_domain ?? "unknown"}`,
    `from_kind: ${item.from_kind}`,
    `to_john_direct: ${item.to_john_direct}`,
    `cc_count: ${item.cc_count}`,
    `list_unsubscribe: ${item.list_unsubscribe}`,
    `has_attachment: ${item.has_attachment}`,
    `gmail_category: ${item.gmail_category ?? "unknown"}`,
    `labels: ${item.existing_labels.join(", ") || "none"}`,
    `subject: ${item.subject}`,
  ].join("\n");
  const head = `${meta}\nsnippet: `;
  const room = Math.max(0, CLEF_STATE_MAX_CHARS - head.length);
  return (head + item.snippet.slice(0, room)).slice(0, CLEF_STATE_MAX_CHARS);
}

export type EmailClefCall =
  | { ok: true; parsed: ParsedEmailRun; latency_ms: number; model: string }
  | { ok: false; reason: string; latency_ms: number; model: string };

export async function invokeEmailClef(
  ai: AiRunBinding | undefined,
  gatewayId: string | undefined,
  variant: "full" | "flash",
  state: string,
): Promise<EmailClefCall> {
  const slug = variant === "full" ? CLEF_FULL_MODEL : CLEF_FLASH_MODEL;
  const name = variant === "full" ? CLEF_FULL_MODEL_NAME : CLEF_FLASH_MODEL_NAME;
  const started = Date.now();
  if (!ai) return { ok: false, reason: "clef_ai_unbound", latency_ms: 0, model: name };
  try {
    const raw = await runClefModel(ai, gatewayId, slug, name, state, EMAIL_QUESTIONS);
    const parsed = parseEmailClefResponse(raw);
    const latency_ms = Date.now() - started;
    if (!parsed) return { ok: false, reason: "clef_bad_output", latency_ms, model: name };
    return { ok: true, parsed, latency_ms, model: name };
  } catch (err) {
    return { ok: false, reason: clefErrorReason(err), latency_ms: Date.now() - started, model: name };
  }
}
