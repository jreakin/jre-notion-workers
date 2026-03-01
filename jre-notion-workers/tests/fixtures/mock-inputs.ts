/**
 * Shared test data factories for worker tests.
 */
import type { WriteAgentDigestInput } from "../../src/shared/types.js";

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
