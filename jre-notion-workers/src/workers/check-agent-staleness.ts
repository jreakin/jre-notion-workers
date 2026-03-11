/**
 * check-agent-staleness: Checks each agent's last digest against cadence-based
 * staleness thresholds. Creates Dead Letter records for overdue agents.
 */
import type { Client } from "@notionhq/client";
import { getDocsDatabaseId, getHomeDocsDatabaseId, getDeadLettersDatabaseId } from "../shared/notion-client.js";
import {
  AGENT_DIGEST_PATTERNS,
  AGENT_TARGET_DB,
  MONITORED_AGENTS,
  AGENT_CADENCE,
  STALENESS_THRESHOLDS,
} from "../shared/agent-config.js";
import type { AgentCadence } from "../shared/agent-config.js";
import { parseRunTimeString, hoursAgo } from "../shared/date-utils.js";
import { executeLogDeadLetter } from "./log-dead-letter.js";
import type {
  CheckAgentStalenessInput,
  CheckAgentStalenessOutput,
  StalenessEntry,
} from "../shared/types.js";

export async function executeCheckAgentStaleness(
  input: CheckAgentStalenessInput,
  notion: Client
): Promise<CheckAgentStalenessOutput> {
  try {
    const agentsToCheck =
      input.agent_names && input.agent_names.length > 0
        ? input.agent_names.filter((n) => MONITORED_AGENTS.includes(n))
        : MONITORED_AGENTS;

    if (agentsToCheck.length === 0) {
      return { success: false, error: "No valid agents to check" };
    }

    const dryRun = input.dry_run ?? false;
    const overrides = input.thresholds ?? {};

    const resolvedThresholds: Record<AgentCadence, number> = {
      daily: overrides.daily ?? STALENESS_THRESHOLDS.daily,
      weekly: overrides.weekly ?? STALENESS_THRESHOLDS.weekly,
      biweekly: overrides.biweekly ?? STALENESS_THRESHOLDS.biweekly,
      monthly: overrides.monthly ?? STALENESS_THRESHOLDS.monthly,
    };

    const entries: StalenessEntry[] = [];
    let totalDeadLettersCreated = 0;
    const todayStr = new Date().toISOString().slice(0, 10);

    for (const agentName of agentsToCheck) {
      const cadence = AGENT_CADENCE[agentName] ?? "daily";
      const thresholdHours = resolvedThresholds[cadence];
      const patterns = AGENT_DIGEST_PATTERNS[agentName];
      const targetDb = AGENT_TARGET_DB[agentName] ?? "docs";
      const dbId = targetDb === "home_docs" ? getHomeDocsDatabaseId() : getDocsDatabaseId();

      let lastRunTime: string | null = null;
      let ageHours: number | null = null;
      let isStale = false;

      if (patterns && patterns.length > 0) {
        try {
          const orConditions = patterns.map((p) => ({
            property: "Name",
            title: { contains: p },
          }));
          const response = await notion.databases.query({
            database_id: dbId,
            filter: orConditions.length > 0 ? { or: orConditions } : undefined,
            sorts: [{ timestamp: "created_time", direction: "descending" }],
            page_size: 1,
          });

          if (response.results.length > 0) {
            const page = response.results[0] as { id: string; created_time?: string };
            const pageId = page.id;

            // Fetch blocks to extract Run Time
            try {
              const blocks = await notion.blocks.children.list({ block_id: pageId, page_size: 20 });
              for (const b of blocks.results) {
                const block = b as {
                  paragraph?: { rich_text?: Array<{ plain_text?: string }> };
                };
                const text = block.paragraph?.rich_text?.map((r) => r.plain_text ?? "").join("") ?? "";
                if (text.startsWith("Run Time:")) {
                  const runTimeDate = parseRunTimeString(text.replace("Run Time:", "").trim());
                  if (runTimeDate) {
                    lastRunTime = runTimeDate.toISOString();
                    ageHours = hoursAgo(lastRunTime);
                  }
                  break;
                }
              }
            } catch {
              // Fall back to created_time
            }

            // Fall back to created_time if we couldn't parse Run Time
            if (lastRunTime === null && page.created_time) {
              lastRunTime = page.created_time;
              ageHours = hoursAgo(lastRunTime);
            }
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error("[check-agent-staleness] query error for", agentName, msg);
        }
      }

      isStale = ageHours !== null ? ageHours > thresholdHours : true;

      let deadLetterCreated = false;
      let deadLetterUrl: string | null = null;

      if (isStale && !dryRun) {
        // Check for existing Dead Letter first
        try {
          const dlDbId = getDeadLettersDatabaseId();
          const existing = await notion.databases.query({
            database_id: dlDbId,
            filter: {
              and: [
                { property: "Agent Name", select: { equals: agentName } },
                { property: "Expected Run Date", date: { equals: todayStr } },
                { property: "Resolution Status", select: { does_not_equal: "Resolved" } },
              ],
            },
            page_size: 1,
          });

          if (existing.results.length === 0) {
            const result = await executeLogDeadLetter(
              {
                agent_name: agentName,
                expected_run_date: todayStr,
                failure_type: "Stale Snapshot",
                detected_by: "Dead Letter Logger",
                notes: `[check-agent-staleness] Agent ${agentName} is stale — last run ${ageHours !== null ? `${Math.round(ageHours)}h ago` : "unknown"}, threshold ${thresholdHours}h (${cadence})`,
              },
              notion
            );

            if (result.success) {
              deadLetterCreated = true;
              deadLetterUrl = result.record_url;
              totalDeadLettersCreated++;
            }
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error("[check-agent-staleness] dead letter error for", agentName, msg);
        }
      }

      let notice: string;
      if (!isStale) {
        notice = `✅ ${agentName} — current (${ageHours !== null ? `${Math.round(ageHours)}h` : "?"}/${thresholdHours}h)`;
      } else if (ageHours !== null) {
        notice = `⚠️ ${agentName} — stale (${Math.round(ageHours)}h, threshold ${thresholdHours}h)`;
      } else {
        notice = `⚠️ ${agentName} — no digest found`;
      }

      console.log("[check-agent-staleness]", notice);

      entries.push({
        agent_name: agentName,
        cadence,
        last_run_time: lastRunTime,
        age_hours: ageHours !== null ? Math.round(ageHours) : null,
        threshold_hours: thresholdHours,
        is_stale: isStale,
        dead_letter_created: deadLetterCreated,
        dead_letter_url: deadLetterUrl,
        notice,
      });
    }

    const totalStale = entries.filter((e) => e.is_stale).length;
    const staleNames = entries
      .filter((e) => e.is_stale)
      .map((e) => `${e.agent_name} ${e.age_hours !== null ? `${e.age_hours}h` : "unknown"}`)
      .join(", ");

    const summary = `Checked ${entries.length} agents: ${totalStale} stale${totalStale > 0 ? ` (${staleNames})` : ""}, ${totalDeadLettersCreated} Dead Letters created`;

    return {
      success: true,
      entries,
      total_checked: entries.length,
      total_stale: totalStale,
      total_dead_letters_created: totalDeadLettersCreated,
      summary,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[check-agent-staleness] fatal error:", message);
    return { success: false, error: message };
  }
}
