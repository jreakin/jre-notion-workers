import { AD_DOCS_DATA_SOURCE_ID } from "./wake-gate-types.js";

export const NOTION_VERSION_LEGACY = "2022-06-28";
export const NOTION_VERSION_PAGE = "2025-09-03";

export const NOTION_FETCH_MS = 3_000;

export type PageFetchResult = { ms: number; outcome: string; cached: boolean };
export type PageFetchOpts = {
  /** Abort after this many ms (default NOTION_FETCH_MS). */
  timeoutMs?: number;
  /**
   * Per-request memo scope (GateEventContext.fetchScope). Callers that pass the same scope share ONE fetch of
   * the page for that request (prefilter + shadow gates). No scope = no memo (always fetch).
   */
  scope?: string;
  /** Short caller label for the latency log line. */
  caller?: string;
  /** Log a `notion_page_fetch` latency line (forward-path callers). */
  logLatency?: boolean;
  onResult?: (r: PageFetchResult) => void;
};

const MEMO_TTL_MS = 60_000;
const MEMO_MAX = 500;
type MemoEntry = { promise: Promise<Record<string, unknown>>; timeoutMs: number; ts: number };
const pageMemo = new Map<string, MemoEntry>();

export function resetPageFetchMemo(): void {
  pageMemo.clear();
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function fetchOutcomeLabel(err: unknown): string {
  if (isAbort(err)) return "timeout";
  if (err instanceof Error && err.message.startsWith("notion_http_")) return err.message.slice("notion_".length);
  return "error";
}

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
  opts: PageFetchOpts = {},
): Promise<Record<string, unknown>> {
  const timeoutMs = opts.timeoutMs ?? NOTION_FETCH_MS;
  if (!opts.scope) return timedFetch(token, pageId, notionVersion, timeoutMs, opts);
  const key = `${opts.scope}|${notionVersion}|${pageId}`;
  const now = Date.now();
  const hit = pageMemo.get(key);
  if (hit && now - hit.ts < MEMO_TTL_MS) {
    const started = Date.now();
    try {
      const page = await hit.promise;
      opts.onResult?.({ ms: Date.now() - started, outcome: "ok", cached: true });
      return page;
    } catch (err) {
      // A shorter-budget caller timed out: a caller with a longer budget fetches again.
      if (!(isAbort(err) && hit.timeoutMs < timeoutMs)) {
        opts.onResult?.({ ms: Date.now() - started, outcome: fetchOutcomeLabel(err), cached: true });
        throw err;
      }
    }
  }
  if (pageMemo.size >= MEMO_MAX) {
    for (const [k, v] of pageMemo) if (now - v.ts >= MEMO_TTL_MS) pageMemo.delete(k);
    if (pageMemo.size >= MEMO_MAX) pageMemo.clear();
  }
  const promise = timedFetch(token, pageId, notionVersion, timeoutMs, opts);
  pageMemo.set(key, { promise, timeoutMs, ts: now });
  promise.catch(() => {}); // the memo itself never surfaces an unhandled rejection
  return promise;
}

async function timedFetch(
  token: string,
  pageId: string,
  notionVersion: string,
  timeoutMs: number,
  opts: PageFetchOpts,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const encodedId = encodeURIComponent(pageId);
  const started = Date.now();
  let outcome = "ok";
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
  } catch (err) {
    outcome = fetchOutcomeLabel(err);
    throw err;
  } finally {
    clearTimeout(timer);
    const ms = Date.now() - started;
    // Latency log for fetches on the forward path (before the 200): no page id, no token.
    if (opts.logLatency) {
      console.log(
        JSON.stringify({ event: "notion_page_fetch", caller: opts.caller ?? "unknown", ms, timeout_ms: timeoutMs, outcome }),
      );
    }
    opts.onResult?.({ ms, outcome, cached: false });
  }
}
