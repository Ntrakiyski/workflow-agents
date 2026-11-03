ALTER TABLE sandboxes ADD COLUMN IF NOT EXISTS runtime_backend text NOT NULL DEFAULT 'boxlite-local';
ALTER TABLE sandboxes ADD COLUMN IF NOT EXISTS runtime_create_attempted boolean NOT NULL DEFAULT false;
INSERT INTO schema_migrations(version) VALUES(3) ON CONFLICT DO NOTHING;
