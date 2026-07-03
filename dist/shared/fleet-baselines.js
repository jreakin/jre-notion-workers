/**
 * Fleet-wide baselines used by run-fleet-ops-daily when no per-agent credit
 * data has been fed into calculate-credit-forecast. Conservative defaults —
 * tune as real usage data accrues.
 */
import { AGENT_CADENCE, SUSPENDED_AGENTS, VALID_AGENT_NAMES, } from "./agent-config.js";
/** Runs per month per cadence (rounded for round-number reporting). */
const RUNS_PER_MONTH = {
    daily: 30,
    weekly: 4,
    biweekly: 2,
    monthly: 1,
};
/** Conservative credits-per-run estimate by cadence. */
const CREDITS_PER_RUN = {
    daily: 40,
    weekly: 60,
    biweekly: 80,
    monthly: 120,
};
/**
 * Build a default `agent_data` payload for calculate-credit-forecast covering
 * every known agent. Suspended agents are flagged so the forecaster excludes
 * them from active totals.
 */
export function buildBaselineCreditEntries() {
    return VALID_AGENT_NAMES.map((name) => {
        const cadence = AGENT_CADENCE[name] ?? "daily";
        return {
            agent_name: name,
            est_runs_per_month: RUNS_PER_MONTH[cadence],
            est_credits_per_run: CREDITS_PER_RUN[cadence],
            is_suspended: SUSPENDED_AGENTS.includes(name),
        };
    });
}
