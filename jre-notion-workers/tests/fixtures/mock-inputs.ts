/**
 * Shared test data factories for worker tests.
 */
import type {
  WriteAgentDigestInput,
  LogDeadLetterInput,
  CalculateCreditForecastInput,
  AgentCreditEntry,
} from "../../src/shared/types.js";

export function createMockWriteDigestInput(
  overrides: Partial<WriteAgentDigestInput> = {}
): WriteAgentDigestInput {
  return {
    agent_name: "GitHub Insyncerator",
    agent_emoji: "🔄",
    status_type: "sync",
    status_value: "complete",
    run_time_chicago: "2026-02-28T09:00:00-06:00",
    scope: "All open PRs",
    input_versions: "None",
    flagged_items: [],
    actions_taken: { created_tasks: [], updated_tasks: [] },
    summary: "No issues.",
    needs_review: [],
    escalations: [],
    target_database: "docs",
    doc_type: "Agent Digest",
    ...overrides,
  };
}

export function createMockLogDeadLetterInput(
  overrides: Partial<LogDeadLetterInput> = {}
): LogDeadLetterInput {
  return {
    agent_name: "GitHub Insyncerator",
    expected_run_date: "2026-03-06",
    failure_type: "Missing Digest",
    detected_by: "Dead Letter Logger",
    notes: "⚠️ GitHub Insyncerator — no digest found",
    ...overrides,
  };
}

export function createMockAgentCreditData(): AgentCreditEntry[] {
  return [
    { agent_name: "Inbox Manager", est_runs_per_month: 22, est_credits_per_run: 50, is_suspended: false },
    { agent_name: "Morning Briefing", est_runs_per_month: 22, est_credits_per_run: 80, is_suspended: false },
    { agent_name: "Fleet Monitor", est_runs_per_month: 22, est_credits_per_run: 30, is_suspended: false },
    { agent_name: "Template Freshness Watcher", est_runs_per_month: 0, est_credits_per_run: 0, is_suspended: true },
  ];
}

export function createMockCreditForecastInput(
  overrides: Partial<CalculateCreditForecastInput> = {}
): CalculateCreditForecastInput {
  return {
    agent_data: createMockAgentCreditData(),
    ...overrides,
  };
}
