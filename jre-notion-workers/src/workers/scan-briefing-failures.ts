/**
 * scan-briefing-failures: Reads today's Morning Briefing digest and extracts structured failure signals.
 * Used by Dead Letter Logger agent to detect missing/failed/partial runs.
 */
import type { Client } from "@notionhq/client";
import { getDocsDatabaseId } from "../shared/notion-client.js";
import type {
  ScanBriefingFailuresInput,
  ScanBriefingFailuresOutput,
  BriefingFailure,
  FailureType,
} from "../shared/types.js";

/**
 * Parse a line from the Morning Briefing Agent Run Summary to determine failure type.
 * Returns null if the line does not indicate a failure.
 */
export function parseFailureLine(line: string): { agent_name: string; failure_type: FailureType } | null {
  const trimmed = line.trim();

  // Pattern: "⚠️ [Agent Name] — no digest found"
  const missingMatch = trimmed.match(/⚠️\s+(.+?)\s*—\s*no digest found/);
  if (missingMatch?.[1]) {
    return { agent_name: missingMatch[1].trim(), failure_type: "Missing Digest" };
  }

  // Pattern: status line referencing ⚠️ Partial
  if (trimmed.includes("⚠️") && trimmed.toLowerCase().includes("partial")) {
    const agentMatch = trimmed.match(/^[-•*]?\s*(.+?)\s*(?:—|:)\s*⚠️\s*Partial/i);
    if (agentMatch?.[1]) {
      return { agent_name: agentMatch[1].trim(), failure_type: "Partial Run" };
    }
  }

  // Pattern: status line referencing ❌ Failed
  if (trimmed.includes("❌") && trimmed.toLowerCase().includes("failed")) {
    const agentMatch = trimmed.match(/^[-•*]?\s*(.+?)\s*(?:—|:)\s*❌\s*Failed/i);
    if (agentMatch?.[1]) {
      return { agent_name: agentMatch[1].trim(), failure_type: "Failed Run" };
    }
  }

  // Pattern: snapshot flagged as stale
  if (trimmed.toLowerCase().includes("stale") && trimmed.toLowerCase().includes("snapshot")) {
    const agentMatch = trimmed.match(/^[-•*]?\s*(.+?)\s*(?:—|:)\s*.*stale/i);
    if (agentMatch?.[1]) {
      return { agent_name: agentMatch[1].trim(), failure_type: "Stale Snapshot" };
    }
  }

  return null;
}

function todayDateString(dateOverride?: string): string {
  if (dateOverride) return dateOverride;
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(now);
}

export async function executeScanBriefingFailures(
  input: ScanBriefingFailuresInput,
  notion: Client
): Promise<ScanBriefingFailuresOutput> {
  const dateStr = todayDateString(input.briefing_date);
  const searchTitle = `Morning Briefing — ${dateStr}`;

  try {
    const dbId = getDocsDatabaseId();
    const response = await notion.databases.query({
      database_id: dbId,
      filter: {
        property: "Name",
        title: { contains: searchTitle },
      },
      sorts: [{ timestamp: "created_time", direction: "descending" }],
      page_size: 1,
    });

    const results = response.results ?? [];
    if (results.length === 0) {
      return {
        success: true,
        briefing_found: false,
        briefing_page_url: null,
        failures: [],
        total_failures: 0,
      };
    }

    const page = results[0] as { id: string; url?: string };
    const pageId = page.id;
    const pageUrl = page.url ?? null;

    // Read all blocks to find failure signals
    let blockLines: string[] = [];
    try {
      const blocks = await notion.blocks.children.list({ block_id: pageId, page_size: 100 });
      for (const b of blocks.results ?? []) {
        const block = b as {
          type?: string;
          paragraph?: { rich_text?: Array<{ plain_text?: string }> };
          heading_2?: { rich_text?: Array<{ plain_text?: string }> };
          bulleted_list_item?: { rich_text?: Array<{ plain_text?: string }> };
        };
        const rich =
          block.paragraph?.rich_text ??
          block.heading_2?.rich_text ??
          block.bulleted_list_item?.rich_text;
        if (rich) {
          blockLines.push(rich.map((r) => r.plain_text ?? "").join(""));
        }
      }
    } catch {
      blockLines = [];
    }

    const failures: BriefingFailure[] = [];
    for (const line of blockLines) {
      const parsed = parseFailureLine(line);
      if (parsed) {
        failures.push({
          agent_name: parsed.agent_name,
          failure_type: parsed.failure_type,
          signal_line: line.trim(),
        });
      }
    }

    return {
      success: true,
      briefing_found: true,
      briefing_page_url: pageUrl,
      failures,
      total_failures: failures.length,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[scan-briefing-failures] Notion API error:", message);
    return { success: false, error: message };
  }
}
