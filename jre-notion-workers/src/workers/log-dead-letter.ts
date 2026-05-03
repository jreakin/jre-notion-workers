/**
 * log-dead-letter: Creates a structured record in the Dead Letters database for a single failure.
 * Used by Dead Letter Logger agent after scanning Morning Briefing for failure signals.
 *
 * Dedupes against existing Open records with the same (Agent Name, Failure Type,
 * Expected Run Date) tuple to prevent storms of duplicate dead letters when the
 * same failure is detected by multiple sources or repeat scans.
 */
import type { Client } from "@notionhq/client";
import { getDeadLettersDatabaseId } from "../shared/notion-client.js";
import { withNotionRetry } from "../shared/notion-retry.js";
import type { LogDeadLetterInput, LogDeadLetterOutput } from "../shared/types.js";

const VALID_FAILURE_TYPES = ["Missing Digest", "Partial Run", "Failed Run", "Stale Snapshot"] as const;
const VALID_DETECTED_BY = ["Dead Letter Logger", "Morning Briefing", "Manual", "Fleet Ops Agent", "check-agent-staleness"] as const;

async function findOpenDuplicate(
  notion: Client,
  dbId: string,
  agentName: string,
  expectedRunDate: string,
  failureType: string
): Promise<{ id: string; url: string } | null> {
  try {
    const resp = await withNotionRetry(
      () =>
        notion.databases.query({
          database_id: dbId,
          page_size: 5,
          filter: {
            and: [
              { property: "Agent Name", select: { equals: agentName } },
              { property: "Failure Type", select: { equals: failureType } },
              { property: "Expected Run Date", date: { equals: expectedRunDate } },
              { property: "Resolution Status", select: { equals: "Open" } },
            ],
          } as never,
        }),
      { label: "log-dead-letter.dedupe" }
    );
    const first = (resp.results ?? [])[0];
    if (!first) return null;
    const p = first as { id: string; url?: string };
    return { id: p.id, url: p.url ?? "" };
  } catch (e) {
    // Best-effort dedupe: if filter shape differs in this workspace, fall through and create.
    console.warn("[log-dead-letter] dedupe query failed; proceeding with create:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

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

    const existing = await findOpenDuplicate(
      notion,
      dbId,
      input.agent_name,
      input.expected_run_date,
      input.failure_type
    );

    if (existing) {
      console.log(
        "[log-dead-letter] deduped; existing Open record",
        existing.id,
        input.agent_name,
        input.failure_type,
        input.expected_run_date
      );
      return {
        success: true,
        record_id: existing.id,
        record_url: existing.url,
        deduped: true,
      };
    }

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

    const page = await withNotionRetry(
      () =>
        notion.pages.create({
          parent: { database_id: dbId },
          properties: properties as never,
        }),
      { label: "log-dead-letter.create" }
    );

    const pageId = "id" in page ? (page as { id: string }).id : "";
    const pageUrl = "url" in page ? (page as { url: string }).url : "";
    console.log("[log-dead-letter] created record", pageId, input.agent_name, input.failure_type);

    return {
      success: true,
      record_id: pageId,
      record_url: pageUrl,
      deduped: false,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[log-dead-letter] Notion API error:", message);
    return { success: false, error: message };
  }
}
