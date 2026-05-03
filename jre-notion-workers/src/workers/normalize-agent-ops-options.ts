/**
 * normalize-agent-ops-options: Migrates lowercase / stale Run Status values in
 * the Agent Ops database to canonical Notion select values.
 *
 * Read-only by default (dry_run=true). Pass dry_run=false to actually update.
 */
import type { Client } from "@notionhq/client";
import { getAgentOpsDatabaseId } from "../shared/notion-client.js";
import { withNotionRetry } from "../shared/notion-retry.js";
import { isCanonicalRunStatus, normalizeStoredStatus } from "../shared/agent-ops-status.js";
import type {
  NormalizeAgentOpsOptionsInput,
  NormalizeAgentOpsOptionsOutput,
  NormalizedRow,
} from "../shared/types.js";

function readSelect(props: Record<string, unknown> | undefined, key: string): string | null {
  const v = props?.[key];
  if (!v || typeof v !== "object") return null;
  const sel = (v as { select?: { name?: string } | null }).select;
  return sel?.name ?? null;
}

function readTitle(props: Record<string, unknown> | undefined, key = "Title"): string {
  const v = props?.[key];
  if (!v || typeof v !== "object" || !("title" in v)) return "";
  const arr = (v as { title?: Array<{ plain_text?: string }> }).title ?? [];
  return arr.map((t) => t.plain_text ?? "").join("");
}

export async function executeNormalizeAgentOpsOptions(
  input: NormalizeAgentOpsOptionsInput,
  notion: Client
): Promise<NormalizeAgentOpsOptionsOutput> {
  const dryRun = input.dry_run ?? true;
  const maxPages = input.max_pages ?? 500;
  const statusProperty = input.status_property ?? "Run Status";

  let dbId: string;
  try {
    dbId = getAgentOpsDatabaseId();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { success: false, error: message };
  }

  const rows: NormalizedRow[] = [];
  let cursor: string | undefined;
  let scanned = 0;

  try {
    do {
      const resp = await withNotionRetry(
        () =>
          notion.databases.query({
            database_id: dbId,
            page_size: 100,
            start_cursor: cursor,
          }),
        { label: "normalize-agent-ops-options.query" }
      );

      for (const p of resp.results) {
        if (scanned >= maxPages) break;
        scanned++;
        const page = p as {
          id: string;
          url?: string;
          properties?: Record<string, unknown>;
        };
        const before = readSelect(page.properties, statusProperty);
        const agentName = readSelect(page.properties, "Agent Name") ?? readTitle(page.properties);
        const url = page.url ?? "";

        if (before && isCanonicalRunStatus(before)) {
          rows.push({
            page_id: page.id,
            page_url: url,
            agent_name: agentName,
            before,
            after: before,
            action: "skipped",
            reason: "already canonical",
          });
          continue;
        }

        const normalized = normalizeStoredStatus(before);
        if (!normalized) {
          rows.push({
            page_id: page.id,
            page_url: url,
            agent_name: agentName,
            before,
            after: null,
            action: "needs_review",
            reason: before ? `cannot map "${before}"` : "missing status",
          });
          continue;
        }

        if (dryRun) {
          rows.push({
            page_id: page.id,
            page_url: url,
            agent_name: agentName,
            before,
            after: normalized,
            action: "normalized",
            reason: "[dry-run]",
          });
          continue;
        }

        try {
          await withNotionRetry(
            () =>
              notion.pages.update({
                page_id: page.id,
                properties: {
                  [statusProperty]: { select: { name: normalized } },
                } as never,
              }),
            { label: "normalize-agent-ops-options.update" }
          );
          rows.push({
            page_id: page.id,
            page_url: url,
            agent_name: agentName,
            before,
            after: normalized,
            action: "normalized",
            reason: null,
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          rows.push({
            page_id: page.id,
            page_url: url,
            agent_name: agentName,
            before,
            after: normalized,
            action: "error",
            reason: message,
          });
        }
      }

      const r = resp as { has_more?: boolean; next_cursor?: string | null };
      cursor = r.has_more && r.next_cursor ? r.next_cursor : undefined;
    } while (cursor && scanned < maxPages);

    const totalNormalized = rows.filter((r) => r.action === "normalized").length;
    const totalNeedsReview = rows.filter((r) => r.action === "needs_review").length;
    const totalSkipped = rows.filter((r) => r.action === "skipped").length;
    const totalErrors = rows.filter((r) => r.action === "error").length;
    const summary = dryRun
      ? `[DRY RUN] Scanned ${scanned} rows: ${totalNormalized} would be normalized, ${totalSkipped} already canonical, ${totalNeedsReview} need review.`
      : `Scanned ${scanned} rows: ${totalNormalized} normalized, ${totalSkipped} already canonical, ${totalNeedsReview} need review, ${totalErrors} errors.`;

    return {
      success: true,
      total_scanned: scanned,
      total_normalized: totalNormalized,
      total_needs_review: totalNeedsReview,
      total_skipped: totalSkipped,
      total_errors: totalErrors,
      rows,
      summary,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[normalize-agent-ops-options] error:", message);
    return { success: false, error: message };
  }
}
