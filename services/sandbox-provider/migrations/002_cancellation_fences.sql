CREATE TABLE IF NOT EXISTS cancellation_fences (
 sandbox_id text NOT NULL REFERENCES sandboxes, execution_ref text NOT NULL, owner_id text NOT NULL,
 actor_id text NOT NULL, correlation_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(sandbox_id,execution_ref)
);
INSERT INTO schema_migrations(version) VALUES(2) ON CONFLICT DO NOTHING;
