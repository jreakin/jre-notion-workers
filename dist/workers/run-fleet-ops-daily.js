import { extractErrorMessage } from "../shared/notion-client.js";
import { MONITORED_AGENTS } from "../shared/agent-config.js";
import { executeMonitorFleetStatus } from "./monitor-fleet-status.js";
import { executeResolveStaleDeadLetters } from "./resolve-stale-dead-letters.js";
import { executeCalculateCreditForecast } from "./calculate-credit-forecast.js";
import { executeWriteAgentDigest } from "./write-agent-digest.js";
import { buildBaselineCreditEntries } from "../shared/fleet-baselines.js";
function todayChicago() {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Chicago",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(new Date());
    const y = parts.find((p) => p.type === "year")?.value ?? "";
    const m = parts.find((p) => p.type === "month")?.value ?? "";
    const d = parts.find((p) => p.type === "day")?.value ?? "";
    return `${y}-${m}-${d}`;
}
export async function executeRunFleetOpsDaily(input, notion) {
    const dryRun = input.dry_run ?? false;
    const writeDigest = input.write_digest ?? true;
    const today = input.today ?? todayChicago();
    try {
        // 1. Fleet status
        const fleet = await executeMonitorFleetStatus({}, notion);
        if (!fleet.success) {
            return { success: false, error: `monitor-fleet-status failed: ${fleet.error}` };
        }
        // 2. Resolve stale dead letters for every agent whose latest run is current
        // (i.e. not degraded). Each call is idempotent — skips already-resolved rows.
        let totalResolved = 0;
        const resolveErrors = [];
        if (!dryRun) {
            const currentAgents = fleet.agents
                .filter((a) => a.found && !a.is_degraded && !a.is_stale)
                .map((a) => a.agent_name);
            for (const agentName of currentAgents) {
                const resolved = await executeResolveStaleDeadLetters({
                    agent_name: agentName,
                    successful_run_date: today,
                }, notion);
                if (resolved.success) {
                    totalResolved += resolved.total_resolved;
                }
                else {
                    resolveErrors.push(`${agentName}: ${resolved.error}`);
                }
            }
        }
        // 3. Credit forecast — baseline payload (calculate-credit-forecast is pure;
        //    seed it with the cadence-based baseline so we always produce a number).
        const creditPayload = buildBaselineCreditEntries();
        const forecast = executeCalculateCreditForecast({ agent_data: creditPayload });
        if (!forecast.success) {
            return { success: false, error: `calculate-credit-forecast failed: ${forecast.error}` };
        }
        // 4. Write a single combined digest
        let digestUrl = null;
        if (writeDigest && !dryRun) {
            const degraded = fleet.agents.filter((a) => a.is_degraded);
            const summary = `Fleet: ${fleet.total_scanned} scanned, ${fleet.total_current} current, ${fleet.total_degraded} degraded; ` +
                `Dead letters auto-resolved: ${totalResolved}; ` +
                `Forecast: ${forecast.fleet_total_buffered.toLocaleString("en-US")} credits/mo (~$${forecast.dollar_estimate.toFixed(2)}).`;
            const flagged = degraded.slice(0, 25).map((a) => ({
                description: `${a.notice}${a.digest_page_url ? ` — ${a.digest_page_url}` : ""}`,
                no_task_reason: "fleet-wide signal; not actionable as a single task",
            }));
            const digestResult = await executeWriteAgentDigest({
                agent_name: "Fleet Ops Agent",
                agent_emoji: "🛰️",
                status_type: "report",
                status_value: degraded.length === 0 ? "complete" : "full_report",
                run_time_chicago: new Date().toISOString(),
                scope: `${MONITORED_AGENTS.length} monitored agents; ${creditPayload.length} agents in forecast`,
                input_versions: `today=${today}; resolveErrors=${resolveErrors.length}`,
                flagged_items: flagged,
                actions_taken: { created_tasks: [], updated_tasks: [] },
                summary,
                needs_review: [],
                escalations: [],
                target_database: "agent_ops",
                doc_type: "Agent Digest",
            }, notion);
            if (digestResult.success) {
                digestUrl = digestResult.page_url;
            }
            else {
                console.error("[run-fleet-ops-daily] digest write failed:", digestResult.error);
            }
        }
        const summary = `Fleet ${fleet.total_current}/${fleet.total_scanned} current; resolved ${totalResolved} dead letters; forecast ${forecast.fleet_total_buffered} credits/mo.`;
        console.log("[run-fleet-ops-daily]", summary);
        return {
            success: true,
            fleet_total_scanned: fleet.total_scanned,
            fleet_total_degraded: fleet.total_degraded,
            dead_letters_resolved: totalResolved,
            credit_forecast_credits: forecast.fleet_total_buffered,
            digest_page_url: digestUrl,
            summary,
        };
    }
    catch (e) {
        const message = extractErrorMessage(e);
        console.error("[run-fleet-ops-daily] fatal:", message);
        return { success: false, error: message };
    }
}
