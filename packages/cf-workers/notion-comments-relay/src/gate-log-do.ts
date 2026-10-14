import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.js";
import { GateLogBufferCore, type GateLogStore } from "./gate-log-core.js";
import { readGateLogDailyWriteCap, type GateLogRow } from "./gate-log-ring.js";

/** SQLite-backed store (DO storage writes don't touch the RELAY_KV write budget). */
export class SqlGateLogStore implements GateLogStore {
  constructor(private sql: SqlStorage) {
    sql.exec(
      "CREATE TABLE IF NOT EXISTS rows (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, json TEXT NOT NULL)",
    );
    sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  }
  insert(rowsJson: string[], at: number): void {
    for (const j of rowsJson) this.sql.exec("INSERT INTO rows (at, json) VALUES (?, ?)", at, j);
  }
  count(): number {
    return Number(this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM rows").one().n);
  }
  take(limit: number): { id: number; json: string }[] {
    return this.sql
      .exec<{ id: number; json: string }>("SELECT id, json FROM rows ORDER BY id LIMIT ?", limit)
      .toArray()
      .map((r) => ({ id: Number(r.id), json: String(r.json) }));
  }
  deleteThrough(maxId: number): void {
    this.sql.exec("DELETE FROM rows WHERE id <= ?", maxId);
  }
  pruneTo(max: number): number {
    const over = this.count() - max;
    if (over <= 0) return 0;
    this.sql.exec("DELETE FROM rows WHERE id IN (SELECT id FROM rows ORDER BY id LIMIT ?)", over);
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
    }
  }
}
