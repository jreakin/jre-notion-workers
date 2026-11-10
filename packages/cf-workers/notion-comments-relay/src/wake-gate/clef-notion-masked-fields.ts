import { maskPii } from "../../../../clef-core/src/index.js";
import { CLEF_FIELD_SHORT_MAX_CHARS } from "./clef-thresholds.js";
import { readLaunchScopeFromNotionProperties } from "./launch-scope-task.js";

const LANE_LIKE = /owner|lane|scope|agent|source/i;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function truncate(value: string, max: number): string {
  const chars: string[] = [];
  for (const ch of value) {
    if (chars.length >= max) break;
    chars.push(ch);
  }
  return chars.length < value.length ? `${chars.join("")}…` : chars.join("");
}

function maskShort(raw: string): string {
  return truncate(maskPii(raw, { bareDomains: true }), CLEF_FIELD_SHORT_MAX_CHARS);
}

function readSelectName(prop: Record<string, unknown>): string | undefined {
  const sel = asRecord(prop.select);
  return typeof sel?.name === "string" ? sel.name : undefined;
}

function readStatusName(prop: Record<string, unknown>): string | undefined {
  const st = asRecord(prop.status);
  return typeof st?.name === "string" ? st.name : undefined;
}

function readMultiSelect(prop: Record<string, unknown>): string | undefined {
  if (!Array.isArray(prop.multi_select) || prop.multi_select.length === 0) return undefined;
  const names: string[] = [];
  for (const entry of prop.multi_select) {
    const rec = asRecord(entry);
    if (rec && typeof rec.name === "string") names.push(rec.name);
  }
  return names.length ? names.join(",") : undefined;
}

export type ClefMaskedParse = {
  clefMasked: Record<string, string>;
  authorLane?: string;
  needsReview?: boolean;
  launchScopeLabel?: string;
  scopeLabel?: string;
  statusLabel?: string;
  usedTitlePropertyName?: string;
};

export function parseClefMaskedFieldsFromNotionProperties(
  properties: Record<string, unknown>,
): ClefMaskedParse {
  const clefMasked: Record<string, string> = {};
  let authorLane: string | undefined;
  let needsReview: boolean | undefined;
  let usedTitlePropertyName: string | undefined;

  for (const [name, raw] of Object.entries(properties)) {
    const prop = asRecord(raw);
    if (!prop) continue;
    if (prop.type === "title") usedTitlePropertyName = name;
    if (/needs review/i.test(name) && prop.type === "checkbox" && typeof prop.checkbox === "boolean") {
      needsReview = prop.checkbox;
      clefMasked.needs_review = prop.checkbox ? "true" : "false";
    }
    let value: string | undefined;
    if (prop.type === "select") value = readSelectName(prop);
    else if (prop.type === "status") value = readStatusName(prop);
    else if (prop.type === "multi_select") value = readMultiSelect(prop);
    if (value) {
      const key = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32);
      if (key) clefMasked[key] = maskShort(value);
    }
    if (!authorLane && LANE_LIKE.test(name)) {
      const laneVal = value ?? (prop.type === "rich_text" ? readRichPlain(prop) : undefined);
      if (laneVal) authorLane = maskShort(laneVal);
    }
  }
  const scope = readLaunchScopeFromNotionProperties(properties);
  return {
    clefMasked,
    authorLane,
    needsReview,
    launchScopeLabel: scope.launchScopeLabel,
    scopeLabel: scope.scopeLabel,
    statusLabel: scope.statusLabel,
    usedTitlePropertyName,
  };
}

function readRichPlain(prop: Record<string, unknown>): string | undefined {
  if (!Array.isArray(prop.rich_text)) return undefined;
  let out = "";
  for (const part of prop.rich_text) {
    const rec = asRecord(part);
    if (rec && typeof rec.plain_text === "string") out += rec.plain_text;
  }
  const trimmed = out.trim();
  return trimmed || undefined;
}
