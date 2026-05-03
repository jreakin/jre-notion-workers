/**
 * scan-briefing-failures: Reads today's Morning Briefing digest and extracts structured failure signals.
 * Used by Dead Letter Logger agent to detect missing/failed/partial runs.
 */
import type { Client } from "@notionhq/client";
import { getDocsDatabaseId } from "../shared/notion-client.js";
import { isValidAgentName, VALID_AGENT_NAMES } from "../shared/agent-config.js";
import type {
  ScanBriefingFailuresInput,
  ScanBriefingFailuresOutput,
  BriefingFailure,
  FailureType,
} from "../shared/types.js";

/**
 * Names that look like agent names but are actually parser artifacts from
 * status lines or report sections. We never want these to surface as failure
 * agents.
 */
const PARSER_ARTIFACTS = new Set<string>([
  "Report Status",
  "Sync Status",
  "Snapshot Status",
  "Run Time",
  "Scope",
  "Input Versions",
  "Summary",
  "Agent Run Summary",
  "Heartbeat",
  "Status",
]);

function cleanAgentCandidate(s: string): string {
  return s.replace(/^[-•*\s]+/, "").replace(/[:—\-]+$/, "").trim();
}

/**
 * Validate a candidate agent name from briefing parsing. We use an allowlist
 * of known agent names so parser artifacts like "Report Status" do not become
 * agent names. As a fallback we reject any candidate matching a known
 * artifact label or shorter than 4 chars.
 */
export function isValidBriefingAgentCandidate(candidate: string): boolean {
  const c = cleanAgentCandidate(candidate);
  if (!c) return false;
  if (PARSER_ARTIFACTS.has(c)) return false;
  if (isValidAgentName(c)) return true;
  // Accept loose matches against known agents (case-insensitive) so future
  // agent additions don't silently break parsing — but never accept artifacts.
  const lower = c.toLowerCase();
  return VALID_AGENT_NAMES.some((n) => n.toLowerCase() === lower);
}

/**
 * Parse a line from the Morning Briefing Agent Run Summary to determine failure type.
 * Returns null if the line does not indicate a failure or the candidate name is
 * not on the agent allowlist.
 */
export function parseFailureLine(line: string): { agent_name: string; failure_type: FailureType } | null {
  const trimmed = line.trim();

  const accept = (candidate: string, failure_type: FailureType): { agent_name: string; failure_type: FailureType } | null => {
    const cleaned = cleanAgentCandidate(candidate);
    if (!isValidBriefingAgentCandidate(cleaned)) return null;
    return { agent_name: cleaned, failure_type };
  };

  // Pattern: "⚠️ [Agent Name] — no digest found"
  const missingMatch = trimmed.match(/⚠️\s+(.+?)\s*—\s*no digest found/);
  if (missingMatch?.[1]) {
    const r = accept(missingMatch[1], "Missing Digest");
    if (r) return r;
  }

  // Pattern: status line referencing ⚠️ Partial
  if (trimmed.includes("⚠️") && trimmed.toLowerCase().includes("partial")) {
    const agentMatch = trimmed.match(/^[-•*]?\s*(.+?)\s*(?:—|:)\s*⚠️\s*Partial/i);
    if (agentMatch?.[1]) {
      const r = accept(agentMatch[1], "Partial Run");
      if (r) return r;
    }
  }

  // Pattern: status line referencing ❌ Failed
  if (trimmed.includes("❌") && trimmed.toLowerCase().includes("failed")) {
    const agentMatch = trimmed.match(/^[-•*]?\s*(.+?)\s*(?:—|:)\s*❌\s*Failed/i);
    if (agentMatch?.[1]) {
      const r = accept(agentMatch[1], "Failed Run");
      if (r) return r;
    }
  }

  // Pattern: snapshot flagged as stale
  if (trimmed.toLowerCase().includes("stale") && trimmed.toLowerCase().includes("snapshot")) {
    const agentMatch = trimmed.match(/^[-•*]?\s*(.+?)\s*(?:—|:)\s*.*stale/i);
    if (agentMatch?.[1]) {
      const r = accept(agentMatch[1], "Stale Snapshot");
      if (r) return r;
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
