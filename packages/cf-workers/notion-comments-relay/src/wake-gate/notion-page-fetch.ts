export const NOTION_VERSION_LEGACY = "2022-06-28";
export const NOTION_VERSION_PAGE = "2025-09-03";

const NOTION_FETCH_MS = 3_000;

export function readDataSourceFromPageParent(page: Record<string, unknown>): string | null {
  const parent = page.parent;
  if (!parent || typeof parent !== "object") return null;
  const rec = parent as Record<string, unknown>;
  const ds = rec.data_source_id;
  if (typeof ds === "string" && ds.length > 0) return ds;
  const db = rec.database_id;
  if (typeof db === "string" && db.length > 0) return db;
  return null;
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
