import type { GatePageInputs } from "./wake-gate-types.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function joinPlainText(segments: unknown): string | null {
  if (!Array.isArray(segments) || segments.length === 0) return null;
  const parts: string[] = [];
  for (const item of segments) {
    const rec = asRecord(item);
    const plain = rec?.plain_text;
    if (typeof plain === "string") parts.push(plain);
  }
  if (parts.length === 0) return null;
  return parts.join("");
}

function readTitle(prop: unknown): string | null {
  const rec = asRecord(prop);
  if (!rec || rec.type !== "title") return null;
  return joinPlainText(rec.title);
}

function readCheckbox(prop: unknown): boolean | null {
  const rec = asRecord(prop);
  if (!rec || rec.type !== "checkbox") return null;
  return typeof rec.checkbox === "boolean" ? rec.checkbox : null;
}

type SelectRead = { value: string | null; schemaSurprise: boolean };

function readSelectName(prop: unknown): SelectRead {
  if (prop === undefined) {
    return { value: null, schemaSurprise: true };
  }
  const rec = asRecord(prop);
  if (!rec || rec.type !== "select") {
    return { value: null, schemaSurprise: true };
  }
  const sel = asRecord(rec.select);
  const name = sel?.name;
  return {
    value: typeof name === "string" ? name : null,
    schemaSurprise: false,
  };
}

type RichTextRead = { value: string | null; schemaSurprise: boolean };

function readRichText(prop: unknown): RichTextRead {
  if (prop === undefined) {
    return { value: null, schemaSurprise: true };
  }
  const rec = asRecord(prop);
  if (!rec || rec.type !== "rich_text") {
    return { value: null, schemaSurprise: true };
  }
  const joined = joinPlainText(rec.rich_text);
  return { value: joined, schemaSurprise: false };
}

function readRelationHasAny(prop: unknown): boolean | null {
  const rec = asRecord(prop);
  if (!rec || rec.type !== "relation") return null;
  const rel = rec.relation;
  if (!Array.isArray(rel)) return null;
  return rel.length > 0;
}

export function gateInputsFromNotionPage(
  page: Record<string, unknown>,
  partial: {
    pageId: string;
    dataSourceId: string | null;
    updatedPropertyIds: string[];
    updatedPropertiesKnown: boolean;
    notionEventType: string | null;
    authorUserIds: string[];
    titleFromAutomation: string | null;
    inTrashFromPayload: boolean | null;
  },
): GatePageInputs {
  const props = asRecord(page.properties) ?? {};
  const title =
    readTitle(props.Name) ??
    readTitle(props.name) ??
    partial.titleFromAutomation ??
    null;
  const archived = page.archived === true;
  const inTrash =
    archived ||
    (typeof page.in_trash === "boolean"
      ? page.in_trash
      : partial.inTrashFromPayload ?? false);

  const kindRead = readSelectName(props.Kind);
  const sourceRead = readRichText(props["Source Repo"]);
  const docTypeRead = readSelectName(props["Document Type"]);
  const sourceRepo =
    sourceRead.value !== null ? sourceRead.value.trim() : sourceRead.value;

  return {
    pageId: partial.pageId,
    dataSourceId: partial.dataSourceId,
    title,
    inTrash,
    needsJohn: readCheckbox(props["Needs John"]),
    sensitive: readCheckbox(props.Sensitive),
    kind: kindRead.value,
    sourceRepo,
    documentType: docTypeRead.value,
    hasClientsRelation: readRelationHasAny(props.Clients),
    hasProjectRelation: readRelationHasAny(props.Project),
    updatedPropertyIds: partial.updatedPropertyIds,
    updatedPropertiesKnown: partial.updatedPropertiesKnown,
    notionEventType: partial.notionEventType,
    authorUserIds: partial.authorUserIds,
    schemaNeedsPropertyFetch:
      kindRead.schemaSurprise || sourceRead.schemaSurprise || docTypeRead.schemaSurprise,
  };
}
