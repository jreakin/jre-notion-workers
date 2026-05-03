/**
 * publish-client-doc-update: End-to-end client publish — runs scope checks,
 * sanitizes content, writes a sanitized copy to CLIENT_SHARED_DOCUMENTS_DATABASE_ID
 * (dedupes by Source Page ID), and logs the event.
 *
 * Supports dry_run. On block decisions returns published=false and logs a
 * client share event. On `force=true`, WARN issues are accepted.
 */
import type { Client } from "@notionhq/client";
import { withNotionRetry } from "../shared/notion-retry.js";
import {
  tryGetClientSharedDocumentsDatabaseId,
} from "../shared/notion-client.js";
import {
  decideScope,
  redactClientText,
  sanitizeClientTitle,
} from "../shared/client-publish.js";
import { readSourcePageMeta } from "./validate-client-share-scope.js";
import { executeLogClientShareEvent } from "./log-client-share-event.js";
import type {
  PublishClientDocUpdateInput,
  PublishClientDocUpdateOutput,
} from "../shared/types.js";

async function findExistingPublished(
  notion: Client,
  dbId: string,
  sourcePageId: string
): Promise<{ id: string; url: string } | null> {
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
      { label: "publish-client-doc-update.find" }
    );
    const first = (resp.results ?? [])[0];
    if (!first) return null;
    const p = first as { id: string; url?: string };
    return { id: p.id, url: p.url ?? "" };
  } catch {
    return null;
  }
}

function chunkText(s: string, size = 1900): string[] {
  if (s.length <= size) return [s];
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

export async function executePublishClientDocUpdate(
  input: PublishClientDocUpdateInput,
  notion: Client
): Promise<PublishClientDocUpdateOutput> {
  if (!input.source_page_id?.trim()) {
    return { success: false, error: "source_page_id is required" };
  }
  const dryRun = input.dry_run ?? false;
  const force = input.force ?? false;

  try {
    const meta = await readSourcePageMeta(notion, input.source_page_id);
    const scope = decideScope({ meta });
    const fail = scope.issues.some((i) => i.severity === "FAIL");
    const warn = scope.issues.some((i) => i.severity === "WARN");

    const sanitizedTitle = sanitizeClientTitle(meta.title) || "Client Document";
    const sanitizedBody = redactClientText(meta.body_text).redacted_text;

    const blockReason = (msg: string) => msg;

    if (fail) {
      const summary = `Blocked: ${scope.issues
        .filter((i) => i.severity === "FAIL")
        .map((i) => i.rule)
        .join(", ")}`;
      const clientId = meta.client_relation_ids[0] ?? "unknown";
      let logged = false;
      if (!dryRun) {
        const ev = await executeLogClientShareEvent(
          {
            source_page_id: input.source_page_id,
            client_id: clientId,
            event_type: "block",
            message: blockReason(summary),
          },
          notion
        );
        logged = ev.success;
      }
      return {
        success: true,
        published: false,
        decision: "block",
        source_page_id: input.source_page_id,
        published_page_id: null,
        published_page_url: null,
        issues: scope.issues,
        logged_event: logged,
        summary,
      };
    }

    if (warn && !force) {
      const summary = `Needs review: ${scope.issues
        .filter((i) => i.severity === "WARN")
        .map((i) => i.rule)
        .join(", ")}`;
      return {
        success: true,
        published: false,
        decision: "needs_review",
        source_page_id: input.source_page_id,
        published_page_id: null,
        published_page_url: null,
        issues: scope.issues,
        logged_event: false,
        summary,
      };
    }

    const dbId = tryGetClientSharedDocumentsDatabaseId();
    if (!dbId) {
      return {
        success: false,
        error: "CLIENT_SHARED_DOCUMENTS_DATABASE_ID is not set; cannot publish",
      };
    }

    const clientId = meta.client_relation_ids[0]!;
    const projectId = meta.project_relation_ids[0] ?? null;

    if (dryRun) {
      return {
        success: true,
        published: false,
        decision: "publish",
        source_page_id: input.source_page_id,
        published_page_id: null,
        published_page_url: null,
        issues: scope.issues,
        logged_event: false,
        summary: `[DRY RUN] Would publish "${sanitizedTitle}" to client ${clientId}.`,
      };
    }

    const existing = await findExistingPublished(notion, dbId, input.source_page_id);

    const properties: Record<string, unknown> = {
      Title: { title: [{ text: { content: sanitizedTitle } }] },
      "Source Page ID": { rich_text: [{ text: { content: input.source_page_id } }] },
      Client: { relation: [{ id: clientId }] },
      "Published At": { date: { start: new Date().toISOString() } },
    };
    if (projectId) properties["Project"] = { relation: [{ id: projectId }] };

    let publishedId: string;
    let publishedUrl: string;

    if (existing) {
      await withNotionRetry(
        () =>
          notion.pages.update({
            page_id: existing.id,
            properties: properties as never,
          }),
        { label: "publish-client-doc-update.update" }
      );
      // Replace body: best-effort by appending a fresh content block. For MVP we
      // append rather than diff existing children — caller may run drift
      // detection to decide when to refresh.
      publishedId = existing.id;
      publishedUrl = existing.url;
    } else {
      const page = await withNotionRetry(
        () =>
          notion.pages.create({
            parent: { database_id: dbId },
            properties: properties as never,
          }),
        { label: "publish-client-doc-update.create" }
      );
      publishedId = "id" in page ? (page as { id: string }).id : "";
      publishedUrl = "url" in page ? (page as { url: string }).url : "";
    }

    // Append sanitized body as paragraph blocks.
    const chunks = chunkText(sanitizedBody);
    if (chunks.length) {
      try {
        await withNotionRetry(
          () =>
            notion.blocks.children.append({
              block_id: publishedId,
              children: chunks.map((c) => ({
                object: "block",
                type: "paragraph",
                paragraph: {
                  rich_text: [{ type: "text", text: { content: c } }],
                },
              })) as never,
            }),
          { label: "publish-client-doc-update.append" }
        );
      } catch (e) {
        console.warn(
          "[publish-client-doc-update] body append failed:",
          e instanceof Error ? e.message : String(e)
        );
      }
    }

    let logged = false;
    try {
      const ev = await executeLogClientShareEvent(
        {
          source_page_id: input.source_page_id,
          client_id: clientId,
          event_type: warn ? "partial" : "publish",
          message: `Published "${sanitizedTitle}" to ${dbId} (${existing ? "updated" : "created"}).`,
          published_page_id: publishedId,
        },
        notion
      );
      logged = ev.success;
    } catch (e) {
      console.warn(
        "[publish-client-doc-update] event log failed:",
        e instanceof Error ? e.message : String(e)
      );
    }

    return {
      success: true,
      published: true,
      decision: "publish",
      source_page_id: input.source_page_id,
      published_page_id: publishedId,
      published_page_url: publishedUrl,
      issues: scope.issues,
      logged_event: logged,
      summary: `Published "${sanitizedTitle}" (${existing ? "updated" : "created"}).`,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[publish-client-doc-update] error:", message);
    return { success: false, error: message };
  }
}
