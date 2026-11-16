ALTER TABLE sandboxes ADD COLUMN IF NOT EXISTS file_operation_pending boolean NOT NULL DEFAULT false;
ALTER TABLE sandboxes ADD COLUMN IF NOT EXISTS file_operation_id text;
CREATE TABLE IF NOT EXISTS file_uploads (
 upload_id text PRIMARY KEY, sandbox_id text NOT NULL REFERENCES sandboxes,
 owner_id text NOT NULL, path text NOT NULL, size_bytes bigint NOT NULL,
 sha256 text NOT NULL, offset_bytes bigint NOT NULL DEFAULT 0,
 status text NOT NULL DEFAULT 'uploading' CHECK(status IN ('uploading','completed')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(sandbox_id,path)
);
INSERT INTO schema_migrations(version) VALUES(4) ON CONFLICT DO NOTHING;
