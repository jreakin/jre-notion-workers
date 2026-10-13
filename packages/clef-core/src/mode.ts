import type { KvLike } from "./kv.js";

export type ClefMode = "off" | "shadow" | "live";

export const CLEF_GLOBAL_MODE_KEY = "clef:mode:global";
const GATE_KEY_PREFIX = "clef:mode:";

type ModeRaw = "missing" | "invalid" | ClefMode;

function classifyModeRaw(raw: string | null): ModeRaw {
  if (raw === null || raw.trim() === "") {
    return "missing";
  }
  const v = raw.trim().toLowerCase();
  if (v === "off" || v === "shadow" || v === "live") {
    return v;
  }
  return "invalid";
}

function classifyEnvDefault(defaultModeRaw: string | undefined): ModeRaw {
  const raw = (defaultModeRaw || "shadow").trim();
  if (!raw) {
    return "shadow";
  }
  return classifyModeRaw(raw);
}

export type ClefModeResolution = {
  allowClefCall: boolean;
  modeLabel: string;
  reason: string | null;
};

/**
 * Kill switch: `clef:mode:global` off wins; then `clef:mode:<gate>`; then global; then env default.
 * `live` is never honored yet (shadow only).
 */
export async function resolveClefModeFromKv(
  kv: KvLike,
  defaultModeRaw: string | undefined,
  gate: string,
): Promise<ClefModeResolution> {
  let globalRaw: string | null = null;
  let gateRaw: string | null = null;
  try {
    globalRaw = await kv.get(CLEF_GLOBAL_MODE_KEY);
    gateRaw = await kv.get(`${GATE_KEY_PREFIX}${gate}`);
  } catch {
    return { allowClefCall: false, modeLabel: "unknown", reason: "clef_kv_unavailable" };
  }

  const globalClass = classifyModeRaw(globalRaw);
  if (globalClass === "invalid") {
    return {
      allowClefCall: false,
      modeLabel: globalRaw?.trim() || "invalid",
      reason: "clef_mode_invalid",
    };
  }
  if (globalClass === "off") {
    return { allowClefCall: false, modeLabel: "off", reason: "clef_global_off" };
  }

  const gateClass = classifyModeRaw(gateRaw);
  if (gateClass === "invalid") {
    return {
      allowClefCall: false,
      modeLabel: gateRaw?.trim() || "invalid",
      reason: "clef_mode_invalid",
    };
  }

  const chosen: ModeRaw =
    gateClass !== "missing"
      ? gateClass
      : globalClass !== "missing"
        ? globalClass
        : classifyEnvDefault(defaultModeRaw);

  if (chosen === "invalid") {
    return {
      allowClefCall: false,
      modeLabel: defaultModeRaw?.trim() || "invalid",
      reason: "clef_mode_invalid",
    };
  }
  if (chosen === "off") {
    return { allowClefCall: false, modeLabel: "off", reason: "clef_mode_off" };
  }
  if (chosen === "live") {
    return { allowClefCall: true, modeLabel: "shadow", reason: "clef_live_not_enabled" };
  }
  return { allowClefCall: true, modeLabel: "shadow", reason: null };
}
