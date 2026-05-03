/**
 * prepare-client-doc-update: Reads a source page, validates scope, and
 * produces a sanitized title + body that can be safely written to a client
 * portal. Read-only — never modifies Notion.
 */
import type { Client } from "@notionhq/client";
import { decideScope, redactClientText, sanitizeClientTitle } from "../shared/client-publish.js";
import { readSourcePageMeta } from "./validate-client-share-scope.js";
import type {
  PrepareClientDocUpdateInput,
  PrepareClientDocUpdateOutput,
} from "../shared/types.js";

export async function executePrepareClientDocUpdate(
  input: PrepareClientDocUpdateInput,
  notion: Client
): Promise<PrepareClientDocUpdateOutput> {
  if (!input.source_page_id?.trim()) {
    return { success: false, error: "source_page_id is required" };
  }
  try {
    const meta = await readSourcePageMeta(notion, input.source_page_id);
    const scope = decideScope({
      meta,
      strict: input.strict,
      declared_client_ids: input.client_id ? [input.client_id] : undefined,
      declared_project_ids: input.project_id ? [input.project_id] : undefined,
    });

    const sanitizedTitle = sanitizeClientTitle(meta.title);
    const redaction = redactClientText(meta.body_text);

    const summary = `Decision: ${scope.decision}; sanitized ${redaction.redactions.length} item(s).`;

    return {
      success: true,
      decision: scope.decision,
      source_page_id: input.source_page_id,
      sanitized_title: sanitizedTitle,
      sanitized_text: redaction.redacted_text,
      issues: scope.issues,
      summary,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[prepare-client-doc-update] error:", message);
    return { success: false, error: message };
  }
}
