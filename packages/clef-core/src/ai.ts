/** Shared Workers AI Clef plumbing: run with timeout + gateway, and answer parsing helpers. */
import { CLEF_CALL_TIMEOUT_MS } from "./thresholds.js";

export type AiRunBinding = {
  run: (
    model: string,
    input: Record<string, unknown>,
    runOptions?: Record<string, unknown>,
  ) => Promise<unknown>;
};

export function buildClefRunArguments(
  gatewayIdRaw: string | undefined,
  modelName: string,
  state: string,
  questions: unknown,
  signal?: AbortSignal,
): { input: Record<string, unknown>; runOptions: Record<string, unknown> } {
  const input: Record<string, unknown> = { model: modelName, state, questions };
  const runOptions: Record<string, unknown> = {};
  const gatewayId = gatewayIdRaw?.trim();
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

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function unwrapAiResult(raw: unknown): Record<string, unknown> | null {
  const top = asRecord(raw);
  if (!top) {
    return null;
  }
  const nested = asRecord(top.result);
  return nested ?? top;
}

/** Returns the `answers` record of a Clef response, or null. */
export function clefAnswers(raw: unknown): Record<string, unknown> | null {
  const body = unwrapAiResult(raw);
  if (!body) {
    return null;
  }
  return asRecord(body.answers);
}

function validProbability(value: number | null): boolean {
  return value !== null && value >= 0 && value <= 1;
}

export function readNoul(answers: Record<string, unknown>, key: string): number | null {
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

export function readChoice<T extends string>(
  answers: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | null {
  const entry = asRecord(answers[key]);
  if (!entry || entry.type !== "choice") {
    return null;
  }
  const choice = entry.choice;
  if (typeof choice === "string" && (allowed as readonly string[]).includes(choice)) {
    return choice as T;
  }
  return null;
}

/** Probability-weighted score in [0, max]; null when missing/invalid. */
export function readScore(
  answers: Record<string, unknown>,
  key: string,
  max: number,
): number | null {
  const entry = asRecord(answers[key]);
  if (!entry || entry.type !== "score") {
    return null;
  }
  const score = entry.score;
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > max) {
    return null;
  }
  return score;
}

export function readConfidence(
  answers: Record<string, unknown>,
  key: string,
): number | null | "bad" {
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

/** AI.run with an abort + race timeout (rejects Error("clef_timeout")). */
export async function runClefModel(
  ai: AiRunBinding,
  gatewayId: string | undefined,
  slug: string,
  modelName: string,
  state: string,
  questions: unknown,
  timeoutMs: number = CLEF_CALL_TIMEOUT_MS,
): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("clef_timeout"));
    }, timeoutMs);
  });
  timeoutPromise.catch(() => {});

  try {
    const { input, runOptions } = buildClefRunArguments(
      gatewayId,
      modelName,
      state,
      questions,
      controller.signal,
    );
    const aiPromise = Promise.resolve().then(() => ai.run(slug, input, runOptions));
    return await Promise.race([aiPromise, timeoutPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** Error → log-safe reason (never includes the message text). */
export function clefErrorReason(err: unknown): string {
  if (err instanceof Error) {
    if (err.message === "clef_timeout") {
      return "clef_timeout";
    }
    return `clef_error:${err.name}`;
  }
  return "clef_error:Error";
}
