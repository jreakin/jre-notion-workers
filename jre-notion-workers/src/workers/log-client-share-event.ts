/**
 * log-client-share-event: Records a client publishing event (success, block,
 * partial, fail, revoke). Logs to Agent Ops when configured, and creates a
 * deduped Dead Letter for non-success events.
 */
import type { Client } from "@notionhq/client";
import {
  tryGetAgentOpsDatabaseId,
  getDeadLettersDatabaseId,
} from "../shared/notion-client.js";
import { withNotionRetry } from "../shared/notion-retry.js";
import { executeLogDeadLetter } from "./log-dead-letter.js";
import { RUN_STATUS } from "../shared/agent-ops-status.js";
import type {
  LogClientShareEventInput,
  LogClientShareEventOutput,
} from "../shared/types.js";

const AGENT_NAME = "Client Briefing Agent";

function todayChicago(): string {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(now);
}

export async function executeLogClientShareEvent(
  input: LogClientShareEventInput,
  notion: Client
): Promise<LogClientShareEventOutput> {
  if (!input.source_page_id?.trim()) return { success: false, error: "source_page_id is required" };
  if (!input.client_id?.trim()) return { success: false, error: "client_id is required" };
  if (!input.event_type) return { success: false, error: "event_type is required" };
  if (!input.message?.trim()) return { success: false, error: "message is required" };

  const recordIds: string[] = [];
  let loggedToAgentOps = false;
  let loggedToDeadLetter = false;

  const agentOpsDb = tryGetAgentOpsDatabaseId();
  if (agentOpsDb) {
    const status =
      input.event_type === "publish"
        ? RUN_STATUS.COMPLETE
        : input.event_type === "partial"
          ? RUN_STATUS.PARTIAL
          : input.event_type === "block" || input.event_type === "fail" || input.event_type === "revoke"
            ? RUN_STATUS.FAILED
            : RUN_STATUS.COMPLETE;

    try {
      const title = `${AGENT_NAME} — ${todayChicago()} — ${status} — ${input.event_type}`;
      const properties: Record<string, unknown> = {
        Title: { title: [{ text: { content: title } }] },
        "Agent Name": { select: { name: AGENT_NAME } },
        "Run Status": { select: { name: status } },
        "Run Date": { date: { start: todayChicago() } },
        Notes: { rich_text: [{ text: { content: input.message.slice(0, 1900) } }] },
      };
      const page = await withNotionRetry(
        () =>
          notion.pages.create({
            parent: { database_id: agentOpsDb },
            properties: properties as never,
          }),
        { label: "log-client-share-event.agent_ops" }
      );
      const id = "id" in page ? (page as { id: string }).id : "";
      if (id) recordIds.push(id);
      loggedToAgentOps = true;
    } catch (e) {
      console.warn(
        "[log-client-share-event] agent ops write failed:",
        e instanceof Error ? e.message : String(e)
      );
    }
  }

  if (input.event_type === "block" || input.event_type === "fail") {
    try {
      // Reuse the dedupe-aware dead letter writer.
      try {
        getDeadLettersDatabaseId();
      } catch {
        return {
          success: true,
          logged_to_agent_ops: loggedToAgentOps,
          logged_to_dead_letter: false,
          record_ids: recordIds,
        };
      }
      const dlResult = await executeLogDeadLetter(
        {
          agent_name: AGENT_NAME,
          expected_run_date: todayChicago(),
          failure_type: input.event_type === "block" ? "Partial Run" : "Failed Run",
          detected_by: "Manual",
          notes: `[client-share:${input.event_type}] page=${input.source_page_id} client=${input.client_id} :: ${input.message}`,
        },
        notion
      );
      if (dlResult.success) {
        recordIds.push(dlResult.record_id);
        loggedToDeadLetter = true;
      }
    } catch (e) {
      console.warn(
        "[log-client-share-event] dead letter write failed:",
        e instanceof Error ? e.message : String(e)
      );
    }
  }

  return {
    success: true,
    logged_to_agent_ops: loggedToAgentOps,
    logged_to_dead_letter: loggedToDeadLetter,
    record_ids: recordIds,
  };
}
