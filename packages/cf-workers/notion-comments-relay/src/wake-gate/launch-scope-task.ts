import { normalizeNotionUuid } from "./notion-ids.js";
import type { GateEventContext } from "./gate-event-types.js";
import { PARENT_NAME_TASKS, tasksParentIdsFromEnv } from "./tracked-parent-names.js";
import type { Env } from "../env.js";

const SCOPE_NAME_RE = /scope/i;
const LAUNCH_RE = /launch/i;
const POST_LAUNCH_RE = /post[-\s]?launch/i;

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

/** Launch-scope assignment: Tasks parent + Scope-like value with Launch but not Post-launch. */
export function isLaunchScopeTaskPageCreated(
  ctx: GateEventContext,
  env: Pick<Env, "TASKS_DATA_SOURCE_ID" | "TASKS_DATABASE_ID">,
): boolean {
  const type = ctx.notionType ?? "";
  if (type !== "page.created" && type !== "page.added" && type !== "page_created") return false;
  if (!ctxInTasksDb(ctx, env)) return false;
  const scope = scopeValueFromLabel(ctx.properties?.scopeLabel ?? ctx.properties?.statusLabel);
  if (!scope) return false;
  if (!LAUNCH_RE.test(scope)) return false;
  if (POST_LAUNCH_RE.test(scope)) return false;
  return true;
}

export function readLaunchScopeFromNotionProperties(properties: Record<string, unknown>): {
  scopeLabel?: string;
  statusLabel?: string;
} {
  let scopeLabel: string | undefined;
  let statusLabel: string | undefined;
  for (const [name, raw] of Object.entries(properties)) {
    const prop = asRecord(raw);
    if (!prop) continue;
    if (SCOPE_NAME_RE.test(name)) {
      const v = readSelectOrStatusName(prop);
      if (v) scopeLabel = v;
    }
    if (name.toLowerCase() === "status" && prop.type === "status") {
      const v = readSelectOrStatusName(prop);
      if (v) statusLabel = v;
    }
  }
  return { scopeLabel, statusLabel };
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
