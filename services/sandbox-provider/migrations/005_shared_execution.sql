ALTER TABLE runs ADD COLUMN IF NOT EXISTS runtime_nonce text;
ALTER TABLE sandboxes ADD COLUMN IF NOT EXISTS file_operation_recovery_required boolean NOT NULL DEFAULT false;
DROP INDEX IF EXISTS one_active_run_per_sandbox;
CREATE INDEX IF NOT EXISTS active_runs_per_sandbox ON runs(sandbox_id) WHERE status IN ('queued','running','cancelling');
CREATE OR REPLACE FUNCTION enforce_sandbox_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE capacity integer; occupied integer;
BEGIN
 IF NEW.status IN ('queued','running','cancelling') AND (TG_OP='INSERT' OR OLD.status NOT IN ('queued','running','cancelling')) THEN
  SELECT coalesce((profile_snapshot->>'max_concurrent_runs')::integer,1) INTO capacity FROM sandboxes WHERE sandbox_id=NEW.sandbox_id FOR UPDATE;
  SELECT count(*) INTO occupied FROM runs WHERE sandbox_id=NEW.sandbox_id AND status IN ('queued','running','cancelling') AND run_id<>NEW.run_id;
  IF occupied>=capacity THEN RAISE EXCEPTION 'sandbox execution capacity exceeded' USING ERRCODE='23505'; END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS sandbox_capacity ON runs;
CREATE TRIGGER sandbox_capacity BEFORE INSERT OR UPDATE OF status ON runs FOR EACH ROW EXECUTE FUNCTION enforce_sandbox_capacity();
INSERT INTO schema_migrations(version) VALUES(5) ON CONFLICT DO NOTHING;
