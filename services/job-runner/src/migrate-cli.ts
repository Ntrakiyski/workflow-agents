import { createPool, migrate } from "./db.js";
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
