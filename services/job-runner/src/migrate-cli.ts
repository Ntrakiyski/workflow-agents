import { createPool, migrate } from "./db.js";
import { log, stdoutSink } from "./log.js";
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL required");
  const pool = createPool(url);
  try {
    await migrate(pool);
    console.log(
      JSON.stringify({
        service: "job-runner",
        action: "migrations",
        outcome: "ok",
      }),
    );
  } finally {
    await pool.end();
  }
}
void main().catch(() => {
  log(stdoutSink, {
    action: "migrations.failed",
    outcome: "failed",
    error_classification: "migration_failed",
  });
  process.exit(1);
});
