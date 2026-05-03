/**
 * revoke-client-access: Marks all client-shared documents for a given client
 * as revoked (sets a "Revoked" checkbox / archives them). MVP: archives the
 * Notion pages so they no longer appear on the client portal.
 */
import type { Client } from "@notionhq/client";
import { withNotionRetry } from "../shared/notion-retry.js";
import { tryGetClientSharedDocumentsDatabaseId } from "../shared/notion-client.js";
import { executeLogClientShareEvent } from "./log-client-share-event.js";
import type {
  RevokeClientAccessInput,
  RevokeClientAccessOutput,
} from "../shared/types.js";

export async function executeRevokeClientAccess(
  input: RevokeClientAccessInput,
  notion: Client
): Promise<RevokeClientAccessOutput> {
  if (!input.client_id?.trim()) return { success: false, error: "client_id is required" };
  if (!input.reason?.trim()) return { success: false, error: "reason is required" };

  const dbId = tryGetClientSharedDocumentsDatabaseId();
  if (!dbId) {
    return { success: false, error: "CLIENT_SHARED_DOCUMENTS_DATABASE_ID is not set" };
  }

  const dryRun = input.dry_run ?? true;
  let revoked = 0;

  try {
    let cursor: string | undefined;
    do {
      const resp = await withNotionRetry(
        () =>
          notion.databases.query({
            database_id: dbId,
            page_size: 50,
            start_cursor: cursor,
            filter: {
              property: "Client",
              relation: { contains: input.client_id },
            } as never,
          }),
        { label: "revoke-client-access.query" }
      );
      for (const p of resp.results ?? []) {
        const page = p as { id: string };
        if (dryRun) {
          revoked++;
          continue;
        }
        try {
          await withNotionRetry(
            () =>
              notion.pages.update({
                page_id: page.id,
                archived: true as never,
              } as never),
            { label: "revoke-client-access.archive" }
          );
          revoked++;
        } catch (e) {
          console.warn(
            "[revoke-client-access] archive failed:",
            page.id,
            e instanceof Error ? e.message : String(e)
          );
        }
      }
      const r = resp as { has_more?: boolean; next_cursor?: string | null };
      cursor = r.has_more && r.next_cursor ? r.next_cursor : undefined;
    } while (cursor);

    if (!dryRun) {
      await executeLogClientShareEvent(
        {
          source_page_id: "(bulk)",
          client_id: input.client_id,
          event_type: "revoke",
          message: `Revoked ${revoked} document(s): ${input.reason}`,
        },
        notion
      );
    }

    return {
      success: true,
      client_id: input.client_id,
      revoked_documents: revoked,
      summary: dryRun
        ? `[DRY RUN] Would revoke ${revoked} document(s) for client ${input.client_id}.`
        : `Revoked ${revoked} document(s) for client ${input.client_id}.`,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[revoke-client-access] error:", message);
    return { success: false, error: message };
  }
}
