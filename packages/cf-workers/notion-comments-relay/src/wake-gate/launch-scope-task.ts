import { normalizeNotionUuid } from "./notion-ids.js";
import type { GateEventContext } from "./gate-event-types.js";
import { PARENT_NAME_TASKS, tasksParentIdsFromEnv } from "./tracked-parent-names.js";
import type { Env } from "../env.js";

const LAUNCH_SCOPE_PROP_RE = /^launch\s*scope$/i;
const SCOPE_NAME_RE = /scope/i;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function scopeValueFromLabel(label: string | undefined): string | undefined {
  if (!label) return undefined;
  const trimmed = label.trim();
  return trimmed || undefined;
}

function ctxInTasksDb(ctx: GateEventContext, env: Pick<Env, "TASKS_DATA_SOURCE_ID" | "TASKS_DATABASE_ID">): boolean {
  if (ctx.parentDbConfigName === PARENT_NAME_TASKS) return true;
  const ids = tasksParentIdsFromEnv(env);
  const parentIds = [ctx.webhookParentDataSourceId, ctx.webhookParentDatabaseId].filter(Boolean) as string[];
  return parentIds.some((id) => ids.has(normalizeNotionUuid(id)));
}

function isLaunchScopeValue(value: string | undefined): boolean {
  if (!value) return false;
  const t = value.trim();
  if (/^post[-\s]?launch$/i.test(t)) return false;
  return t === "Launch";
}

/** Launch-scope assignment: Tasks parent + Launch Scope (or Scope-like) select/status equals Launch. */
export function isLaunchScopeTaskPageCreated(
  ctx: GateEventContext,
  env: Pick<Env, "TASKS_DATA_SOURCE_ID" | "TASKS_DATABASE_ID">,
): boolean {
  const type = ctx.notionType ?? "";
  if (type !== "page.created" && type !== "page.added" && type !== "page_created") return false;
  if (!ctxInTasksDb(ctx, env)) return false;
  const scope = scopeValueFromLabel(ctx.properties?.launchScopeLabel ?? ctx.properties?.scopeLabel);
  return isLaunchScopeValue(scope);
}

export function readLaunchScopeFromNotionProperties(properties: Record<string, unknown>): {
  launchScopeLabel?: string;
  scopeLabel?: string;
  statusLabel?: string;
} {
  let launchScopeLabel: string | undefined;
  let scopeLabel: string | undefined;
  let statusLabel: string | undefined;
  for (const [name, raw] of Object.entries(properties)) {
    const prop = asRecord(raw);
    if (!prop) continue;
    const v = readSelectOrStatusName(prop);
    if (!v) continue;
    if (LAUNCH_SCOPE_PROP_RE.test(name)) launchScopeLabel = v;
    else if (SCOPE_NAME_RE.test(name)) scopeLabel = v;
    else if (name.toLowerCase() === "status" && prop.type === "status") statusLabel = v;
  }
  return { launchScopeLabel, scopeLabel, statusLabel };
}

function readSelectOrStatusName(prop: Record<string, unknown>): string | undefined {
  if (prop.type === "select") {
    const sel = asRecord(prop.select);
    return typeof sel?.name === "string" ? sel.name : undefined;
  }
  if (prop.type === "status") {
    const st = asRecord(prop.status);
    return typeof st?.name === "string" ? st.name : undefined;
  }
  return undefined;
}
