CREATE SCHEMA IF NOT EXISTS runner;
CREATE TABLE IF NOT EXISTS runner.schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS runner.jobs (
 job_id text PRIMARY KEY, owner_id text NOT NULL, actor_id text NOT NULL, correlation_id text NOT NULL,
 client_reference text, payload jsonb NOT NULL, dispatch_key text NOT NULL,
 status text NOT NULL CHECK(status IN ('queued','scheduled','dispatching','running','retry_wait','cancelling','completed','failed','cancelled','timed_out')),
 sandbox_id text, run_id text, attempt_count integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz,
 due_at timestamptz NOT NULL, attempt_started_at timestamptz, cancellation_target text,
 result jsonb, error jsonb
);
CREATE INDEX IF NOT EXISTS jobs_owner_idx ON runner.jobs(owner_id,status);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_dispatch ON runner.jobs(owner_id,dispatch_key) WHERE status IN ('dispatching','running','cancelling');
CREATE UNIQUE INDEX IF NOT EXISTS one_active_sandbox ON runner.jobs(sandbox_id) WHERE sandbox_id IS NOT NULL AND status IN ('dispatching','running','cancelling');
CREATE TABLE IF NOT EXISTS runner.attempts (
 attempt_id text PRIMARY KEY,job_id text NOT NULL REFERENCES runner.jobs(job_id), number integer NOT NULL,
 execution_ref text NOT NULL UNIQUE, provider_key text NOT NULL UNIQUE, run_id text,
 timeout_seconds integer NOT NULL,status text NOT NULL,started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 UNIQUE(job_id,number)
);
CREATE TABLE IF NOT EXISTS runner.schedules (
 schedule_id text PRIMARY KEY, owner_id text NOT NULL,actor_id text NOT NULL,correlation_id text NOT NULL,
 action text NOT NULL CHECK(action IN ('submit_job','stop_sandbox','cancel_job')),payload jsonb NOT NULL,
 status text NOT NULL CHECK(status IN ('pending','fired','cancelled','skipped','failed')),
 run_at timestamptz NOT NULL,job_id text,sandbox_id text,guard_job_id text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),error jsonb
);
CREATE TABLE IF NOT EXISTS runner.idempotency (
 owner_id text NOT NULL,operation text NOT NULL,key text NOT NULL,fingerprint text NOT NULL,
 resource_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner_id,operation,key)
);
CREATE TABLE IF NOT EXISTS runner.audit_events (
 sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,event_id text NOT NULL UNIQUE,owner_id text NOT NULL,actor_id text NOT NULL,
 correlation_id text NOT NULL,target_id text NOT NULL,type text NOT NULL,status text NOT NULL,
 job_id text,sandbox_id text,run_id text,client_reference text,detail jsonb NOT NULL DEFAULT '{}',occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_job_idx ON runner.audit_events(owner_id,job_id,sequence);
CREATE OR REPLACE FUNCTION runner.immutable_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Audit events are immutable'; END $$;
DROP TRIGGER IF EXISTS immutable_audit ON runner.audit_events;
CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON runner.audit_events FOR EACH ROW EXECUTE FUNCTION runner.immutable_audit();
INSERT INTO runner.schema_migrations(version) VALUES(1) ON CONFLICT DO NOTHING;
