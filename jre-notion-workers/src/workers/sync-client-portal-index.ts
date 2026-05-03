/**
 * sync-client-portal-index: Reports the current published documents for a
 * given client. MVP: read-only count + summary. Real "portal page" indexing
 * is left as a TODO since portal layout depends on workspace conventions.
 */
import type { Client } from "@notionhq/client";
import { withNotionRetry } from "../shared/notion-retry.js";
import { tryGetClientSharedDocumentsDatabaseId } from "../shared/notion-client.js";
import type {
  SyncClientPortalIndexInput,
  SyncClientPortalIndexOutput,
} from "../shared/types.js";

export async function executeSyncClientPortalIndex(
  input: SyncClientPortalIndexInput,
  notion: Client
): Promise<SyncClientPortalIndexOutput> {
  if (!input.client_id?.trim()) {
    return { success: false, error: "client_id is required" };
  }
  const dbId = tryGetClientSharedDocumentsDatabaseId();
  if (!dbId) {
    return {
      success: false,
      error: "CLIENT_SHARED_DOCUMENTS_DATABASE_ID is not set",
    };
  }
  try {
    let cursor: string | undefined;
    let total = 0;
    do {
      const resp = await withNotionRetry(
        () =>
          notion.databases.query({
            database_id: dbId,
            page_size: 100,
            start_cursor: cursor,
            filter: {
              property: "Client",
              relation: { contains: input.client_id },
            } as never,
          }),
        { label: "sync-client-portal-index.query" }
      );
      total += (resp.results ?? []).length;
      const r = resp as { has_more?: boolean; next_cursor?: string | null };
      cursor = r.has_more && r.next_cursor ? r.next_cursor : undefined;
    } while (cursor);

    return {
      success: true,
      client_id: input.client_id,
      total_documents: total,
      summary: `${total} client-shared document(s) currently published for client ${input.client_id}.`,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[sync-client-portal-index] error:", message);
    return { success: false, error: message };
  }
}
