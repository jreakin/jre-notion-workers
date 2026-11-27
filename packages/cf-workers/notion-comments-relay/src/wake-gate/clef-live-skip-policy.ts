import { CLEF_GLOBAL_MODE_KEY } from "../../../../clef-core/src/mode.js";
import type { ClefModeResolution } from "./clef-mode.js";
import type { Env } from "../env.js";

const GATE_KEY_PREFIX = "clef:mode:";

/** True when env var is exactly `1` (trimmed). */
export function clefEnvLiveFlagOn(raw: string | undefined): boolean {
  return raw?.trim() === "1";
}

export function clefSkipPageCreatedLiveEnabled(env: Pick<Env, "CLEF_SKIP_PAGE_CREATED_LIVE">): boolean {
  return clefEnvLiveFlagOn(env.CLEF_SKIP_PAGE_CREATED_LIVE);
}

export function clefSkipCommentsLive(env: Pick<Env, "CLEF_SKIP_COMMENTS_LIVE">): boolean {
  return clefEnvLiveFlagOn(env.CLEF_SKIP_COMMENTS_LIVE);
}

export function clefSkipPropertiesUpdatedLive(env: Pick<Env, "CLEF_SKIP_PROPERTIES_UPDATED_LIVE">): boolean {
  return clefEnvLiveFlagOn(env.CLEF_SKIP_PROPERTIES_UPDATED_LIVE);
}

export function wantsClefLiveVerdictAwait(env: Env, notionType: string | null): boolean {
  if (clefSkipPageCreatedLiveEnabled(env) && notionType === "page.created") {
    return true;
  }
  if (clefSkipCommentsLive(env) && Boolean(notionType?.startsWith("comment."))) {
    return true;
  }
  if (clefSkipPropertiesUpdatedLive(env) && notionType === "page.properties_updated") {
    return true;
  }
  return false;
}

/**
 * Clef KV / mode resolution must allow env-driven live skip. Any fallback reason, off, or unknown mode ⇒ fail open
 * (forward). Shadow mode from env default alone does not block; explicit KV `off` / `shadow` is handled by
 * {@link kvExplicitlyBlocksClefLiveSkip}.
 */
export function clefModePermitsEnvLiveSkip(modeRes: ClefModeResolution): boolean {
  if (!modeRes.allowClefCall) {
    return false;
  }
  if (modeRes.modeLabel === "off" || modeRes.modeLabel === "unknown") {
    return false;
  }
  if (modeRes.reason) {
    return false;
  }
  return true;
}

/**
 * Instant kill switch without redeploy: explicit `clef:mode:global` or `clef:mode:clef_wake` = `off` | `shadow`.
 * Unset keys do not block env live flags. KV read error ⇒ block live skip (fail open / forward).
 */
export async function kvExplicitlyBlocksClefLiveSkip(
  env: Pick<Env, "RELAY_KV">,
  gate = "clef_wake",
): Promise<boolean> {
  try {
    const keys = [CLEF_GLOBAL_MODE_KEY, `${GATE_KEY_PREFIX}${gate}`] as const;
    for (const key of keys) {
      const raw = await env.RELAY_KV.get(key);
      if (raw === null || raw.trim() === "") {
        continue;
      }
      const v = raw.trim().toLowerCase();
      if (v === "off" || v === "shadow") {
        return true;
      }
    }
    return false;
  } catch {
    return true;
  }
}
