/**
 * Canonical Notion property names for the Abstract Data workspace.
 */

export const DOC_TYPE_AI_CODEBASE_ASSESSMENT = "AI Codebase Assessment";

/** Status for agent-created Docs that need human triage before appearing on home views. */
export const DOC_TRIAGE_STATUS = "Needs Triage";

/** Default status for agent-created Tasks that represent real in-flight work. */
export const AGENT_TASK_STATUS_IN_PROGRESS = "In progress";

export const TASKS_PROPS = {
  title: "Task Name",
  clients: "Clients",
  projects: "📊 Projects",
  status: "Status",
} as const;

export const DOCS_PROPS = {
  title: "Name",
  documentType: "Document Type",
  clients: "Clients",
  project: "Project",
  status: "Status",
} as const;

/** Time Log property names. */
export const TIME_LOG_PROPS = {
  githubItem: "GitHub Item Sync",
  /** Dead relation to inaccessible GitHub Items collection — read fallback only. */
  legacyGithubItem: "GitHub Item",
  client: "Client",
  project: "Project",
  task: "Task",
  description: "Description",
  hours: "Hours",
  date: "Date",
  source: "Source",
  billingStatus: "Billing Status",
  billable: "Billable",
} as const;

export const TIME_LOG_SOURCE = {
  manual: "Manual",
  prEstimate: "PR estimate",
  auditorEstSuperseded: "Auditor EST (superseded)",
} as const;

export const TIME_LOG_BILLING = {
  unbilled: "Unbilled",
  invoiced: "Invoiced",
  paid: "Paid",
} as const;

/** Read GitHub Item links from a Time Log page (live Sync property, then legacy). */
export function readTimeLogGithubItemIds(
  properties: Record<string, unknown> | undefined
): string[] {
  const sync = readRelationIds(properties, TIME_LOG_PROPS.githubItem);
  if (sync.length > 0) return sync;
  return readRelationIds(properties, TIME_LOG_PROPS.legacyGithubItem);
}

export function normalizeNotionId(id: string): string {
  return id.replace(/-/g, "").toLowerCase();
}

export function readRelationIds(
  properties: Record<string, unknown> | undefined,
  propName: string
): string[] {
  const prop = properties?.[propName];
  if (!prop || typeof prop !== "object" || !("relation" in prop)) return [];
  const rel = (prop as { relation: Array<{ id: string }> | null }).relation;
  return (rel ?? []).map((r) => r.id);
}

export function isAssessmentDocType(docType: string): boolean {
  return docType.trim().toLowerCase() === DOC_TYPE_AI_CODEBASE_ASSESSMENT.toLowerCase();
}

export function isAssessmentTitle(title: string): boolean {
  return /AI Codebase Assessment|Codebase Assessment/i.test(title);
}
