/**
 * check-upstream-status: Finds most recent digest for an agent and returns structured status.
 */
import type { Client } from "@notionhq/client";
import { getDocsDatabaseId, getHomeDocsDatabaseId } from "../shared/notion-client.js";
import { AGENT_DIGEST_PATTERNS, AGENT_TARGET_DB, VALID_AGENT_NAMES } from "../shared/agent-config.js";
import { parseStatusLine, hasHeartbeatLine } from "../shared/status-parser.js";
import { parseRunTimeString, hoursAgo } from "../shared/date-utils.js";
import type { CheckUpstreamStatusInput, CheckUpstreamStatusOutput, UpstreamStatus } from "../shared/types.js";

const MAX_AGE_DEFAULT = 48;

function buildDataCompletenessNotice(
  agentName: string,
  kind: "not_found" | "stale" | "partial_failed" | "error_titled",
  ageHours?: number,
  maxAgeHours?: number
): string {
  switch (kind) {
    case "not_found":
      return `⚠️ Data Completeness Notice: ${agentName} digest not found for current cycle. Dimensions relying on this data marked 🔘 Unavailable.`;
    case "stale":
      return `⚠️ Data Completeness Notice: ${agentName} last ran ${ageHours ?? "?"}h ago (expected within ${maxAgeHours ?? 48}h). Treating as stale.`;
    case "partial_failed":
      return `⚠️ Data Completeness Notice: ${agentName} last run was ⚠️ Partial / ❌ Failed. Upstream data may be incomplete.`;
    case "error_titled":
      return `⚠️ Data Completeness Notice: ${agentName} last digest was an ERROR run. Treating upstream data as degraded.`;
    default:
      return "";
  }
}

export async function executeCheckUpstreamStatus(
  input: CheckUpstreamStatusInput,
  notion: Client
): Promise<CheckUpstreamStatusOutput> {
  if (!input.agent_name || !VALID_AGENT_NAMES.includes(input.agent_name)) {
    return {
      found: false,
      agent_name: input.agent_name,
      status: "not_found",
      status_type: null,
      run_time: null,
      run_time_age_hours: null,
      is_stale: true,
      is_heartbeat: false,
      is_error_titled: false,
      page_url: null,
      page_id: null,
      degraded: true,
      data_completeness_notice: buildDataCompletenessNotice(input.agent_name, "not_found"),
    };
  }

  const maxAgeHours = input.max_age_hours ?? MAX_AGE_DEFAULT;
  const requireCurrentCycle = input.require_current_cycle ?? false;
  const patterns = AGENT_DIGEST_PATTERNS[input.agent_name];
  const targetDb = AGENT_TARGET_DB[input.agent_name] ?? "docs";
  const dbId = targetDb === "home_docs" ? getHomeDocsDatabaseId() : getDocsDatabaseId();

  try {
    const orConditions = (patterns ?? []).map((p) => ({
      property: "Name",
      title: { contains: p },
    }));
    const response = await notion.databases.query({
      database_id: dbId,
      filter: orConditions.length > 0 ? { or: orConditions } : undefined,
      sorts: [{ timestamp: "created_time", direction: "descending" }],
      page_size: 5,
    });

    const results = response.results ?? [];
    if (results.length === 0) {
      return {
        found: false,
        agent_name: input.agent_name,
        status: "not_found",
        status_type: null,
        run_time: null,
        run_time_age_hours: null,
        is_stale: true,
        is_heartbeat: false,
        is_error_titled: false,
        page_url: null,
        page_id: null,
        degraded: true,
        data_completeness_notice: buildDataCompletenessNotice(input.agent_name, "not_found"),
      };
    }

    const page = results[0] as { id: string; url?: string; created_time?: string; properties?: Record<string, unknown> };
    const pageId = page.id;
    const pageUrl = page.url ?? null;
    const createdTime = page.created_time ?? "";
    const createdDate = createdTime ? new Date(createdTime) : null;
    const ageHours = createdDate ? Math.floor((Date.now() - createdDate.getTime()) / (1000 * 60 * 60)) : null;

    let title = "";
    const titleProp = page.properties?.["Name"];
    if (titleProp && typeof titleProp === "object" && "title" in titleProp) {
      const arr = (titleProp as { title: Array<{ plain_text?: string }> }).title;
      title = arr?.map((t) => t.plain_text ?? "").join("") ?? "";
    }
    const isErrorTitled = title.includes("ERROR");

    let blockLines: string[] = [];
    try {
      const blocks = await notion.blocks.children.list({ block_id: pageId, page_size: 50 });
      for (const b of blocks.results ?? []) {
        const block = b as { type?: string; paragraph?: { rich_text?: Array<{ plain_text?: string }> }; heading_2?: { rich_text?: Array<{ plain_text?: string }> } };
        const rich = block.paragraph?.rich_text ?? block.heading_2?.rich_text;
        if (rich) {
          blockLines.push(rich.map((r) => r.plain_text ?? "").join(""));
        }
      }
    } catch {
      blockLines = [];
    }

    const parsed = parseStatusLine(blockLines);
    const statusType = parsed?.status_type ?? null;
    const statusValue = (parsed?.status_value ?? "unknown") as UpstreamStatus;
    const runTimeRaw = parseRunTimeString(
      blockLines.find((l) => l.startsWith("Run Time:"))?.replace("Run Time:", "").trim() ?? ""
    );
    const runTime = runTimeRaw ? runTimeRaw.toISOString() : null;
    const runTimeAgeHours = runTime ? hoursAgo(runTime) : null;
    const isHeartbeat = hasHeartbeatLine(blockLines);

    const isStale =
      (requireCurrentCycle && (runTimeAgeHours ?? 999) > MAX_AGE_DEFAULT) ||
      (ageHours !== null && ageHours > maxAgeHours);

    let status: UpstreamStatus = statusValue;
    if (results.length === 0) status = "not_found";
    else if (isStale) status = "stale";

    const degraded =
      status === "not_found" ||
      status === "stale" ||
      status === "partial" ||
      status === "failed" ||
      isErrorTitled;

    let dataCompletenessNotice = "";
    if (degraded) {
      if (status === "not_found")
        dataCompletenessNotice = buildDataCompletenessNotice(input.agent_name, "not_found");
      else if (status === "stale")
        dataCompletenessNotice = buildDataCompletenessNotice(
          input.agent_name,
          "stale",
          ageHours ?? undefined,
          maxAgeHours
        );
      else if (status === "partial" || status === "failed")
        dataCompletenessNotice = buildDataCompletenessNotice(input.agent_name, "partial_failed");
      else if (isErrorTitled)
        dataCompletenessNotice = buildDataCompletenessNotice(input.agent_name, "error_titled");
    }

    return {
      found: true,
      agent_name: input.agent_name,
      status,
      status_type: statusType,
      run_time: runTime,
      run_time_age_hours: runTimeAgeHours ?? null,
      is_stale: isStale,
      is_heartbeat: isHeartbeat,
      is_error_titled: isErrorTitled,
      page_url: pageUrl,
      page_id: pageId,
      degraded,
      data_completeness_notice: dataCompletenessNotice,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[check-upstream-status] Notion API error", message);
    return {
      found: false,
      agent_name: input.agent_name,
      status: "unknown",
      status_type: null,
      run_time: null,
      run_time_age_hours: null,
      is_stale: true,
      is_heartbeat: false,
      is_error_titled: false,
      page_url: null,
      page_id: null,
      degraded: true,
      data_completeness_notice: `⚠️ Data Completeness Notice: Error reading ${input.agent_name} — ${message}`,
    };
  }
}
