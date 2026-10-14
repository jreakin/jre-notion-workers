/**
 * Durable gate log: batched KV ring read by Notion Steward's Gate Log writer.
 *
 * Budget: account-wide KV writes must stay < 1k/day. Rows are buffered in isolate memory and
 * written as ONE KV value per flush (never per event); flush writes are capped per UTC day by a
 * write-frugal soft counter; near the cap low-signal rows are sampled out. Console (Workers Logs)
 * still receives every row, so KV loss is never data loss for the full stream.
 *
 * Key schema (v1) — see README "Gate log KV ring":
 *   gate_log:v1:<YYYY-MM-DD>:<HH>:<flushId>     value = {"v":1,"flushed_at":ISO,"rows":[GateLogRow…]}
 *   TTL 7 days. <HH> is the UTC hour of the flush. <flushId> = <isolateId>-<seq> (unique; no RMW).
 *   Daily flush counter: gate_log:writes:<YYYY-MM-DD> (soft, persisted every 8 flushes, TTL 48h).
 *
 * Every function here is fail-open: errors are swallowed and never reach the forward path.
 */
import type { Env } from "./env.js";
import { kvTtl } from "./kv-ttl.js";
import { peekSoftDailyCount, trySoftDailyConsume } from "./soft-daily-counter.js";

export const GATE_LOG_PREFIX = "gate_log:v1:";
export const GATE_LOG_TTL_SECONDS = 60 * 60 * 24 * 7;
export const GATE_LOG_FLUSH_ROWS = 25;
/** A partial batch older than this is flushed at end of request / on cron (low-traffic path). */
export const GATE_LOG_FLUSH_MAX_AGE_MS = 5 * 60_000;
export const GATE_LOG_BUFFER_MAX = 200;
export const GATE_LOG_DAILY_WRITE_CAP_DEFAULT = 60;
export const GATE_LOG_COUNTER_NAME = "gate_log:writes";
export const GATE_LOG_COUNTER_PERSIST_EVERY = 8;
/** At ≥ this fraction of the daily cap, keep only high-signal rows + a sample of the rest. */
export const GATE_LOG_NEAR_CAP_FRACTION = 0.8;
export const GATE_LOG_NEAR_CAP_SAMPLE_PERCENT = 25;

export type GateLogStream = "clef_wake_shadow" | "wake_gate_shadow" | "ad_docs_wake_gate_shadow";

export type GateLogRow = { stream: GateLogStream } & Record<string, unknown>;

const isolateId = Math.random().toString(36).slice(2, 10);
let seq = 0;
let buffer: GateLogRow[] = [];
let oldestAt = 0;
let sampleTick = 0;

export function streamEnabled(env: Env, stream: GateLogStream): boolean {
  return stream === "clef_wake_shadow" ? env.CLEF_RING === "1" : env.WAKE_GATE_KV_RING === "1";
}

export function readGateLogDailyWriteCap(env: Env): number {
  const n = Number.parseInt(env.GATE_LOG_DAILY_WRITE_CAP?.trim() ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : GATE_LOG_DAILY_WRITE_CAP_DEFAULT;
}

/** High-signal rows survive near-cap sampling. */
export function isHighSignal(row: GateLogRow): boolean {
  if (row.candidate_false_skip === true) return true;
  const reason = typeof row.reason === "string" ? row.reason : "";
  if (reason.includes("error")) return true;
  if (row.stream === "clef_wake_shadow") {
    return row.clef_decision !== row.rule_decision;
  }
  return row.decision === "would_skip";
}

export function gateLogKey(now: Date, flushId: string): string {
  const iso = now.toISOString();
  return `${GATE_LOG_PREFIX}${iso.slice(0, 10)}:${iso.slice(11, 13)}:${flushId}`;
}

/** Rows waiting for the end-of-request RPC to the durable buffer (DO path only). */
let doPending: GateLogRow[] = [];
export const GATE_LOG_DO_RPC_TIMEOUT_MS = 2_000;

/**
 * DO path: send this isolate's pending rows to the single GateLogBuffer DO in ONE RPC
 * (one DO request per webhook). Fail-open: on error/timeout rows are dropped from KV
 * (Workers Logs still has them) and nothing propagates to the forward path.
 */
export async function shipGateLogRowsToDurableObject(env: Env): Promise<boolean> {
  if (!env.GATE_LOG_DO || doPending.length === 0) return false;
  const rows = doPending;
  doPending = [];
  try {
    const ns = env.GATE_LOG_DO;
    const stub = ns.get(ns.idFromName("gate_log"));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error("gate_log_do_timeout")), GATE_LOG_DO_RPC_TIMEOUT_MS);
    });
    try {
      await Promise.race([stub.append(rows), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return true;
  } catch (err) {
    try {
      console.log(
        JSON.stringify({
          event: "gate_log_do_error",
          error: err instanceof Error ? err.message.slice(0, 40) : "Error",
          dropped_rows: rows.length,
        }),
      );
    } catch {
      // ignore
    }
    return false;
  }
}

export async function enqueueGateLogRow(env: Env, row: GateLogRow): Promise<void> {
  try {
    if (!streamEnabled(env, row.stream)) return;
    if (env.GATE_LOG_DO) {
      if (readGateLogDailyWriteCap(env) === 0) return;
      doPending.push(row);
      if (doPending.length > GATE_LOG_BUFFER_MAX) doPending = doPending.slice(-GATE_LOG_BUFFER_MAX);
      return; // shipped at end of request (no KV reads/writes here)
    }
    const cap = readGateLogDailyWriteCap(env);
    if (cap === 0) return;
    const used = await peekSoftDailyCount(env.RELAY_KV, GATE_LOG_COUNTER_NAME);
    if (used >= cap) return; // over budget: console only
    if (used >= Math.floor(cap * GATE_LOG_NEAR_CAP_FRACTION) && !isHighSignal(row)) {
      sampleTick += 1;
      if (sampleTick % Math.round(100 / GATE_LOG_NEAR_CAP_SAMPLE_PERCENT) !== 0) return;
      row = { ...row, sampled_near_cap: true };
    }
    if (buffer.length === 0) oldestAt = Date.now();
    buffer.push(row);
    if (buffer.length > GATE_LOG_BUFFER_MAX) buffer = buffer.slice(-GATE_LOG_BUFFER_MAX);
    await flushGateLogRing(env);
  } catch {
    // fail open
  }
}

/**
 * Pacing floor so a steady trickle can't burn the whole daily cap early: the minimum age before a
 * partial batch flushes is max(5 min, time-left-in-UTC-day / flushes-left). Full batches (25 rows)
 * ignore pacing but still consume the same capped budget.
 */
export function pacedMinAgeMs(used: number, cap: number, now: Date = new Date()): number {
  const left = Math.max(1, cap - used);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(GATE_LOG_FLUSH_MAX_AGE_MS, Math.floor((end - now.getTime()) / left));
}

/**
 * Flush when the batch is full, a partial batch is older than the paced min age, or `force`
 * (cron: this isolate holds rows). At most one KV write per call; always capped by
 * GATE_LOG_DAILY_WRITE_CAP.
 */
export async function flushGateLogRing(env: Env, opts: { force?: boolean } = {}): Promise<boolean> {
  if (env.GATE_LOG_DO) {
    return shipGateLogRowsToDurableObject(env); // durable path: DO alarm owns pacing + cap
  }
  try {
    if (buffer.length === 0) return false;
    const cap = readGateLogDailyWriteCap(env);
    let due = opts.force === true || buffer.length >= GATE_LOG_FLUSH_ROWS;
    if (!due) {
      const used = await peekSoftDailyCount(env.RELAY_KV, GATE_LOG_COUNTER_NAME);
      due = Date.now() - oldestAt >= pacedMinAgeMs(used, cap);
    }
    if (!due) return false;
    const rows = buffer;
    buffer = [];
    const budget = await trySoftDailyConsume(
      env.RELAY_KV,
      GATE_LOG_COUNTER_NAME,
      cap,
      GATE_LOG_COUNTER_PERSIST_EVERY,
    );
    if (!budget.ok) return false; // drop; console already has the rows
    const now = new Date();
    seq += 1;
    await env.RELAY_KV.put(
      gateLogKey(now, `${isolateId}-${seq}`),
      JSON.stringify({ v: 1, flushed_at: now.toISOString(), rows }),
      { expirationTtl: kvTtl(GATE_LOG_TTL_SECONDS) },
    );
    return true;
  } catch {
    return false;
  }
}

/** Test hook: pretend the oldest buffered row is `ms` old. */
export function ageGateLogBufferForTests(ms: number): void {
  oldestAt = Date.now() - ms;
}

export function gateLogBufferSizeForTests(): number {
  return buffer.length;
}

export function gateLogDoPendingForTests(): number {
  return doPending.length;
}

export function resetGateLogRingForTests(): void {
  doPending = [];
  buffer = [];
  oldestAt = 0;
  seq = 0;
  sampleTick = 0;
}
