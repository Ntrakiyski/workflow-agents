CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS sandboxes (
 sandbox_id text PRIMARY KEY, owner_id text NOT NULL, owner_ref text NOT NULL,
 profile text NOT NULL, profile_snapshot jsonb NOT NULL,
 runtime_name text NOT NULL UNIQUE, runtime_id text, disk_ref text,
 status text NOT NULL CHECK(status IN ('creating','running','stopping','stopped','failed','destroying','destroyed')),
 active_run_id text, error jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,owner_ref)
);
CREATE TABLE IF NOT EXISTS runs (
 run_id text PRIMARY KEY, sandbox_id text NOT NULL REFERENCES sandboxes, owner_id text NOT NULL,
 execution_ref text NOT NULL, profile text NOT NULL, request jsonb NOT NULL, profile_snapshot jsonb NOT NULL,
 status text NOT NULL CHECK(status IN ('queued','running','cancelling','completed','failed','cancelled','timed_out')),
 runtime_execution_id text, result jsonb, error jsonb, correlation_id text NOT NULL, actor_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz,
 UNIQUE(owner_id,sandbox_id,execution_ref)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_run_per_sandbox ON runs(sandbox_id) WHERE status IN ('queued','running','cancelling');
CREATE TABLE IF NOT EXISTS idempotency (
 owner_id text NOT NULL, operation text NOT NULL, key text NOT NULL,
 fingerprint text NOT NULL, resource_id text NOT NULL, PRIMARY KEY(owner_id,operation,key)
);
CREATE TABLE IF NOT EXISTS audit_events (
 sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 event_id text NOT NULL UNIQUE, sandbox_id text NOT NULL REFERENCES sandboxes, run_id text,
 type text NOT NULL, status text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(),
 correlation_id text NOT NULL, actor_id text NOT NULL, owner_id text NOT NULL, detail jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_sandbox_order ON audit_events(sandbox_id,sequence);
CREATE OR REPLACE FUNCTION audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit events are append-only'; END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='audit_no_mutation') THEN
 CREATE TRIGGER audit_no_mutation BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION audit_immutable();
 END IF;
END $$;
INSERT INTO schema_migrations(version) VALUES(1) ON CONFLICT DO NOTHING;
