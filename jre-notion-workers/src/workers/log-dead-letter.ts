/**
 * log-dead-letter: Creates a structured record in the Dead Letters database for a single failure.
 * Used by Dead Letter Logger agent after scanning Morning Briefing for failure signals.
 */
import type { Client } from "@notionhq/client";
import { getDeadLettersDatabaseId } from "../shared/notion-client.js";
import type { LogDeadLetterInput, LogDeadLetterOutput } from "../shared/types.js";

const VALID_FAILURE_TYPES = ["Missing Digest", "Partial Run", "Failed Run", "Stale Snapshot"] as const;
const VALID_DETECTED_BY = ["Dead Letter Logger", "Morning Briefing", "Manual"] as const;

export async function executeLogDeadLetter(
  input: LogDeadLetterInput,
  notion: Client
): Promise<LogDeadLetterOutput> {
  if (!input.agent_name?.trim()) {
    return { success: false, error: "agent_name is required" };
  }
  if (!input.expected_run_date?.trim()) {
    return { success: false, error: "expected_run_date is required" };
  }
  if (!VALID_FAILURE_TYPES.includes(input.failure_type as typeof VALID_FAILURE_TYPES[number])) {
    return { success: false, error: `Invalid failure_type: ${input.failure_type}` };
  }
  if (!VALID_DETECTED_BY.includes(input.detected_by as typeof VALID_DETECTED_BY[number])) {
    return { success: false, error: `Invalid detected_by: ${input.detected_by}` };
  }
  if (!input.notes?.trim()) {
    return { success: false, error: "notes is required (paste the exact signal line)" };
  }

  try {
    const dbId = getDeadLettersDatabaseId();

    const pageTitle = `${input.agent_name} — ${input.expected_run_date} — ${input.failure_type}`;

    const properties: Record<string, unknown> = {
      Title: { title: [{ text: { content: pageTitle } }] },
      "Agent Name": { select: { name: input.agent_name } },
      "Expected Run Date": { date: { start: input.expected_run_date } },
      "Failure Type": { select: { name: input.failure_type } },
      "Detected By": { select: { name: input.detected_by } },
      "Resolution Status": { select: { name: "Open" } },
      "Notes": { rich_text: [{ text: { content: input.notes } }] },
    };

    if (input.linked_task_id?.trim()) {
      properties["Linked Task"] = { relation: [{ id: input.linked_task_id }] };
    }

    const page = await notion.pages.create({
      parent: { database_id: dbId },
      properties: properties as never,
    });

    const pageId = "id" in page ? (page as { id: string }).id : "";
    const pageUrl = "url" in page ? (page as { url: string }).url : "";
    console.log("[log-dead-letter] created record", pageId, input.agent_name, input.failure_type);

    return {
      success: true,
      record_id: pageId,
      record_url: pageUrl,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[log-dead-letter] Notion API error:", message);
    return { success: false, error: message };
  }
}
