import pg from "pg";
import type { PoolClient } from "pg";
import { fileRow, requestRow, type RequestRow } from "./model.js";
export const migration = `
CREATE SCHEMA IF NOT EXISTS application;
CREATE TABLE IF NOT EXISTS application.requests (
 id uuid PRIMARY KEY, owner_id text NOT NULL, title text NOT NULL, instructions text NOT NULL,
 status text NOT NULL CHECK(status IN ('pending','running','completed','failed')) DEFAULT 'pending',
 submission_key text NOT NULL,fingerprint text NOT NULL,correlation_id text NOT NULL,
 sandbox_id text,job_id text,event_cursor text,final_text text,failure_message text,validation_summary text,
 export_complete boolean NOT NULL DEFAULT false,sandbox_stopped boolean NOT NULL DEFAULT false,terminal_error boolean NOT NULL DEFAULT false,
 attempts integer NOT NULL DEFAULT 0,next_attempt_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(owner_id,submission_key)
);
CREATE INDEX IF NOT EXISTS requests_owner_page ON application.requests(owner_id,created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS application.files (
 id uuid PRIMARY KEY,owner_id text NOT NULL,request_id uuid REFERENCES application.requests(id),
 kind text NOT NULL CHECK(kind IN ('input','output','checkpoint')),name text NOT NULL,media_type text NOT NULL,size_bytes integer NOT NULL,
 sha256 text NOT NULL,object_key text NOT NULL UNIQUE,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(request_id,kind,name)
);
CREATE TABLE IF NOT EXISTS application.audit (
 event_id bigserial PRIMARY KEY,request_id uuid REFERENCES application.requests(id),owner_id text NOT NULL,actor_id text NOT NULL,
 action text NOT NULL,correlation_id text NOT NULL,detail jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS application.runner_events (
 request_id uuid NOT NULL REFERENCES application.requests(id),event_id text NOT NULL,event_type text NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(request_id,event_id)
);
CREATE OR REPLACE FUNCTION application.prevent_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Audit records are append only'; END; $$;
DROP TRIGGER IF EXISTS append_only_audit ON application.audit;
CREATE TRIGGER append_only_audit BEFORE UPDATE OR DELETE ON application.audit FOR EACH ROW EXECUTE FUNCTION application.prevent_audit_mutation();
`;
export class Database {
  readonly pool: pg.Pool;
  constructor(url: string) {
    this.pool = new pg.Pool({
      connectionString: url,
      max: 12,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
      statement_timeout: 15000,
    });
  }
  async migrate() {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(196631,1)");
      await c.query("CREATE SCHEMA IF NOT EXISTS application");
      await c.query(
        "CREATE TABLE IF NOT EXISTS application.schema_migrations(version integer PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())",
      );
      const existing = await c.query(
        "SELECT version FROM application.schema_migrations WHERE version=1",
      );
      if (existing.rowCount === 0) {
        await c.query(migration);
        await c.query(
          "INSERT INTO application.schema_migrations(version) VALUES(1)",
        );
      }
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async transaction<T>(fn: (c: PoolClient) => Promise<T>) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const value = await fn(c);
      await c.query("COMMIT");
      return value;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async ownedRequest(owner: string, id: string) {
    const result = await this.pool.query(
      "SELECT * FROM application.requests WHERE id=$1 AND owner_id=$2",
      [id, owner],
    );
    return result.rows[0] ? requestRow.parse(result.rows[0]) : null;
  }
  async files(requestId: string) {
    const rows = await this.pool.query(
      "SELECT * FROM application.files WHERE request_id=$1 ORDER BY created_at,id",
      [requestId],
    );
    return rows.rows.map((v) => fileRow.parse(v));
  }
  async audit(
    c: Pick<PoolClient, "query">,
    r: Pick<RequestRow, "id" | "owner_id" | "correlation_id">,
    action: string,
    actor = "application-worker",
    detail: Record<string, string | number | boolean> = {},
  ) {
    await c.query(
      "INSERT INTO application.audit(request_id,owner_id,actor_id,action,correlation_id,detail) VALUES($1,$2,$3,$4,$5,$6)",
      [
        r.id,
        r.owner_id,
        actor,
        action,
        r.correlation_id,
        JSON.stringify(detail),
      ],
    );
  }
}
