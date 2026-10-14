import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.js";
import { GateLogBufferCore, type GateLogStore } from "./gate-log-core.js";
import { readGateLogDailyWriteCap, type GateLogRow } from "./gate-log-ring.js";

const ROW_COUNT_KEY = "row_count";

/** SQLite-backed store (DO storage writes don't touch the RELAY_KV write budget). */
export class SqlGateLogStore implements GateLogStore {
  constructor(private sql: SqlStorage) {
    sql.exec(
      "CREATE TABLE IF NOT EXISTS rows (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, json TEXT NOT NULL)",
    );
    sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  }
  insert(rowsJson: string[], at: number): void {
    const n = this.count();
    for (const j of rowsJson) this.sql.exec("INSERT INTO rows (at, json) VALUES (?, ?)", at, j);
    this.setCount(n + rowsJson.length);
  }
  /**
   * Running row count kept in `meta` (1 row read) instead of `SELECT COUNT(*)` per call, which
   * bills every stored row as read. Seeded once from COUNT(*) for buffers created before this.
   */
  count(): number {
    const cached = this.getMeta(ROW_COUNT_KEY);
    if (cached !== null) {
      const n = Number.parseInt(cached, 10);
      if (Number.isFinite(n) && n >= 0) return n;
    }
    const n = Number(this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM rows").one().n);
    this.setCount(n);
    return n;
  }
  private setCount(n: number): void {
    this.setMeta(ROW_COUNT_KEY, String(Math.max(0, n)));
  }
  take(limit: number): { id: number; json: string }[] {
    return this.sql
      .exec<{ id: number; json: string }>("SELECT id, json FROM rows ORDER BY id LIMIT ?", limit)
      .toArray()
      .map((r) => ({ id: Number(r.id), json: String(r.json) }));
  }
  deleteThrough(maxId: number, taken: number): void {
    const n = this.count();
    this.sql.exec("DELETE FROM rows WHERE id <= ?", maxId);
    this.setCount(n - taken);
  }
  pruneTo(max: number): number {
    const over = this.count() - max;
    if (over <= 0) return 0;
    this.sql.exec("DELETE FROM rows WHERE id IN (SELECT id FROM rows ORDER BY id LIMIT ?)", over);
    this.setCount(max);
    return over;
  }
  getMeta(key: string): string | null {
    const r = this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = ?", key).toArray()[0];
    return r ? String(r.v) : null;
  }
  setMeta(key: string, value: string): void {
    this.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", key, value);
  }
}

/** Single instance: `env.GATE_LOG_DO.get(env.GATE_LOG_DO.idFromName("gate_log"))`. */
export class GateLogBuffer extends DurableObject<Env> {
  private core: GateLogBufferCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const storage = ctx.storage;
    this.core = new GateLogBufferCore(
      new SqlGateLogStore(storage.sql),
      env.RELAY_KV,
      { get: () => storage.getAlarm(), set: (at) => storage.setAlarm(at) },
      readGateLogDailyWriteCap(env),
    );
  }

  async append(rows: GateLogRow[]): Promise<{ stored: number }> {
    return this.core.append(rows);
  }

  async alarm(): Promise<void> {
    try {
      await this.core.onAlarm();
    } catch (err) {
      console.log(JSON.stringify({ event: "gate_log_do_alarm_error", error: err instanceof Error ? err.name : "Error" }));
      // Nothing is pending while the handler runs; re-arm so a backlog isn't stranded until the next append.
      try {
        await this.core.rearmAfterError();
      } catch {
        // storage itself is failing; Cloudflare's alarm retry is the only remaining path
        throw err;
      }
    }
  }
}
