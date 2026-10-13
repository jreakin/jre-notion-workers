import { type ClefOutcome, decideClefOutcome } from "./clef-decision-logic.js";
import {
  CLEF_FLASH_MODEL,
  CLEF_FLASH_MODEL_NAME,
  CLEF_FULL_MODEL,
  CLEF_FULL_MODEL_NAME,
} from "./clef-thresholds.js";
import type { Env } from "../env.js";
import {
  type AiRunBinding,
  buildClefRunArguments,
  clefAnswers,
  clefErrorReason,
  clefInputKeys,
  readChoice,
  readConfidence,
  readNoul,
  runClefModel,
} from "../../../../clef-core/src/index.js";

const WHEN_CHOICES = ["now", "batch", "ignore"] as const;

export const CLEF_QUESTIONS = {
  q_action: {
    type: "noul",
    instructions: "Does the receiving lane need to read or act on this today?",
  },
  q_dup: {
    type: "noul",
    instructions: "Is this a duplicate or echo of a recent event or the lane's own write?",
  },
  q_when: {
    type: "choice",
    instructions: "When should the lane see this event?",
    criteria: {
      now: "Needs attention immediately",
      batch: "Can wait and be batched",
      ignore: "No action needed",
    },
  },
} as const;

export type ParsedClefRun = {
  model: string;
  pAction: number;
  pDup: number;
  qWhen: "now" | "batch" | "ignore";
  confidence: number | null;
  decision: ClefOutcome;
  latencyMs: number;
};

export function buildClefAiRunArguments(
  env: Env,
  modelName: string,
  state: string,
  signal?: AbortSignal,
): { input: Record<string, unknown>; runOptions: Record<string, unknown> } {
  return buildClefRunArguments(env.AI_GATEWAY_ID, modelName, state, CLEF_QUESTIONS, signal);
}

export { clefInputKeys };

export function parseClefAiResponse(raw: unknown, modelLabel: string): ParsedClefRun | null {
  const answers = clefAnswers(raw);
  if (!answers) {
    return null;
  }
  const pAction = readNoul(answers, "q_action");
  const pDup = readNoul(answers, "q_dup");
  const qWhen = readChoice(answers, "q_when", WHEN_CHOICES);
  const confidence = readConfidence(answers, "q_when");
  if (pAction === null || pDup === null || qWhen === null || confidence === "bad") {
    return null;
  }
  return {
    model: modelLabel,
    pAction,
    pDup,
    qWhen,
    confidence,
    decision: decideClefOutcome(pAction, pDup, qWhen),
    latencyMs: 0,
  };
}

function runRelayClefModel(env: Env, ai: AiRunBinding, slug: string, modelName: string, state: string) {
  return runClefModel(ai, env.AI_GATEWAY_ID, slug, modelName, state, CLEF_QUESTIONS);
}

export async function invokeClefFlash(
  env: Env,
  state: string,
): Promise<{ ok: true; parsed: ParsedClefRun } | { ok: false; reason: string }> {
  if (!env.AI) {
    return { ok: false, reason: "clef_ai_unbound" };
  }
  const started = Date.now();
  try {
    const raw = await runRelayClefModel(env, env.AI, CLEF_FLASH_MODEL, CLEF_FLASH_MODEL_NAME, state);
    const parsed = parseClefAiResponse(raw, CLEF_FLASH_MODEL_NAME);
    if (!parsed) {
      return { ok: false, reason: "clef_bad_output" };
    }
    parsed.latencyMs = Date.now() - started;
    return { ok: true, parsed };
  } catch (err) {
    return { ok: false, reason: clefErrorReason(err) };
  }
}

export async function invokeClefFull(
  env: Env,
  state: string,
): Promise<{ ok: true; parsed: ParsedClefRun } | { ok: false; reason: string }> {
  if (!env.AI) {
    return { ok: false, reason: "clef_ai_unbound" };
  }
  const started = Date.now();
  try {
    const raw = await runRelayClefModel(env, env.AI, CLEF_FULL_MODEL, CLEF_FULL_MODEL_NAME, state);
    const parsed = parseClefAiResponse(raw, CLEF_FULL_MODEL_NAME);
    if (!parsed) {
      return { ok: false, reason: "clef_bad_output" };
    }
    parsed.latencyMs = Date.now() - started;
    return { ok: true, parsed };
  } catch (err) {
    return { ok: false, reason: clefErrorReason(err) };
  }
}
