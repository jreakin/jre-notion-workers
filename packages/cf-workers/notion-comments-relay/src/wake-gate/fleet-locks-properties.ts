import { readPageParentIds } from "./notion-ids.js";

export const FLEET_LOCKS_PROPERTY_IDS = {
  status: "]GbO",
  adoptedAt: "yDiF",
  adoptedBy: "jmwP",
  adoptionSource: "nDiV",
  grandfathered: "H=?>",
} as const;

export const FLEET_LOCKS_NON_SUBMITTED_PROPERTY_ID_VALUES = [
  "%5DGbO",
  "]GbO",
  "yDiF",
  "jmwP",
  "nDiV",
  "H%3D%3F%3E",
  "H=?>",
] as const;

export const FLEET_LOCKS_STATUS_ADOPTED = "Adopted";

export type ParsedAdDocsProperties = {
  title?: string;
  needsJohn?: boolean;
  sensitive?: boolean;
  kind?: string;
  sourceRepo?: string;
  documentType?: string;
  inTrash?: boolean;
};

export type ParseAdDocsOutcome =
  | { ok: true; properties: ParsedAdDocsProperties }
  | { ok: false; reason: "needs_property_fetch" };

export type ParsedFleetLocksFields = {
  statusName?: string;
  adoptedAt?: string;
  adoptedBySet: boolean;
  adoptedByPersonIds: string[];
  grandfathered: boolean;
  parseOk: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function decodeNotionPropertyId(id: string): string {
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

function propertyIdMatches(apiId: string, targetId: string): boolean {
  const decodedApi = decodeNotionPropertyId(apiId);
  const decodedTarget = decodeNotionPropertyId(targetId);
  return decodedApi === decodedTarget || apiId === targetId;
}

export function findNotionProperty(
  properties: Record<string, unknown>,
  targetId: string,
  nameFallbacks: string[],
): Record<string, unknown> | null {
  if (targetId) {
    for (const raw of Object.values(properties)) {
      const prop = asRecord(raw);
      if (!prop) {
        continue;
      }
      const pid = typeof prop.id === "string" ? prop.id : "";
      if (pid && propertyIdMatches(pid, targetId)) {
        return prop;
      }
    }
  }
  for (const [name, raw] of Object.entries(properties)) {
    if (!nameFallbacks.includes(name)) {
      continue;
    }
    const prop = asRecord(raw);
    if (prop) {
      return prop;
    }
  }
  return null;
}

export function readPageParentDataSourceId(page: Record<string, unknown>): string | undefined {
  const ids = readPageParentIds(page);
  return ids.dataSourceId ?? ids.databaseId;
}

function plainTextFromRichArray(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }
  let out = "";
  for (const part of value) {
    const rec = asRecord(part);
    if (!rec) {
      continue;
    }
    const text = rec.plain_text;
    if (typeof text === "string") {
      out += text;
    }
  }
  return out;
}

export function readPageAuthorId(
  page: Record<string, unknown>,
  notionType: string | null,
  webhookAuthorId?: string,
): string | undefined {
  const createdBy = asRecord(page.created_by);
  const lastEditedBy = asRecord(page.last_edited_by);
  const isCreate =
    notionType === "page.created" || notionType === "page.added" || notionType === "page_created";
  if (isCreate) {
    if (typeof createdBy?.id === "string") {
      return createdBy.id;
    }
    return webhookAuthorId;
  }
  if (typeof lastEditedBy?.id === "string") {
    return lastEditedBy.id;
  }
  return webhookAuthorId;
}

export function readPageUserIds(page: Record<string, unknown>): {
  createdById?: string;
  lastEditedById?: string;
} {
  const createdBy = asRecord(page.created_by);
  const lastEditedBy = asRecord(page.last_edited_by);
  return {
    createdById: typeof createdBy?.id === "string" ? createdBy.id : undefined,
    lastEditedById: typeof lastEditedBy?.id === "string" ? lastEditedBy.id : undefined,
  };
}

function readTitleFromProperties(properties: Record<string, unknown>): string | undefined {
  const titleProp =
    findNotionProperty(properties, "", ["Title", "Name"]) ??
    asRecord(properties.Title) ??
    asRecord(properties.Name);
  if (!titleProp) {
    return undefined;
  }
  if (titleProp.type === "title") {
    const text = plainTextFromRichArray(titleProp.title).trim();
    return text || undefined;
  }
  return undefined;
}

function readCheckbox(prop: Record<string, unknown> | null): boolean | undefined {
  if (!prop) {
    return undefined;
  }
  if (prop.type === "checkbox" && typeof prop.checkbox === "boolean") {
    return prop.checkbox;
  }
  return undefined;
}

function readSelectName(prop: Record<string, unknown> | null): string | undefined {
  if (!prop || prop.type !== "select") {
    return undefined;
  }
  const sel = asRecord(prop.select);
  if (!sel) {
    return undefined;
  }
  return typeof sel.name === "string" ? sel.name : undefined;
}

function readDateStart(prop: Record<string, unknown> | null): string | undefined {
  if (!prop || prop.type !== "date") {
    return undefined;
  }
  const date = asRecord(prop.date);
  if (!date) {
    return undefined;
  }
  return typeof date.start === "string" && date.start.length > 0 ? date.start : undefined;
}

function readPeopleIds(prop: Record<string, unknown> | null): string[] {
  if (!prop || prop.type !== "people" || !Array.isArray(prop.people)) {
    return [];
  }
  const ids: string[] = [];
  for (const person of prop.people) {
    const rec = asRecord(person);
    if (rec && typeof rec.id === "string") {
      ids.push(rec.id);
    }
  }
  return ids;
}

export function parseAdDocsPropertiesFromNotionPage(
  page: Record<string, unknown>,
): ParseAdDocsOutcome {
  const props = asRecord(page.properties);
  if (!props) {
    return { ok: false, reason: "needs_property_fetch" };
  }
  const needsJohnProp = findNotionProperty(props, "", ["Needs John", "needs_john"]);
  const sensitiveProp = findNotionProperty(props, "", ["Sensitive", "sensitive"]);
  const kindProp = findNotionProperty(props, "", ["Kind", "kind"]);
  if (needsJohnProp && needsJohnProp.type !== "checkbox") {
    return { ok: false, reason: "needs_property_fetch" };
  }
  if (sensitiveProp && sensitiveProp.type !== "checkbox") {
    return { ok: false, reason: "needs_property_fetch" };
  }
  if (kindProp && kindProp.type !== "select") {
    return { ok: false, reason: "needs_property_fetch" };
  }
  const needsJohn = readCheckbox(needsJohnProp);
  const sensitive = readCheckbox(sensitiveProp);
  const kind = readSelectName(kindProp) ?? undefined;
  const sourceRepo =
    readSelectName(findNotionProperty(props, "", ["Source Repo", "source_repo"])) ?? undefined;
  const documentType =
    readSelectName(findNotionProperty(props, "", ["Document Type", "document_type"])) ?? undefined;
  return {
    ok: true,
    properties: {
      title: readTitleFromProperties(props),
      needsJohn: needsJohn === true,
      sensitive: sensitive === true,
      kind,
      sourceRepo,
      documentType,
      inTrash: page.in_trash === true,
    },
  };
}

export function parseFleetLocksFieldsFromNotionPage(
  page: Record<string, unknown>,
): ParsedFleetLocksFields {
  const empty: ParsedFleetLocksFields = {
    adoptedBySet: false,
    adoptedByPersonIds: [],
    grandfathered: false,
    parseOk: false,
  };
  const props = asRecord(page.properties);
  if (!props) {
    return empty;
  }
  const statusProp = findNotionProperty(props, FLEET_LOCKS_PROPERTY_IDS.status, ["Status"]);
  const adoptedAtProp = findNotionProperty(props, FLEET_LOCKS_PROPERTY_IDS.adoptedAt, [
    "Adopted At",
  ]);
  const adoptedByProp = findNotionProperty(props, FLEET_LOCKS_PROPERTY_IDS.adoptedBy, [
    "Adopted By",
  ]);
  const grandfatheredProp = findNotionProperty(props, FLEET_LOCKS_PROPERTY_IDS.grandfathered, [
    "Grandfathered",
  ]);

  const statusTypeOk = statusProp?.type === "select";
  const adoptedAtTypeOk = adoptedAtProp?.type === "date";
  const adoptedByTypeOk = adoptedByProp?.type === "people";
  const grandfathered = readCheckbox(grandfatheredProp);

  const statusName = statusTypeOk ? readSelectName(statusProp) : undefined;
  const adoptedAt = adoptedAtTypeOk ? readDateStart(adoptedAtProp) : undefined;
  const adoptedByPersonIds = adoptedByTypeOk ? readPeopleIds(adoptedByProp) : [];
  const adoptedBySet = adoptedByTypeOk && adoptedByPersonIds.length > 0;

  const parseOk =
    statusTypeOk &&
    statusName !== undefined &&
    adoptedAtTypeOk &&
    adoptedByTypeOk &&
    grandfathered !== undefined;

  return {
    statusName,
    adoptedAt,
    adoptedBySet,
    adoptedByPersonIds,
    grandfathered: grandfathered === true,
    parseOk,
  };
}
