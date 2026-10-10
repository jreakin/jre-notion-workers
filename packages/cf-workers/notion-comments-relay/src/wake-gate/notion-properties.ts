import type { GatePageInputs } from "./wake-gate-types.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function readTitle(prop: unknown): string | null {
  const rec = asRecord(prop);
  if (!rec || rec.type !== "title") return null;
  const title = rec.title;
  if (!Array.isArray(title) || title.length === 0) return null;
  const first = asRecord(title[0]);
  const plain = first?.plain_text;
  return typeof plain === "string" ? plain : null;
}

function readCheckbox(prop: unknown): boolean | null {
  const rec = asRecord(prop);
  if (!rec || rec.type !== "checkbox") return null;
  return typeof rec.checkbox === "boolean" ? rec.checkbox : null;
}

function readSelectName(prop: unknown): string | null {
  const rec = asRecord(prop);
  if (!rec || rec.type !== "select") return null;
  const sel = asRecord(rec.select);
  const name = sel?.name;
  return typeof name === "string" ? name : null;
}

function readRichText(prop: unknown): string | null {
  const rec = asRecord(prop);
  if (!rec || rec.type !== "rich_text") return null;
  const rt = rec.rich_text;
  if (!Array.isArray(rt) || rt.length === 0) return null;
  const first = asRecord(rt[0]);
  const plain = first?.plain_text;
  return typeof plain === "string" ? plain : null;
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
  const inTrash =
    typeof page.in_trash === "boolean"
      ? page.in_trash
      : partial.inTrashFromPayload ?? false;

  return {
    pageId: partial.pageId,
    dataSourceId: partial.dataSourceId,
    title,
    inTrash,
    needsJohn: readCheckbox(props["Needs John"]),
    sensitive: readCheckbox(props.Sensitive),
    kind: readSelectName(props.Kind),
    sourceRepo: readRichText(props["Source Repo"]),
    documentType: readSelectName(props["Document Type"]),
    hasClientsRelation: readRelationHasAny(props.Clients),
    hasProjectRelation: readRelationHasAny(props.Project),
    updatedPropertyIds: partial.updatedPropertyIds,
    notionEventType: partial.notionEventType,
    authorUserIds: partial.authorUserIds,
  };
}
