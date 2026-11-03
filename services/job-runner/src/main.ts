import { loadConfig } from "./config.js";
import { createPool, migrate } from "./db.js";
import { Service } from "./service.js";
import { Worker } from "./worker.js";
import { createApi } from "./api.js";
import { createLogSink, log } from "./log.js";
const config = loadConfig();
const sink = createLogSink(config.logLevel);
const pool = createPool(
  config.databaseUrl,
  config.databasePoolSize,
  config.databaseQueryTimeoutMs,
);
await migrate(pool, sink);
const service = new Service(pool, config, sink);
const worker = new Worker(service);
const api = createApi(service, () => worker.active);
await worker.start();
await api.listen({ host: config.host, port: config.port });
log(sink, {
  action: "service.started",
  outcome: "ok",
  version: "1.0.0-rc.1",
});
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  log(sink, { action: "service.stopping", outcome: "ok" });
  await api.close();
  await worker.stop();
  await pool.end();
};
process.on("SIGTERM", () => void close());
process.on("SIGINT", () => void close());
