import type { Env } from "../env.js";

export type ClefMode = "off" | "shadow" | "live";

const GLOBAL_KEY = "clef:mode:global";
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

function classifyEnvDefault(env: Env): ModeRaw {
  const raw = (env.CLEF_DEFAULT_MODE || "shadow").trim();
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

export async function resolveClefMode(env: Env, gate = "clef_wake"): Promise<ClefModeResolution> {
  let globalRaw: string | null = null;
  let gateRaw: string | null = null;
  try {
    globalRaw = await env.RELAY_KV.get(GLOBAL_KEY);
    gateRaw = await env.RELAY_KV.get(`${GATE_KEY_PREFIX}${gate}`);
  } catch {
    return {
      allowClefCall: false,
      modeLabel: "unknown",
      reason: "clef_kv_unavailable",
    };
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
    return {
      allowClefCall: false,
      modeLabel: "off",
      reason: "clef_global_off",
    };
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
        : classifyEnvDefault(env);

  if (chosen === "invalid") {
    return {
      allowClefCall: false,
      modeLabel: env.CLEF_DEFAULT_MODE?.trim() || "invalid",
      reason: "clef_mode_invalid",
    };
  }
  if (chosen === "off") {
    return {
      allowClefCall: false,
      modeLabel: "off",
      reason: "clef_mode_off",
    };
  }
  if (chosen === "live") {
    return {
      allowClefCall: true,
      modeLabel: "shadow",
      reason: "clef_live_not_enabled",
    };
  }
  return {
    allowClefCall: true,
    modeLabel: "shadow",
    reason: null,
  };
}
