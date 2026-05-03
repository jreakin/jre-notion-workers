/**
 * validate-client-share-scope: Reads a source document and decides whether it
 * is safe to publish to a client. Read-only — never modifies Notion.
 */
import type { Client } from "@notionhq/client";
import { withNotionRetry } from "../shared/notion-retry.js";
import { decideScope, type SourcePageMeta } from "../shared/client-publish.js";
import type { ClientShareScopeInput, ClientShareScopeOutput } from "../shared/types.js";

export async function readSourcePageMeta(notion: Client, pageId: string): Promise<SourcePageMeta> {
  const page = await withNotionRetry(() => notion.pages.retrieve({ page_id: pageId }), {
    label: "validate-client-share-scope.retrieve",
  });
  const props = (page as { properties?: Record<string, unknown> }).properties ?? {};

  const titleProp = (props["Name"] ?? props["Title"]) as
    | { title?: Array<{ plain_text?: string }> }
    | undefined;
  const title = titleProp?.title?.map((t) => t.plain_text ?? "").join("").trim() ?? "";

  const approved = readCheckbox(props, "Approved for Client") ?? readCheckbox(props, "Approved") ?? false;
  const sensitive =
    readCheckbox(props, "Sensitive") ??
    readCheckbox(props, "Confidential") ??
    readSelectName(props, "Sensitivity") === "Confidential";

  const clientIds = readRelationIds(props, "Client") ?? readRelationIds(props, "Clients") ?? [];
  const projectIds = readRelationIds(props, "Project") ?? readRelationIds(props, "Projects") ?? [];

  const lastEdited = (page as { last_edited_time?: string }).last_edited_time ?? null;

  // Pull blocks once for body text + structural signals.
  let bodyParts: string[] = [];
  let internalMentions = 0;
  let internalLinks = 0;
  let hasEmbedded = false;
  let hasSynced = false;

  try {
    let cursor: string | undefined;
    do {
      const blocks = await withNotionRetry(
        () => notion.blocks.children.list({ block_id: pageId, page_size: 100, start_cursor: cursor }),
        { label: "validate-client-share-scope.blocks" }
      );
      for (const b of blocks.results ?? []) {
        const block = b as {
          type?: string;
          paragraph?: { rich_text?: Array<{ plain_text?: string; type?: string; href?: string | null; mention?: unknown }> };
          heading_1?: { rich_text?: Array<{ plain_text?: string }> };
          heading_2?: { rich_text?: Array<{ plain_text?: string }> };
          heading_3?: { rich_text?: Array<{ plain_text?: string }> };
          bulleted_list_item?: { rich_text?: Array<{ plain_text?: string }> };
          numbered_list_item?: { rich_text?: Array<{ plain_text?: string }> };
        };
        if (block.type === "child_database") hasEmbedded = true;
        if (block.type === "synced_block") hasSynced = true;
        const rich =
          block.paragraph?.rich_text ??
          block.heading_1?.rich_text ??
          block.heading_2?.rich_text ??
          block.heading_3?.rich_text ??
          block.bulleted_list_item?.rich_text ??
          block.numbered_list_item?.rich_text;
        if (rich) {
          for (const r of rich) {
            const t = r.plain_text ?? "";
            bodyParts.push(t);
            if ((r as { type?: string }).type === "mention") internalMentions++;
            const href = (r as { href?: string | null }).href;
            if (href && /notion\.so\//.test(href)) internalLinks++;
          }
          bodyParts.push("\n");
        }
      }
      const blocksWithCursor = blocks as { has_more?: boolean; next_cursor?: string | null };
      cursor = blocksWithCursor.has_more && blocksWithCursor.next_cursor ? blocksWithCursor.next_cursor : undefined;
    } while (cursor);
  } catch (e) {
    console.warn("[validate-client-share-scope] block read partial:", e instanceof Error ? e.message : String(e));
  }

  return {
    page_id: pageId,
    title,
    approved,
    sensitive,
    client_relation_ids: clientIds,
    project_relation_ids: projectIds,
    body_text: bodyParts.join(""),
    internal_mentions: internalMentions,
    has_embedded_databases: hasEmbedded,
    has_synced_blocks: hasSynced,
    internal_link_count: internalLinks,
    last_edited_time: lastEdited,
  };
}

function readCheckbox(props: Record<string, unknown>, key: string): boolean | null {
  const v = props[key];
  if (!v || typeof v !== "object" || !("checkbox" in v)) return null;
  return Boolean((v as { checkbox?: boolean }).checkbox);
}
function readSelectName(props: Record<string, unknown>, key: string): string | null {
  const v = props[key];
  if (!v || typeof v !== "object" || !("select" in v)) return null;
  const s = (v as { select?: { name?: string } | null }).select;
  return s?.name ?? null;
}
function readRelationIds(props: Record<string, unknown>, key: string): string[] | null {
  const v = props[key];
  if (!v || typeof v !== "object" || !("relation" in v)) return null;
  const rel = (v as { relation?: Array<{ id: string }> }).relation ?? [];
  return rel.map((r) => r.id);
}

export async function executeValidateClientShareScope(
  input: ClientShareScopeInput,
  notion: Client
): Promise<ClientShareScopeOutput> {
  if (!input.source_page_id?.trim()) {
    return { success: false, error: "source_page_id is required" };
  }
  try {
    const meta = await readSourcePageMeta(notion, input.source_page_id);
    const scope = decideScope({
      meta,
      strict: input.strict,
      declared_client_ids: input.client_relation_ids,
      declared_project_ids: input.project_relation_ids,
    });

    const summary = `Decision: ${scope.decision} (${scope.issues.filter((i) => i.severity === "FAIL").length} FAIL, ${scope.issues.filter((i) => i.severity === "WARN").length} WARN).`;

    return {
      success: true,
      decision: scope.decision,
      source_page_id: input.source_page_id,
      issues: scope.issues,
      approved: scope.approved,
      sensitive: scope.sensitive,
      missing_portal: scope.missing_portal,
      cross_client: scope.cross_client,
      embedded_databases: meta.has_embedded_databases,
      synced_blocks: meta.has_synced_blocks,
      internal_links: meta.internal_link_count,
      summary,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[validate-client-share-scope] error:", message);
    return { success: false, error: message };
  }
}
