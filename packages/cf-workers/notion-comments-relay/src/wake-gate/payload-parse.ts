import type { ParsedWakePayload } from "./wake-gate-types.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readAuthors(parsed: Record<string, unknown>): string[] {
  const authors = parsed.authors;
  if (!Array.isArray(authors)) {
    return [];
  }
  const ids: string[] = [];
  for (const a of authors) {
    const rec = asRecord(a);
    const id = rec ? readString(rec.id) : null;
    if (id) ids.push(id);
  }
  return ids;
}

function readUpdatedProperties(data: Record<string, unknown>): { ids: string[]; known: boolean } {
  if (!("updated_properties" in data)) {
    return { ids: [], known: false };
  }
  const raw = data.updated_properties;
  if (!Array.isArray(raw)) {
    return { ids: [], known: true };
  }
  const ids: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.length > 0) ids.push(item);
  }
  return { ids, known: true };
}

function readParentDataSourceId(parent: Record<string, unknown> | null): string | null {
  if (!parent) return null;
  const direct = readString(parent.data_source_id);
  if (direct) return direct;
  const databaseId = readString(parent.database_id);
  if (databaseId) return databaseId;
  const nested = asRecord(parent.parent);
  if (!nested) return null;
  return readString(nested.data_source_id) ?? readString(nested.database_id);
}

function pageIdFromParent(parent: Record<string, unknown> | null): string | null {
  if (!parent) return null;
  const parentType = readString(parent.type);
  if (parentType === "page") {
    return readString(parent.id);
  }
  return (
    readString(parent.page_id) ??
    readString(parent.pageId) ??
    (parentType === "page_id" ? readString(parent.id) : null)
  );
}

export function titleFromNotionUrlSlug(url: string): string | null {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    if (!last) return null;
    const withoutId = last.replace(/-[0-9a-f]{32}$/i, "");
    if (!withoutId) return null;
    return decodeURIComponent(withoutId.replace(/-/g, " "));
  } catch {
    return null;
  }
}

export function parseWebhookForWakeGate(parsed: Record<string, unknown>): ParsedWakePayload {
  if (!parsed || typeof parsed !== "object") {
    return {
      pageId: null,
      dataSourceId: null,
      inTrash: null,
      titleFromAutomation: null,
      updatedPropertyIds: [],
      authorUserIds: [],
      notionEventType: null,
      isAutomationPageObject: false,
      isCommentEvent: false,
      updatedPropertiesKnown: false,
    };
  }
  const notionEventType =
    readString(parsed.type) ?? readString(parsed.event_name) ?? readString(parsed.event);
  const isCommentEvent = notionEventType !== null && notionEventType.startsWith("comment.");
  const data = asRecord(parsed.data);
  const authors = readAuthors(parsed);

  if (data && readString(data.object) === "page") {
    const pageId = readString(parsed.id) ?? readString(data.id);
    const parent = asRecord(data.parent);
    const dataSourceId = parent ? readParentDataSourceId(parent) : null;
    const inTrash = typeof data.in_trash === "boolean" ? data.in_trash : null;
    const url = readString(data.url) ?? readString(parsed.url);
    const titleFromAutomation = url ? titleFromNotionUrlSlug(url) : null;
    return {
      pageId,
      dataSourceId,
      inTrash,
      titleFromAutomation,
      updatedPropertyIds: [],
      authorUserIds: authors,
      notionEventType,
      isAutomationPageObject: true,
      isCommentEvent,
      updatedPropertiesKnown: true,
    };
  }

  const entity = asRecord(parsed.entity);
  const entityId = entity ? readString(entity.id) : null;
  const entityType = entity ? readString(entity.type) : null;

  let pageId: string | null = null;
  if (entityType === "page" && entityId) {
    pageId = entityId;
  } else if (entityType === "comment" && data) {
    pageId = readString(data.page_id) ?? pageIdFromParent(asRecord(data.parent));
  } else if (data) {
    pageId = readString(data.page_id) ?? pageIdFromParent(asRecord(data.parent));
  }

  const updated = data ? readUpdatedProperties(data) : { ids: [], known: false };
  const dataSourceId = data ? readParentDataSourceId(asRecord(data.parent)) : null;

  return {
    pageId,
    dataSourceId,
    inTrash: null,
    titleFromAutomation: null,
    updatedPropertyIds: updated.ids,
    authorUserIds: authors,
    notionEventType,
    isAutomationPageObject: false,
    isCommentEvent,
    updatedPropertiesKnown: updated.known,
  };
}
