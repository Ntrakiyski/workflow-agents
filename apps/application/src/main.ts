import { configuration } from "./config.js";
import { Database } from "./database.js";
import { S3Objects } from "./storage.js";
import { HttpExecutionServices } from "./remote.js";
import { createApi } from "./api.js";
import { RequestWorker } from "./worker.js";
import { initializeStorage } from "./initialize.js";

const config = configuration();
const db = new Database(config.databaseUrl);
const objects = new S3Objects(config);
const api = createApi(db, objects, config);
await db.migrate();
if (process.env.INITIALIZE_STORAGE === "true") {
  await initializeStorage(
    config,
    objects,
    process.env.RUNTIME_BUNDLE_URL ?? "",
  );
}
await objects.ready();
const worker = new RequestWorker(
  db,
  objects,
  new HttpExecutionServices(config),
  config,
  api.log,
);
await api.listen({ port: config.port, host: "0.0.0.0" });
worker.start();
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await worker.close();
  await api.close();
  await db.pool.end();
  objects.close();
}
process.on("SIGTERM", () => {
  void close();
});
process.on("SIGINT", () => {
  void close();
});
