/** GitHub service-container setup; never starts Docker or uses retained data. */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import pg from "pg";
import { ListBucketsCommand, S3Client } from "@aws-sdk/client-s3";
import { configSchema } from "../src/config.ts";

if (process.env.GITHUB_ACTIONS !== "true") {
  throw new Error("This setup requires an isolated GitHub Actions job.");
}
const writeOnly = process.argv[2] === "--write-only";
if (process.argv.length > (writeOnly ? 3 : 2)) {
  throw new Error("Only --write-only is supported.");
}
function port(name) {
  const value = process.env[name];
  if (!/^\d+$/.test(value ?? "") || +value < 1 || +value > 65535) {
    throw new Error("Explicit disposable service ports are required.");
  }
  return value;
}
const sha = (value) => createHash("sha256").update(value).digest("hex");
const config = configSchema.parse({
  databaseUrl: `postgresql://app_test:ci-disposable-only@127.0.0.1:${port("APP_CI_POSTGRES_PORT")}/workflow_app_test`,
  publicOrigin: "http://127.0.0.1:8082",
  port: 8082,
  users: ["alice", "bob"].map((username) => ({
    username,
    owner_id: username,
    password_sha256: sha("application-integration-password"),
  })),
  s3Endpoint: `http://127.0.0.1:${port("APP_CI_S3_PORT")}`,
  s3Region: "us-east-1",
  s3Bucket: "application-test",
  s3AccessKey: "workflow-ci-only",
  s3SecretKey: "workflow-ci-disposable-secret",
  runnerUrl: "http://127.0.0.1:39998",
  runnerToken: "ci-only-unused-runner",
  providerUrl: "http://127.0.0.1:39999",
  providerToken: "ci-only-unused-provider",
  sandboxProfile: "fixture:v1",
  workloadProfile: "pi-document-agent:v1",
  runtimeBundleKey: "runtime/test.tar.gz",
  runtimeBundleSha256: sha("test runtime"),
});

if (!writeOnly) {
  const storage = new S3Client({
    endpoint: config.s3Endpoint,
    region: config.s3Region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.s3AccessKey,
      secretAccessKey: config.s3SecretKey,
    },
    maxAttempts: 1,
  });
  try {
    const deadline = Date.now() + 90000;
    for (;;) {
      const database = new pg.Client({
        connectionString: config.databaseUrl,
        connectionTimeoutMillis: 2000,
        query_timeout: 2000,
      });
      try {
        await database.connect();
        await database.query("SELECT 1");
        await storage.send(new ListBucketsCommand({}), {
          abortSignal: AbortSignal.timeout(2000),
        });
        break;
      } catch {
        if (Date.now() >= deadline) {
          throw new Error("Disposable PostgreSQL/RustFS readiness timed out.");
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } finally {
        await database.end();
      }
    }
  } finally {
    storage.destroy();
  }
}

const directory = new URL("../private/test/", import.meta.url);
await mkdir(directory, { recursive: true, mode: 0o700 });
await writeFile(new URL("config.json", directory), JSON.stringify(config), {
  mode: 0o600,
  flag: "wx",
});
console.log(
  writeOnly
    ? "Disposable CI configuration validated; service connectivity not checked."
    : "Disposable PostgreSQL/RustFS ready; private CI configuration validated.",
);
