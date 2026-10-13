import { resolveClefModeFromKv, type ClefModeResolution } from "../../../../clef-core/src/index.js";
import type { Env } from "../env.js";

export type { ClefMode, ClefModeResolution } from "../../../../clef-core/src/index.js";

export async function resolveClefMode(env: Env, gate = "clef_wake"): Promise<ClefModeResolution> {
  return resolveClefModeFromKv(env.RELAY_KV, env.CLEF_DEFAULT_MODE, gate);
}
