const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

export function normalizeNotionUuid(id: string): string {
  try {
    return decodeURIComponent(id).trim().replace(/-/g, "").toLowerCase();
  } catch {
    return id.trim().replace(/-/g, "").toLowerCase();
  }
}

export function notionIdsEqual(a: string, b: string): boolean {
  return normalizeNotionUuid(a) === normalizeNotionUuid(b);
}

export function isValidNotionPageId(pageId: string): boolean {
  const trimmed = pageId.trim();
  if (!trimmed) {
    return false;
  }
  const bare = trimmed.replace(/-/g, "");
  if (UUID_RE.test(trimmed) || UUID_RE.test(bare)) {
    return true;
  }
  return /^[0-9a-f]{32}$/i.test(bare);
}

export function encodeNotionPageIdForUrl(pageId: string): string {
  const trimmed = pageId.trim();
  if (!isValidNotionPageId(trimmed)) {
    throw new Error("invalid_notion_page_id");
  }
  return encodeURIComponent(trimmed);
}

export type PageParentIds = {
  dataSourceId?: string;
  databaseId?: string;
};

export function readPageParentIds(page: Record<string, unknown>): PageParentIds {
  const parent = page.parent;
  if (!parent || typeof parent !== "object") {
    return {};
  }
  const p = parent as Record<string, unknown>;
  const out: PageParentIds = {};
  if (typeof p.data_source_id === "string" && p.data_source_id.length > 0) {
    out.dataSourceId = p.data_source_id;
  }
  if (typeof p.database_id === "string" && p.database_id.length > 0) {
    out.databaseId = p.database_id;
  }
  return out;
}

export function readWebhookParentFromBlock(parentBlock: Record<string, unknown>): PageParentIds {
  const out: PageParentIds = {};
  if (typeof parentBlock.data_source_id === "string" && parentBlock.data_source_id.length > 0) {
    out.dataSourceId = parentBlock.data_source_id;
  }
  if (typeof parentBlock.database_id === "string" && parentBlock.database_id.length > 0) {
    out.databaseId = parentBlock.database_id;
  }
  const pType = parentBlock.type;
  if (typeof parentBlock.id === "string" && parentBlock.id.length > 0) {
    if (pType === "database_id" || pType === "database") {
      out.databaseId = out.databaseId ?? parentBlock.id;
    }
    if (pType === "data_source_id") {
      out.dataSourceId = out.dataSourceId ?? parentBlock.id;
    }
  }
  return out;
}

export function isFleetLocksParent(
  parent: PageParentIds,
  fleetDataSourceId?: string,
  fleetDatabaseId?: string,
): boolean {
  const ds = fleetDataSourceId?.trim();
  const db = fleetDatabaseId?.trim();
  if (parent.dataSourceId && ds && notionIdsEqual(parent.dataSourceId, ds)) {
    return true;
  }
  if (parent.databaseId && db && notionIdsEqual(parent.databaseId, db)) {
    return true;
  }
  return false;
}

export function webhookParentIsFleetLocks(
  webhookParent: PageParentIds | undefined,
  fleetDataSourceId?: string,
  fleetDatabaseId?: string,
): boolean | undefined {
  if (!webhookParent?.dataSourceId && !webhookParent?.databaseId) {
    return undefined;
  }
  const ds = fleetDataSourceId?.trim();
  const db = fleetDatabaseId?.trim();
  let sawMatch = false;
  let sawMismatch = false;

  if (webhookParent.dataSourceId) {
    if (ds) {
      if (notionIdsEqual(webhookParent.dataSourceId, ds)) {
        sawMatch = true;
      } else {
        sawMismatch = true;
      }
    }
  }
  if (webhookParent.databaseId) {
    if (db) {
      if (notionIdsEqual(webhookParent.databaseId, db)) {
        sawMatch = true;
      } else {
        sawMismatch = true;
      }
    }
  }

  if (sawMatch) {
    return true;
  }
  if (sawMismatch) {
    return false;
  }
  return undefined;
}
