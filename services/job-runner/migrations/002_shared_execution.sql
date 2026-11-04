ALTER TABLE runner.jobs ADD COLUMN IF NOT EXISTS sandbox_capacity integer NOT NULL DEFAULT 1 CHECK(sandbox_capacity BETWEEN 1 AND 8);
DROP INDEX IF EXISTS runner.one_active_dispatch;
DROP INDEX IF EXISTS runner.one_active_sandbox;
CREATE INDEX IF NOT EXISTS active_sandbox_jobs ON runner.jobs(sandbox_id) WHERE status IN ('dispatching','running','cancelling');
CREATE OR REPLACE FUNCTION runner.enforce_sandbox_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE occupied integer; lowest integer;
BEGIN
 IF NEW.status IN ('dispatching','running','cancelling') AND (TG_OP='INSERT' OR OLD.status NOT IN ('dispatching','running','cancelling')) THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('runner:capacity',0));
  SELECT count(*),coalesce(min(sandbox_capacity),NEW.sandbox_capacity) INTO occupied,lowest FROM runner.jobs
    WHERE status IN ('dispatching','running','cancelling') AND job_id<>NEW.job_id AND
      ((owner_id=NEW.owner_id AND dispatch_key=NEW.dispatch_key) OR (sandbox_id=NEW.sandbox_id AND NEW.sandbox_id IS NOT NULL));
  IF occupied>=least(NEW.sandbox_capacity,lowest) THEN RAISE EXCEPTION 'sandbox execution capacity exceeded' USING ERRCODE='23505'; END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS sandbox_capacity ON runner.jobs;
CREATE TRIGGER sandbox_capacity BEFORE INSERT OR UPDATE OF status ON runner.jobs FOR EACH ROW EXECUTE FUNCTION runner.enforce_sandbox_capacity();
INSERT INTO runner.schema_migrations(version) VALUES(2) ON CONFLICT DO NOTHING;
