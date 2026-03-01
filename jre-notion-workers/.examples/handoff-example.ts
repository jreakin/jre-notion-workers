/**
 * Example: create-handoff-marker — GitHub Insyncerator → Client Repo Auditor.
 * create_task: true with task_priority. Circuit breaker prevents duplicate if one exists within 7 days.
 * This file is documentation only; does not need to run.
 */
const exampleInput = {
  source_agent: "GitHub Insyncerator",
  target_agent: "Client Repo Auditor",
  escalation_reason: "Stale spike in CI failures; needs client repo audit",
  source_digest_url: "https://www.notion.so/github-sync-2026-02-28-abc123",
  create_task: true,
  task_priority: "🟡 Medium" as const,
};

// Invoke worker (conceptual):
// const result = await createHandoffMarkerWorker.execute(exampleInput);
// if (result.success) {
//   // Paste result.handoff_block into source agent's Escalations section
//   if (result.duplicate_prevented) use result.existing_task_url
//   if (result.escalation_capped) move item to Needs Manual Review
// }
