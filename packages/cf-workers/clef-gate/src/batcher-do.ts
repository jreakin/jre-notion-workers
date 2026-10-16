import { DurableObject } from "cloudflare:workers";
import {
  CLEF_FULL_MODEL,
  CLEF_FULL_MODEL_NAME,
  clefDailyCapKey,
  parseDailyCap,
  runClefModel,
  tryConsumeDailyCall,
} from "../../../clef-core/src/index.js";
import { BATCH_CALL_TIMEOUT_MS, buildBatchRequest, ClefBatchCore, parseBatchSize, type BatchItemResult } from "./batch.js";
import type { Env } from "./env.js";

/**
 * One instance (idFromName("clef_email")) collects emails for ~2 s or until the batch is full, then
 * makes one Clef call. Email states stay in memory only (never in DO storage, never logged).
 */
export class ClefEmailBatcher extends DurableObject<Env> {
  private core: ClefBatchCore;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const cap = parseDailyCap(env.CLEF_EMAIL_DAILY_CALL_CAP, 1000);
    this.core = new ClefBatchCore({
      maxSize: parseBatchSize(env.CLEF_EMAIL_BATCH_SIZE),
      consume: async () => {
        const r = await tryConsumeDailyCall(env.CLEF_KV, clefDailyCapKey("clef_email"), cap);
        return r.ok ? null : r.reason;
      },
      run: async (states) => {
        if (!env.AI) throw new Error("clef_ai_unbound");
        const { state, questions } = buildBatchRequest(states);
        // Same no-log / no-cache gateway options as the single-email call.
        const gateway = { id: env.AI_GATEWAY_ID, collectLog: false, skipCache: true };
        return runClefModel(env.AI, gateway, CLEF_FULL_MODEL, CLEF_FULL_MODEL_NAME, state, questions, BATCH_CALL_TIMEOUT_MS);
      },
    });
  }

  async classify(state: string): Promise<BatchItemResult> {
    return this.core.submit(state);
  }
}
