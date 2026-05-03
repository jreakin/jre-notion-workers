/**
 * detect-client-doc-drift: Detects whether a published client copy is out of
 * sync with the (sanitized) source page.
 */
import type { Client } from "@notionhq/client";
import {
  detectDrift,
  redactClientText,
  sanitizeClientTitle,
} from "../shared/client-publish.js";
import { withNotionRetry } from "../shared/notion-retry.js";
import { readSourcePageMeta } from "./validate-client-share-scope.js";
import { tryGetClientSharedDocumentsDatabaseId } from "../shared/notion-client.js";
import type {
  DetectClientDocDriftInput,
  DetectClientDocDriftOutput,
} from "../shared/types.js";

interface PublishedSnapshot {
  page_id: string;
  title: string | null;
  body: string | null;
  last_edited_time: string | null;
}

async function findPublishedCopy(
  notion: Client,
  publishedPageId: string | undefined,
  sourcePageId: string
): Promise<PublishedSnapshot | null> {
  if (publishedPageId) {
    return readPublishedSnapshot(notion, publishedPageId);
  }
  const dbId = tryGetClientSharedDocumentsDatabaseId();
  if (!dbId) return null;
  // Convention: published rows carry a "Source Page" url property pointing to the source.
  try {
    const resp = await withNotionRetry(
      () =>
        notion.databases.query({
          database_id: dbId,
          page_size: 1,
          filter: {
            property: "Source Page ID",
            rich_text: { equals: sourcePageId },
          } as never,
        }),
      { label: "detect-client-doc-drift.query" }
    );
    const first = (resp.results ?? [])[0];
    if (!first) return null;
    return readPublishedSnapshot(notion, (first as { id: string }).id);
  } catch {
    return null;
  }
}

async function readPublishedSnapshot(notion: Client, pageId: string): Promise<PublishedSnapshot> {
  const page = await withNotionRetry(() => notion.pages.retrieve({ page_id: pageId }), {
    label: "detect-client-doc-drift.retrieve",
  });
  const props = (page as { properties?: Record<string, unknown> }).properties ?? {};
  const titleProp = (props["Name"] ?? props["Title"]) as
    | { title?: Array<{ plain_text?: string }> }
    | undefined;
  const title = titleProp?.title?.map((t) => t.plain_text ?? "").join("") ?? null;
  const lastEdited = (page as { last_edited_time?: string }).last_edited_time ?? null;

  let body = "";
  try {
    const blocks = await withNotionRetry(
      () => notion.blocks.children.list({ block_id: pageId, page_size: 100 }),
      { label: "detect-client-doc-drift.blocks" }
    );
    for (const b of blocks.results ?? []) {
      const block = b as {
        paragraph?: { rich_text?: Array<{ plain_text?: string }> };
        heading_1?: { rich_text?: Array<{ plain_text?: string }> };
        heading_2?: { rich_text?: Array<{ plain_text?: string }> };
        heading_3?: { rich_text?: Array<{ plain_text?: string }> };
        bulleted_list_item?: { rich_text?: Array<{ plain_text?: string }> };
        numbered_list_item?: { rich_text?: Array<{ plain_text?: string }> };
      };
      const rich =
        block.paragraph?.rich_text ??
        block.heading_1?.rich_text ??
        block.heading_2?.rich_text ??
        block.heading_3?.rich_text ??
        block.bulleted_list_item?.rich_text ??
        block.numbered_list_item?.rich_text;
      if (rich) {
        body += rich.map((r) => r.plain_text ?? "").join("");
        body += "\n";
      }
    }
  } catch {
    /* best-effort */
  }
  return { page_id: pageId, title, body, last_edited_time: lastEdited };
}

export async function executeDetectClientDocDrift(
  input: DetectClientDocDriftInput,
  notion: Client
): Promise<DetectClientDocDriftOutput> {
  if (!input.source_page_id?.trim()) {
    return { success: false, error: "source_page_id is required" };
  }
  try {
    const meta = await readSourcePageMeta(notion, input.source_page_id);
    const sanitizedTitle = sanitizeClientTitle(meta.title);
    const sanitizedBody = redactClientText(meta.body_text).redacted_text;
    const published = await findPublishedCopy(notion, input.published_page_id, input.source_page_id);

    const drift = detectDrift({
      source_title: sanitizedTitle,
      source_body_redacted: sanitizedBody,
      source_last_edited: meta.last_edited_time,
      published_title: published?.title ?? null,
      published_body: published?.body ?? null,
      published_last_edited: published?.last_edited_time ?? null,
    });

    const summary = published
      ? drift.drift_detected
        ? `Drift detected (${drift.reasons.join(", ")}).`
        : "Source and published copy are in sync."
      : "No published copy found.";

    return {
      success: true,
      source_page_id: input.source_page_id,
      published_page_id: published?.page_id ?? null,
      has_published_copy: Boolean(published),
      drift_detected: drift.drift_detected,
      reasons: drift.reasons,
      summary,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[detect-client-doc-drift] error:", message);
    return { success: false, error: message };
  }
}
