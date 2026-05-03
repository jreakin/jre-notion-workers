/**
 * audit-client-portal-access: Reports per-client publish footprint and flags
 * clients that have shared documents but no portal configured.
 */
import type { Client } from "@notionhq/client";
import { withNotionRetry } from "../shared/notion-retry.js";
import {
  getClientsDatabaseId,
  tryGetClientSharedDocumentsDatabaseId,
} from "../shared/notion-client.js";
import type {
  AuditClientPortalAccessInput,
  AuditClientPortalAccessOutput,
  ClientPortalAuditEntry,
} from "../shared/types.js";

function readTitle(props: Record<string, unknown> | undefined, key = "Name"): string {
  const v = props?.[key];
  if (!v || typeof v !== "object" || !("title" in v)) return "";
  const arr = (v as { title?: Array<{ plain_text?: string }> }).title ?? [];
  return arr.map((t) => t.plain_text ?? "").join("");
}
function readCheckbox(props: Record<string, unknown> | undefined, key: string): boolean {
  const v = props?.[key];
  if (!v || typeof v !== "object" || !("checkbox" in v)) return false;
  return Boolean((v as { checkbox?: boolean }).checkbox);
}

async function countDocsForClient(
  notion: Client,
  dbId: string,
  clientId: string
): Promise<number> {
  let total = 0;
  let cursor: string | undefined;
  do {
    const resp = await withNotionRetry(
      () =>
        notion.databases.query({
          database_id: dbId,
          page_size: 100,
          start_cursor: cursor,
          filter: {
            property: "Client",
            relation: { contains: clientId },
          } as never,
        }),
      { label: "audit-client-portal-access.query" }
    );
    total += (resp.results ?? []).length;
    const r = resp as { has_more?: boolean; next_cursor?: string | null };
    cursor = r.has_more && r.next_cursor ? r.next_cursor : undefined;
  } while (cursor);
  return total;
}

export async function executeAuditClientPortalAccess(
  input: AuditClientPortalAccessInput,
  notion: Client
): Promise<AuditClientPortalAccessOutput> {
  let clientsDb: string;
  try {
    clientsDb = getClientsDatabaseId();
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
  const sharedDb = tryGetClientSharedDocumentsDatabaseId();

  try {
    const filter = input.client_id
      ? ({ property: "Page", relation: { is_not_empty: true } } as never)
      : undefined;
    const entries: ClientPortalAuditEntry[] = [];

    let cursor: string | undefined;
    do {
      const resp = await withNotionRetry(
        () =>
          notion.databases.query({
            database_id: clientsDb,
            page_size: 100,
            start_cursor: cursor,
            filter: filter ?? undefined,
          }),
        { label: "audit-client-portal-access.clients" }
      );
      for (const p of resp.results ?? []) {
        const page = p as { id: string; properties?: Record<string, unknown> };
        if (input.client_id && page.id !== input.client_id) continue;
        const name = readTitle(page.properties);
        const hasPortal = readCheckbox(page.properties, "Has Portal");
        const docs = sharedDb ? await countDocsForClient(notion, sharedDb, page.id) : 0;
        const notes: string[] = [];
        if (docs > 0 && !hasPortal) notes.push("documents_published_without_portal");
        if (!sharedDb) notes.push("client_shared_db_not_configured");
        entries.push({
          client_id: page.id,
          client_name: name,
          documents: docs,
          has_portal: hasPortal,
          notes,
        });
      }
      const r = resp as { has_more?: boolean; next_cursor?: string | null };
      cursor = r.has_more && r.next_cursor ? r.next_cursor : undefined;
    } while (cursor);

    const flagged = entries.filter((e) => e.notes.length > 0).length;
    const summary = `Audited ${entries.length} client(s); ${flagged} need attention.`;

    return { success: true, total_clients: entries.length, entries, summary };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[audit-client-portal-access] error:", message);
    return { success: false, error: message };
  }
}
