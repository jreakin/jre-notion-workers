import { describe, expect, it } from "bun:test";
import { executeCalculateCreditForecast } from "../../src/workers/calculate-credit-forecast.js";
import { createMockCreditForecastInput, createMockAgentCreditData } from "../fixtures/mock-inputs.js";

describe("calculate-credit-forecast", () => {
  it("returns error for empty agent_data", () => {
    const result = executeCalculateCreditForecast({ agent_data: [] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("agent_data");
    }
  });

  it("calculates correct totals for active agents", () => {
    const result = executeCalculateCreditForecast(createMockCreditForecastInput());
    expect(result.success).toBe(true);
    if (result.success) {
      // Active: Inbox (22*50=1100), Morning (22*80=1760), Fleet (22*30=660) = 3520 base
      expect(result.fleet_total_base).toBe(3520);
      // Buffered: 3520 * 1.20 = 4224
      expect(result.fleet_total_buffered).toBe(4224);
      // Dollar: 4224 / 1000 * 10 = 42.24
      expect(result.dollar_estimate).toBeCloseTo(42.24, 2);
      expect(result.active_agents).toHaveLength(3);
      expect(result.suspended_agents).toEqual(["Template Freshness Watcher"]);
    }
  });

  it("separates suspended agents correctly", () => {
    const result = executeCalculateCreditForecast(createMockCreditForecastInput());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.suspended_agents).toContain("Template Freshness Watcher");
      const activeNames = result.active_agents.map((a) => a.agent_name);
      expect(activeNames).not.toContain("Template Freshness Watcher");
    }
  });

  it("computes per-agent credits correctly", () => {
    const result = executeCalculateCreditForecast(createMockCreditForecastInput());
    expect(result.success).toBe(true);
    if (result.success) {
      const inbox = result.active_agents.find((a) => a.agent_name === "Inbox Manager");
      expect(inbox?.est_credits_per_month).toBe(22 * 50);
      const morning = result.active_agents.find((a) => a.agent_name === "Morning Briefing");
      expect(morning?.est_credits_per_month).toBe(22 * 80);
    }
  });

  it("calculates week-over-week delta when previous total is provided", () => {
    const result = executeCalculateCreditForecast(
      createMockCreditForecastInput({ previous_buffered_total: 4000 })
    );
    expect(result.success).toBe(true);
    if (result.success) {
      // 4224 - 4000 = 224
      expect(result.week_over_week_delta).toBe(224);
      // 224/4000 = 5.6% — under 10% threshold
      expect(result.delta_exceeds_threshold).toBe(false);
    }
  });

  it("flags delta exceeding 10% threshold", () => {
    const result = executeCalculateCreditForecast(
      createMockCreditForecastInput({ previous_buffered_total: 3000 })
    );
    expect(result.success).toBe(true);
    if (result.success) {
      // 4224 - 3000 = 1224
      // 1224/3000 = 40.8% — over 10% threshold
      expect(result.delta_exceeds_threshold).toBe(true);
    }
  });

  it("returns null delta when no previous total", () => {
    const result = executeCalculateCreditForecast(createMockCreditForecastInput());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.week_over_week_delta).toBeNull();
      expect(result.delta_exceeds_threshold).toBe(false);
    }
  });

  it("flags agents with missing estimates (zero credits_per_run)", () => {
    const data = createMockAgentCreditData();
    // Set one active agent's credits to 0
    const inbox = data.find((a) => a.agent_name === "Inbox Manager");
    if (inbox) inbox.est_credits_per_run = 0;

    const result = executeCalculateCreditForecast({ agent_data: data });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.missing_estimates).toContain("Inbox Manager");
    }
  });

  it("uses custom pricing rate and buffer", () => {
    const result = executeCalculateCreditForecast(
      createMockCreditForecastInput({
        pricing_rate: 15.0,
        buffer_percentage: 0.30,
      })
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.pricing_rate).toBe(15.0);
      expect(result.buffer_percentage).toBe(0.30);
      // 3520 * 1.30 = 4576
      expect(result.fleet_total_buffered).toBe(4576);
      // 4576 / 1000 * 15 = 68.64
      expect(result.dollar_estimate).toBeCloseTo(68.64, 2);
    }
  });

  it("generates correct report status line", () => {
    const result = executeCalculateCreditForecast(createMockCreditForecastInput());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.report_status_line).toContain("Report Status: ✅ Complete");
      expect(result.report_status_line).toContain("4,224 credits");
      expect(result.report_status_line).toContain("$42.24");
      expect(result.report_status_line).toContain("20% buffer");
    }
  });

  it("generates partial report status when estimates are missing", () => {
    const data = createMockAgentCreditData();
    const inbox = data.find((a) => a.agent_name === "Inbox Manager");
    if (inbox) inbox.est_credits_per_run = 0;

    const result = executeCalculateCreditForecast({ agent_data: data });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.report_status_line).toContain("Report Status: ⚠️ Partial");
      expect(result.report_status_line).toContain("missing estimates");
    }
  });

  it("generates summary line with date", () => {
    const result = executeCalculateCreditForecast(createMockCreditForecastInput());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.summary_line).toContain("Last updated:");
      expect(result.summary_line).toContain("Est. monthly:");
    }
  });
});
