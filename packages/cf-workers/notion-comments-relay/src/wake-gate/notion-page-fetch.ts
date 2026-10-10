import { AD_DOCS_DATA_SOURCE_ID } from "./wake-gate-types.js";

export const NOTION_VERSION_LEGACY = "2022-06-28";
export const NOTION_VERSION_PAGE = "2025-09-03";

const NOTION_FETCH_MS = 3_000;

export interface PageParentIds {
  dataSourceId: string | null;
  databaseId: string | null;
}

export interface AdDocsMembershipEnv {
  AD_DOCS_DATABASE_ID?: string;
}

export interface AdDocsMembership {
  isAdDocs: boolean;
  dataSourceId: string | null;
  databaseId: string | null;
  matchedVia: "data_source_id" | "database_id" | null;
}

export function readPageParentIds(page: Record<string, unknown>): PageParentIds {
  const parent = page.parent;
  if (!parent || typeof parent !== "object") {
    return { dataSourceId: null, databaseId: null };
  }
  const rec = parent as Record<string, unknown>;
  const dataSourceId =
    typeof rec.data_source_id === "string" && rec.data_source_id.length > 0
      ? rec.data_source_id
      : null;
  const databaseId =
    typeof rec.database_id === "string" && rec.database_id.length > 0
      ? rec.database_id
      : null;
  return { dataSourceId, databaseId };
}

export function pageBelongsToAdDocs(
  page: Record<string, unknown>,
  env: AdDocsMembershipEnv,
): AdDocsMembership {
  const { dataSourceId, databaseId } = readPageParentIds(page);
  if (dataSourceId === AD_DOCS_DATA_SOURCE_ID) {
    return {
      isAdDocs: true,
      dataSourceId,
      databaseId,
      matchedVia: "data_source_id",
    };
  }
  const configuredDb = env.AD_DOCS_DATABASE_ID?.trim();
  if (configuredDb && databaseId === configuredDb) {
    return {
      isAdDocs: true,
      dataSourceId: AD_DOCS_DATA_SOURCE_ID,
      databaseId,
      matchedVia: "database_id",
    };
  }
  return {
    isAdDocs: false,
    dataSourceId,
    databaseId,
    matchedVia: null,
  };
}

/** @deprecated Use readPageParentIds + pageBelongsToAdDocs */
export function readDataSourceFromPageParent(page: Record<string, unknown>): string | null {
  const { dataSourceId, databaseId } = readPageParentIds(page);
  return dataSourceId ?? databaseId;
}

export async function fetchNotionPage(
  token: string,
  pageId: string,
  notionVersion: string = NOTION_VERSION_PAGE,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NOTION_FETCH_MS);
  const encodedId = encodeURIComponent(pageId);
  try {
    const res = await fetch(`https://api.notion.com/v1/pages/${encodedId}`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
        "notion-version": notionVersion,
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`notion_http_${res.status}`);
    }
    const json = (await res.json()) as Record<string, unknown>;
    return json;
  } finally {
    clearTimeout(timer);
  }
}
