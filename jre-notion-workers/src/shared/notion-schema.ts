/**
 * Canonical Notion property names and IDs for the Abstract Data workspace.
 * GitHub Items (Sync) uses emoji-prefixed relation names; legacy GitHub Items
 * collection (8c8a07b9…) used Client / Project / Task.
 */

/** Dead GitHub Items collection — Time Log must not point here. */
export const DEAD_GITHUB_ITEMS_DATABASE_ID = "8c8a07b98ac945fb85729bfc2cf3a18e";

/** Live GitHub Items (Sync) collection. */
export const LIVE_GITHUB_ITEMS_DATABASE_ID = "3e7899481fee4af2ac077e462e5c1e3e";

export const DOC_TYPE_AI_CODEBASE_ASSESSMENT = "AI Codebase Assessment";

/** Status for agent-created Docs that need human triage before appearing on home views. */
export const DOC_TRIAGE_STATUS = "Needs Triage";

/** Default status for agent-created Tasks that represent real in-flight work. */
export const AGENT_TASK_STATUS_IN_PROGRESS = "In progress";

export const GITHUB_ITEMS_PROPS = {
  clients: "Clients",
  projects: "📊 Projects",
  tasks: "✅ Tasks",
} as const;

/** Legacy GitHub Items property names — read fallback only. */
export const LEGACY_GITHUB_ITEMS_PROPS = {
  client: "Client",
  project: "Project",
  task: "Task",
} as const;

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

export function normalizeNotionId(id: string): string {
  return id.replace(/-/g, "").toLowerCase();
}

export function isDeadGitHubItemsDatabaseId(databaseId: string): boolean {
  return normalizeNotionId(databaseId) === normalizeNotionId(DEAD_GITHUB_ITEMS_DATABASE_ID);
}

export function isLiveGitHubItemsDatabaseId(databaseId: string): boolean {
  return normalizeNotionId(databaseId) === normalizeNotionId(LIVE_GITHUB_ITEMS_DATABASE_ID);
}

/** Read relation page IDs, trying live Sync names first then legacy fallbacks. */
export function readRelationIdsWithFallback(
  properties: Record<string, unknown> | undefined,
  primaryName: string,
  legacyName?: string
): string[] {
  const primary = readRelationIds(properties, primaryName);
  if (primary.length > 0) return primary;
  if (legacyName) return readRelationIds(properties, legacyName);
  return [];
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

export function readGitHubItemClientIds(
  properties: Record<string, unknown> | undefined
): string[] {
  return readRelationIdsWithFallback(
    properties,
    GITHUB_ITEMS_PROPS.clients,
    LEGACY_GITHUB_ITEMS_PROPS.client
  );
}

export function readGitHubItemProjectIds(
  properties: Record<string, unknown> | undefined
): string[] {
  return readRelationIdsWithFallback(
    properties,
    GITHUB_ITEMS_PROPS.projects,
    LEGACY_GITHUB_ITEMS_PROPS.project
  );
}

export function readGitHubItemTaskIds(
  properties: Record<string, unknown> | undefined
): string[] {
  return readRelationIdsWithFallback(
    properties,
    GITHUB_ITEMS_PROPS.tasks,
    LEGACY_GITHUB_ITEMS_PROPS.task
  );
}

/** Write only forward Project relation on GitHub Items — never Clients (reverse bloat). */
export function buildGitHubItemProjectRelation(
  projectIds: string[]
): Record<string, unknown> | null {
  if (projectIds.length === 0) return null;
  return {
    [GITHUB_ITEMS_PROPS.projects]: {
      relation: projectIds.map((id) => ({ id })),
    },
  };
}

export function isAssessmentDocType(docType: string): boolean {
  return docType.trim().toLowerCase() === DOC_TYPE_AI_CODEBASE_ASSESSMENT.toLowerCase();
}

export function isAssessmentTitle(title: string): boolean {
  return /AI Codebase Assessment|Codebase Assessment/i.test(title);
}
