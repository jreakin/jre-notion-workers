import { type ClefOutcome, decideClefOutcome } from "./clef-decision-logic.js";
import {
  CLEF_CALL_TIMEOUT_MS,
  CLEF_FLASH_MODEL,
  CLEF_FLASH_MODEL_NAME,
  CLEF_FULL_MODEL,
  CLEF_FULL_MODEL_NAME,
} from "./clef-thresholds.js";
import type { Env } from "../env.js";

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
  const input: Record<string, unknown> = {
    model: modelName,
    state,
    questions: CLEF_QUESTIONS,
  };
  const runOptions: Record<string, unknown> = {};
  const gatewayId = env.AI_GATEWAY_ID?.trim();
  if (gatewayId) {
    runOptions.gateway = { id: gatewayId };
  }
  if (signal) {
    runOptions.signal = signal;
  }
  return { input, runOptions };
}

export function clefInputKeys(input: Record<string, unknown>): string[] {
  return Object.keys(input).sort();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function unwrapAiResult(raw: unknown): Record<string, unknown> | null {
  const top = asRecord(raw);
  if (!top) {
    return null;
  }
  const nested = asRecord(top.result);
  return nested ?? top;
}

function validProbability(value: number | null): boolean {
  return value !== null && value >= 0 && value <= 1;
}

function readNoul(answers: Record<string, unknown>, key: string): number | null {
  const entry = asRecord(answers[key]);
  if (!entry || entry.type !== "noul") {
    return null;
  }
  const noul = entry.noul;
  if (typeof noul !== "number" || !Number.isFinite(noul)) {
    return null;
  }
  return validProbability(noul) ? noul : null;
}

function readChoice(
  answers: Record<string, unknown>,
  key: string,
): "now" | "batch" | "ignore" | null {
  const entry = asRecord(answers[key]);
  if (!entry || entry.type !== "choice") {
    return null;
  }
  const choice = entry.choice;
  if (choice === "now" || choice === "batch" || choice === "ignore") {
    return choice;
  }
  return null;
}

function readConfidence(answers: Record<string, unknown>, key: string): number | null | "bad" {
  const entry = asRecord(answers[key]);
  if (!entry) {
    return null;
  }
  if (!("confidence" in entry)) {
    return null;
  }
  const confidence = entry.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
    return "bad";
  }
  if (confidence < 0 || confidence > 1) {
    return "bad";
  }
  return confidence;
}

export function parseClefAiResponse(raw: unknown, modelLabel: string): ParsedClefRun | null {
  const body = unwrapAiResult(raw);
  if (!body) {
    return null;
  }
  const answers = asRecord(body.answers);
  if (!answers) {
    return null;
  }
  const pAction = readNoul(answers, "q_action");
  const pDup = readNoul(answers, "q_dup");
  const qWhen = readChoice(answers, "q_when");
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

type AiRunBinding = {
  run: (
    model: string,
    input: Record<string, unknown>,
    runOptions?: Record<string, unknown>,
  ) => Promise<unknown>;
};

async function runClefModel(
  ai: AiRunBinding,
  env: Env,
  slug: string,
  modelName: string,
  state: string,
): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("clef_timeout"));
    }, CLEF_CALL_TIMEOUT_MS);
  });
  timeoutPromise.catch(() => {});

  try {
    const { input, runOptions } = buildClefAiRunArguments(env, modelName, state, controller.signal);
    const aiPromise = Promise.resolve().then(() => ai.run(slug, input, runOptions));
    return await Promise.race([aiPromise, timeoutPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function clefErrorReason(err: unknown): string {
  if (err instanceof Error) {
    if (err.message === "clef_timeout") {
      return "clef_timeout";
    }
    return `clef_error:${err.name}`;
  }
  return "clef_error:Error";
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
    const raw = await runClefModel(env.AI, env, CLEF_FLASH_MODEL, CLEF_FLASH_MODEL_NAME, state);
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
    const raw = await runClefModel(env.AI, env, CLEF_FULL_MODEL, CLEF_FULL_MODEL_NAME, state);
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
