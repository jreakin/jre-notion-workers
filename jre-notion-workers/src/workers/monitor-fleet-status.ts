/**
 * monitor-fleet-status: Batch-queries all agents' latest digests and returns fleet-wide status.
 * Used by Fleet Monitor agent to update the Fleet Status table on System Control Plane.
 */
import type { Client } from "@notionhq/client";
import { getDocsDatabaseId, getHomeDocsDatabaseId } from "../shared/notion-client.js";
import { AGENT_DIGEST_PATTERNS, AGENT_TARGET_DB, MONITORED_AGENTS } from "../shared/agent-config.js";
import { parseStatusLine, hasHeartbeatLine } from "../shared/status-parser.js";
import { parseRunTimeString, hoursAgo } from "../shared/date-utils.js";
import type {
  MonitorFleetStatusInput,
  MonitorFleetStatusOutput,
  AgentFleetEntry,
  UpstreamStatus,
} from "../shared/types.js";

const MAX_AGE_HOURS = 48;

async function checkSingleAgent(
  agentName: string,
  notion: Client
): Promise<AgentFleetEntry> {
  const patterns = AGENT_DIGEST_PATTERNS[agentName];
  const targetDb = AGENT_TARGET_DB[agentName] ?? "docs";
  const isHomeDocs = targetDb === "home_docs";
  const dbId = isHomeDocs ? getHomeDocsDatabaseId() : getDocsDatabaseId();
  const titlePropName = isHomeDocs ? "Doc" : "Name";

  const notFoundEntry: AgentFleetEntry = {
    agent_name: agentName,
    found: false,
    status: "not_found",
    status_type: null,
    run_time: null,
    run_time_age_hours: null,
    is_degraded: true,
    is_stale: true,
    is_error_titled: false,
    digest_page_url: null,
    notice: `⚠️ ${agentName} — no digest found`,
  };

  if (!patterns || patterns.length === 0) return notFoundEntry;

  try {
    const orConditions = patterns.map((p) => ({
      property: titlePropName,
      title: { contains: p },
    }));
    const response = await notion.databases.query({
      database_id: dbId,
      filter: orConditions.length > 0 ? { or: orConditions } : undefined,
      sorts: [{ timestamp: "created_time", direction: "descending" }],
      page_size: 1,
    });

    const results = response.results ?? [];
    if (results.length === 0) return notFoundEntry;

    const page = results[0] as {
      id: string;
      url?: string;
      created_time?: string;
      properties?: Record<string, unknown>;
    };
    const pageId = page.id;
    const pageUrl = page.url ?? null;
    const createdTime = page.created_time ?? "";
    const createdDate = createdTime ? new Date(createdTime) : null;
    const ageHours = createdDate
      ? Math.floor((Date.now() - createdDate.getTime()) / (1000 * 60 * 60))
      : null;

    let title = "";
    const titleProp = page.properties?.[titlePropName];
    if (titleProp && typeof titleProp === "object" && "title" in titleProp) {
      const arr = (titleProp as { title: Array<{ plain_text?: string }> }).title;
      title = arr?.map((t) => t.plain_text ?? "").join("") ?? "";
    }
    const isErrorTitled = title.includes("ERROR");

    let blockLines: string[] = [];
    try {
      const blocks = await notion.blocks.children.list({ block_id: pageId, page_size: 20 });
      for (const b of blocks.results ?? []) {
        const block = b as {
          type?: string;
          paragraph?: { rich_text?: Array<{ plain_text?: string }> };
          heading_2?: { rich_text?: Array<{ plain_text?: string }> };
        };
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

    const isStale = ageHours !== null && ageHours > MAX_AGE_HOURS;
    let status: UpstreamStatus = statusValue;
    if (isStale) status = "stale";

    const isDegraded =
      status === "not_found" ||
      status === "stale" ||
      status === "partial" ||
      status === "failed" ||
      isErrorTitled;

    let notice = "";
    if (!isDegraded) {
      notice = `✅ ${agentName} — current`;
    } else if (isStale) {
      notice = `⚠️ ${agentName} — stale (${ageHours}h ago)`;
    } else if (status === "partial") {
      notice = `⚠️ ${agentName} — last run partial`;
    } else if (status === "failed") {
      notice = `❌ ${agentName} — last run failed`;
    } else if (isErrorTitled) {
      notice = `⚠️ ${agentName} — ERROR titled digest`;
    }

    return {
      agent_name: agentName,
      found: true,
      status,
      status_type: statusType,
      run_time: runTime,
      run_time_age_hours: runTimeAgeHours,
      is_degraded: isDegraded,
      is_stale: isStale,
      is_error_titled: isErrorTitled,
      digest_page_url: pageUrl,
      notice,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[monitor-fleet-status] error checking ${agentName}:`, message);
    return {
      agent_name: agentName,
      found: false,
      status: "unknown",
      status_type: null,
      run_time: null,
      run_time_age_hours: null,
      is_degraded: true,
      is_stale: true,
      is_error_titled: false,
      digest_page_url: null,
      notice: `❌ ${agentName} — error: ${message}`,
    };
  }
}

export async function executeMonitorFleetStatus(
  input: MonitorFleetStatusInput,
  notion: Client
): Promise<MonitorFleetStatusOutput> {
  const agentsToScan =
    input.agent_names && input.agent_names.length > 0
      ? input.agent_names.filter((n) => MONITORED_AGENTS.includes(n))
      : MONITORED_AGENTS;

  if (agentsToScan.length === 0) {
    return { success: false, error: "No valid agents to scan" };
  }

  try {
    const entries: AgentFleetEntry[] = [];
    for (const agentName of agentsToScan) {
      const entry = await checkSingleAgent(agentName, notion);
      entries.push(entry);
    }

    const totalScanned = entries.length;
    const totalMissing = entries.filter((e) => !e.found).length;
    const totalDegraded = entries.filter((e) => e.is_degraded).length;
    const totalCurrent = totalScanned - totalDegraded;

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toLocaleTimeString("en-US", {
      timeZone: "America/Chicago",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });

    let heartbeatMessage: string;
    if (totalDegraded === 0) {
      heartbeatMessage = `Fleet Monitor — Heartbeat: all agents current, no degraded runs — ${dateStr}`;
    } else {
      heartbeatMessage = `Fleet Monitor run complete — ${dateStr} ${timeStr} CT — ${totalCurrent} agents updated, ${totalMissing} missing`;
    }

    return {
      success: true,
      agents: entries,
      total_scanned: totalScanned,
      total_current: totalCurrent,
      total_missing: totalMissing,
      total_degraded: totalDegraded,
      heartbeat_message: heartbeatMessage,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[monitor-fleet-status] fatal error:", message);
    return { success: false, error: message };
  }
}
