/**
 * write-agent-ops-run: Records the outcome of an agent run in the Agent Ops
 * database. Maps incoming (status_type, status_value) to canonical Run Status,
 * applies heartbeat validation, and links the originating digest if provided.
 */
import type { Client } from "@notionhq/client";
import { getAgentOpsDatabaseId } from "../shared/notion-client.js";
import { withNotionRetry } from "../shared/notion-retry.js";
import { mapToRunStatus } from "../shared/agent-ops-status.js";
import { isValidAgentName } from "../shared/agent-config.js";
import type { WriteAgentOpsRunInput, WriteAgentOpsRunOutput } from "../shared/types.js";

function isISODate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}/.test(s) && !isNaN(Date.parse(s));
}

export async function executeWriteAgentOpsRun(
  input: WriteAgentOpsRunInput,
  notion: Client
): Promise<WriteAgentOpsRunOutput> {
  if (!input.agent_name?.trim()) {
    return { success: false, error: "agent_name is required" };
  }
  if (!isValidAgentName(input.agent_name)) {
    return { success: false, error: `Unknown agent_name: ${input.agent_name}` };
  }
  if (!input.run_date?.trim() || !isISODate(input.run_date)) {
    return { success: false, error: "run_date must be a valid ISO date (YYYY-MM-DD or full ISO)" };
  }

  const flagged = input.flagged_count ?? 0;
  const review = input.needs_review_count ?? 0;
  const escalations = input.escalation_count ?? 0;
  const isHeartbeatShape = flagged === 0 && review === 0 && escalations === 0;

  const warnings = [...(input.warnings ?? [])];
  let statusType = input.status_type;
  let statusValue = input.status_value;
  let coercedToHeartbeat = false;

  if (isHeartbeatShape && (statusValue === "partial" || statusValue === "failed")) {
    warnings.push(
      `Run reports zero actionable items but status_value=${statusValue}; coerced to heartbeat (Complete) before write.`
    );
    statusType = "heartbeat";
    statusValue = "complete";
    coercedToHeartbeat = true;
  }

  const runStatus = mapToRunStatus(statusType, statusValue);
  const dateOnly = input.run_date.slice(0, 10);

  try {
    const dbId = getAgentOpsDatabaseId();
    const title = `${input.agent_name} — ${dateOnly} — ${runStatus}`;

    const properties: Record<string, unknown> = {
      Title: { title: [{ text: { content: title } }] },
      "Agent Name": { select: { name: input.agent_name } },
      "Run Status": { select: { name: runStatus } },
      "Run Date": { date: { start: dateOnly } },
    };

    if (input.digest_page_url?.trim()) {
      properties["Digest URL"] = { url: input.digest_page_url };
    }
    if (input.notes?.trim() || warnings.length > 0) {
      const note = [input.notes ?? "", warnings.length ? `Warnings: ${warnings.join(" | ")}` : ""]
        .filter(Boolean)
        .join("\n");
      properties["Notes"] = { rich_text: [{ text: { content: note.slice(0, 1900) } }] };
    }

    const page = await withNotionRetry(
      () =>
        notion.pages.create({
          parent: { database_id: dbId },
          properties: properties as never,
        }),
      { label: "write-agent-ops-run" }
    );

    const id = "id" in page ? (page as { id: string }).id : "";
    const url = "url" in page ? (page as { url: string }).url : "";
    console.log("[write-agent-ops-run] created", id, input.agent_name, runStatus);

    return {
      success: true,
      record_id: id,
      record_url: url,
      run_status: runStatus,
      coerced_to_heartbeat: coercedToHeartbeat,
      warnings,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[write-agent-ops-run] error:", message);
    return { success: false, error: message };
  }
}
