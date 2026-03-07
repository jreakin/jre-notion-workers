/**
 * calculate-credit-forecast: Pure calculation tool for credit burn projections.
 * Takes agent data (read by the agent from the Credit Forecast table) and returns
 * structured projections with week-over-week delta.
 */
import type {
  CalculateCreditForecastInput,
  CalculateCreditForecastOutput,
  AgentCreditEntry,
} from "../shared/types.js";

const DEFAULT_PRICING_RATE = 10.0; // $10 per 1,000 credits
const DEFAULT_BUFFER_PERCENTAGE = 0.2; // 20%
const DELTA_THRESHOLD = 0.1; // ±10%

export function executeCalculateCreditForecast(
  input: CalculateCreditForecastInput
): CalculateCreditForecastOutput {
  if (!input.agent_data || input.agent_data.length === 0) {
    return { success: false, error: "agent_data is required and must not be empty" };
  }

  const pricingRate = input.pricing_rate ?? DEFAULT_PRICING_RATE;
  const bufferPct = input.buffer_percentage ?? DEFAULT_BUFFER_PERCENTAGE;

  const active: Array<AgentCreditEntry & { est_credits_per_month: number }> = [];
  const suspended: string[] = [];
  const missingEstimates: string[] = [];

  for (const agent of input.agent_data) {
    if (agent.is_suspended) {
      suspended.push(agent.agent_name);
      continue;
    }

    if (!agent.est_credits_per_run || agent.est_credits_per_run <= 0) {
      missingEstimates.push(agent.agent_name);
    }

    const creditsPerMonth = agent.est_runs_per_month * agent.est_credits_per_run;
    active.push({
      ...agent,
      est_credits_per_month: creditsPerMonth,
    });
  }

  const fleetTotalBase = active.reduce((sum, a) => sum + a.est_credits_per_month, 0);
  const fleetTotalBuffered = Math.round(fleetTotalBase * (1 + bufferPct));
  const dollarEstimate = (fleetTotalBuffered / 1000) * pricingRate;

  let weekOverWeekDelta: number | null = null;
  let deltaExceedsThreshold = false;
  if (input.previous_buffered_total !== undefined && input.previous_buffered_total > 0) {
    weekOverWeekDelta = fleetTotalBuffered - input.previous_buffered_total;
    const pctChange = Math.abs(weekOverWeekDelta) / input.previous_buffered_total;
    deltaExceedsThreshold = pctChange > DELTA_THRESHOLD;
  }

  const formattedCredits = fleetTotalBuffered.toLocaleString("en-US");
  const formattedDollars = dollarEstimate.toFixed(2);

  const hasPartialData = missingEstimates.length > 0;
  const reportStatusLine = hasPartialData
    ? `Report Status: ⚠️ Partial — Est. monthly burn: ${formattedCredits} credits (~$${formattedDollars}) w/ ${Math.round(bufferPct * 100)}% buffer — ${missingEstimates.length} agent(s) missing estimates`
    : `Report Status: ✅ Complete — Est. monthly burn: ${formattedCredits} credits (~$${formattedDollars}) w/ ${Math.round(bufferPct * 100)}% buffer`;

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const summaryLine = `Last updated: ${dateStr} — Est. monthly: ${formattedCredits} credits (~$${formattedDollars} buffered)`;

  return {
    success: true,
    active_agents: active,
    suspended_agents: suspended,
    fleet_total_base: fleetTotalBase,
    fleet_total_buffered: fleetTotalBuffered,
    dollar_estimate: dollarEstimate,
    buffer_percentage: bufferPct,
    pricing_rate: pricingRate,
    week_over_week_delta: weekOverWeekDelta,
    delta_exceeds_threshold: deltaExceedsThreshold,
    missing_estimates: missingEstimates,
    summary_line: summaryLine,
    report_status_line: reportStatusLine,
  };
}
