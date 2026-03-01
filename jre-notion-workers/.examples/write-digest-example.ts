/**
 * Example: write-agent-digest — GitHub Insyncerator healthy run.
 * Sync complete, 2 flagged items with task links, 1 created + 1 updated task, 1 escalation.
 * This file is documentation only; does not need to run.
 */
const exampleInput = {
  agent_name: "GitHub Insyncerator",
  agent_emoji: "🔄",
  status_type: "sync" as const,
  status_value: "complete" as const,
  run_time_chicago: "2026-02-28T09:00:00-06:00",
  scope: "All open PRs and recent commits in tracked repos",
  input_versions: "None",
  flagged_items: [
    { description: "PR #42 needs review", task_link: "https://www.notion.so/task-abc123" },
    { description: "Spike in failed CI on main", task_link: "https://www.notion.so/task-def456" },
  ],
  actions_taken: {
    created_tasks: [{ name: "Review PR #42", notion_url: "https://www.notion.so/task-abc123" }],
    updated_tasks: [{ name: "Investigate CI failures", notion_url: "https://www.notion.so/task-def456" }],
  },
  summary: "Synced 3 repos. 2 items flagged, 1 escalation to Client Repo Auditor.",
  needs_review: [],
  escalations: [
    {
      escalated_to: "Client Repo Auditor",
      escalation_reason: "Spike in CI failures may need client repo audit",
      escalation_owner: "Client Repo Auditor",
      handoff_complete: false,
    },
  ],
  target_database: "docs" as const,
  doc_type: "Agent Digest",
};

// Invoke worker (conceptual):
// const result = await worker.execute(exampleInput);
// expect(result.success === true && result.page_url && result.title.includes('GitHub Sync'));
