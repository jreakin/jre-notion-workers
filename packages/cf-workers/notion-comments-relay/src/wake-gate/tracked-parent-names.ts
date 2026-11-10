/**
 * Config names for the parents this Worker knows about, used for the Clef state `parent_db` line.
 * Names come from config only (named code constants + tracked id lists), never from Notion titles, so
 * the state string carries no title the config doesn't already hold.
 *
 *   Fleet Locks (FLEET_LOCKS_DATA_SOURCE_ID / FLEET_LOCKS_DATABASE_ID) → "Fleet: Locks"
 *   AD Docs (AD_DOCS_DATA_SOURCE_ID / AD_DOCS_DATABASE_ID)             → "AD Docs"
 *   Fleet: Artifacts (FLEET_ARTIFACTS_DATA_SOURCE_ID), when tracked    → "Fleet: Artifacts"
 *   Tasks (TASKS_DATA_SOURCE_ID / TASKS_DATABASE_ID)                   → "Tasks"
 *   any other TRACKED_DATA_SOURCE_IDS / TRACKED_PARENT_IDS entry       → "tracked"
 *   anything else                                                       → undefined (caller falls back)
 */
import type { Env } from "../env.js";
import { echoFilterConfigFromEnv, FLEET_ARTIFACTS_DATA_SOURCE_ID } from "./echo-filter-config.js";
import { normalizeNotionUuid } from "./notion-ids.js";
import { AD_DOCS_DATA_SOURCE_ID, DEFAULT_TASKS_DATA_SOURCE_ID } from "./wake-gate-types.js";

export const PARENT_NAME_FLEET_LOCKS = "Fleet: Locks";
export const PARENT_NAME_AD_DOCS = "AD Docs";
export const PARENT_NAME_FLEET_ARTIFACTS = "Fleet: Artifacts";
export const PARENT_NAME_TRACKED = "tracked";
export const PARENT_NAME_TASKS = "Tasks";

function addId(map: Map<string, string>, id: unknown, name: string): void {
  if (typeof id === "string" && id.trim()) {
    const key = normalizeNotionUuid(id);
    if (!map.has(key)) map.set(key, name);
  }
}

export function tasksDataSourceId(env: Pick<Env, "TASKS_DATA_SOURCE_ID">): string {
  const raw = env.TASKS_DATA_SOURCE_ID?.trim();
  return raw && raw.length > 0 ? raw : DEFAULT_TASKS_DATA_SOURCE_ID;
}

export function tasksParentIdsFromEnv(env: Pick<Env, "TASKS_DATA_SOURCE_ID" | "TASKS_DATABASE_ID">): Set<string> {
  const out = new Set<string>();
  addId(out as unknown as Map<string, string>, tasksDataSourceId(env), PARENT_NAME_TASKS);
  if (env.TASKS_DATABASE_ID?.trim()) {
    out.add(normalizeNotionUuid(env.TASKS_DATABASE_ID));
  }
  return out;
}

/** Normalized parent id → config name. */
export function trackedParentNameMap(env: Partial<Env>): Map<string, string> {
  const map = new Map<string, string>();
  addId(map, env.FLEET_LOCKS_DATA_SOURCE_ID, PARENT_NAME_FLEET_LOCKS);
  addId(map, env.FLEET_LOCKS_DATABASE_ID, PARENT_NAME_FLEET_LOCKS);
  addId(map, AD_DOCS_DATA_SOURCE_ID, PARENT_NAME_AD_DOCS);
  addId(map, env.AD_DOCS_DATABASE_ID, PARENT_NAME_AD_DOCS);
  addId(map, tasksDataSourceId(env as Env), PARENT_NAME_TASKS);
  addId(map, env.TASKS_DATABASE_ID, PARENT_NAME_TASKS);
  const tracked = echoFilterConfigFromEnv(env).trackedParentIds;
  if (tracked.has(normalizeNotionUuid(FLEET_ARTIFACTS_DATA_SOURCE_ID))) {
    addId(map, FLEET_ARTIFACTS_DATA_SOURCE_ID, PARENT_NAME_FLEET_ARTIFACTS);
  }
  for (const id of tracked) addId(map, id, PARENT_NAME_TRACKED);
  return map;
}

/** First configured name among `ids` (webhook / fetched parent ids), or undefined. */
export function trackedParentName(
  ids: readonly (string | undefined)[],
  names: ReadonlyMap<string, string>,
): string | undefined {
  for (const id of ids) {
    if (!id) continue;
    const name = names.get(normalizeNotionUuid(id));
    if (name) return name;
  }
  return undefined;
}
