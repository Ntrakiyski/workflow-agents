import pg from "pg";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runMigrations } from "graphile-worker";
import type { Sql } from "./types.js";
import { graphileLogger, stdoutSink, type LogSink } from "./log.js";
export function createPool(url: string, max = 12, queryTimeoutMs = 5000) {
  const pool = new pg.Pool({
    connectionString: url,
    max,
    connectionTimeoutMillis: queryTimeoutMs,
    query_timeout: queryTimeoutMs,
    idleTimeoutMillis: 10000,
  });
  pool.on("error", () => {});
  pool.on("connect", (client) => {
    client.on("error", () => {});
  });
  return pool;
}
export async function migrate(pool: pg.Pool, sink: LogSink = stdoutSink) {
  await runMigrations({
    pgPool: pool,
    logger: graphileLogger(sink),
    noHandleSignals: true,
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('runner:migrations',0))",
    );
    await client.query(
      await readFile(
        fileURLToPath(
          new URL("../migrations/001_initial.sql", import.meta.url),
        ),
        "utf8",
      ),
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
export async function transaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
export async function queue(
  sql: Sql,
  task: string,
  id: string,
  at = new Date(),
  priority = 0,
) {
  await sql.query(
    "SELECT graphile_worker.add_job($1,$2::json,run_at:=$3,priority:=$4,max_attempts:=25)",
    [task, JSON.stringify({ id }), at, priority],
  );
}
