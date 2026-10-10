import type { Env } from "../env.js";

const BUF_PREFIX = "daylog:buf:";
const LOCK_TTL_SEC = 30;

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

async function persistPageId(env: Env, key: string, pageId: string): Promise<void> {
  try {
    const raw = await env.RELAY_KV.get(`${BUF_PREFIX}${key}`);
    const buf: string[] = raw ? (JSON.parse(raw) as string[]) : [];
    buf.push(pageId);
    await env.RELAY_KV.put(`${BUF_PREFIX}${key}`, JSON.stringify([...new Set(buf)]), {
      expirationTtl: LOCK_TTL_SEC,
    });
  } catch {
    // KV optional
  }
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
    }
  }
}

export async function runSerializedByKey<T>(
  env: Env,
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

  if (opts.pageId) {
    void persistPageId(env, key, opts.pageId);
  }

  return result;
}

export function resetSerializeKeyMemory(): void {
  memoryLanes.clear();
}
