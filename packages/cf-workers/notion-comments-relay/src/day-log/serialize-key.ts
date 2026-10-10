import type { Env } from "../env.js";

export interface SerializedWorkContext {
  pageIds: string[];
}

type WorkFn<T> = (ctx: SerializedWorkContext) => Promise<T>;

interface Waiter<T> {
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
  work: WorkFn<T>;
}

interface MemoryLane {
  drainScheduled: boolean;
  running: boolean;
  pendingPageIds: string[];
  waiters: Waiter<unknown>[];
}

const memoryLanes = new Map<string, MemoryLane>();

function laneFor(key: string): MemoryLane {
  let lane = memoryLanes.get(key);
  if (!lane) {
    lane = { drainScheduled: false, running: false, pendingPageIds: [], waiters: [] };
    memoryLanes.set(key, lane);
  }
  return lane;
}

function deleteLaneIfIdle(key: string, lane: MemoryLane): void {
  if (!lane.running && lane.waiters.length === 0 && lane.pendingPageIds.length === 0) {
    memoryLanes.delete(key);
  }
}

function scheduleDrain(key: string): void {
  const lane = laneFor(key);
  if (lane.drainScheduled || lane.running) {
    return;
  }
  lane.drainScheduled = true;
  queueMicrotask(() => {
    lane.drainScheduled = false;
    void drainMemoryLane(key);
  });
}

async function drainMemoryLane(key: string): Promise<void> {
  const lane = laneFor(key);
  if (lane.running) {
    return;
  }
  lane.running = true;
  try {
    while (lane.waiters.length > 0) {
      const batch = lane.waiters.splice(0);
      const batchIds = [...new Set(lane.pendingPageIds)];
      lane.pendingPageIds = [];
      const leader = batch[0];
      if (!leader) {
        break;
      }
      try {
        // Followers' work functions are ignored; leader work must be identical and idempotent.
        const value = await leader.work({ pageIds: batchIds });
        for (const w of batch) {
          w.resolve(value);
        }
      } catch (e) {
        for (const w of batch) {
          w.reject(e);
        }
      }
    }
  } finally {
    lane.running = false;
    if (lane.waiters.length > 0) {
      scheduleDrain(key);
    } else {
      deleteLaneIfIdle(key, lane);
    }
  }
}

/**
 * Per-isolate serialization only. Does not coordinate across Worker isolates or requests.
 * Callers must pass the same `work` for every waiter on a key; only the leader's work runs.
 */
export async function runSerializedByKey<T>(
  _env: Env,
  key: string,
  opts: { pageId?: string },
  work: WorkFn<T>,
): Promise<T> {
  const lane = laneFor(key);
  if (opts.pageId) {
    lane.pendingPageIds.push(opts.pageId);
  }

  const result = await new Promise<T>((resolve, reject) => {
    lane.waiters.push({
      resolve: (v) => resolve(v as T),
      reject,
      work: work as WorkFn<unknown>,
    });
    scheduleDrain(key);
  });

  deleteLaneIfIdle(key, lane);
  return result;
}

export function resetSerializeKeyMemory(): void {
  memoryLanes.clear();
}
