import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config.js";
import type { S3Objects } from "./storage.js";

const approvedSources = new Map([
  [
    "9ffbbd3ed2856013192049986f1062396e46461aa81998f607eaeda9acb3d033",
    "https://github.com/Ntrakiyski/workflow-agents/releases/download/pi-document-runtime-v0.1.0-rc.1/runtime-bundle.tar.gz",
  ],
  [
    "08a6dda2a800958428a2089639c721b19bf866d83e55976c8cf2ef167772094a",
    "https://github.com/Ntrakiyski/workflow-agents/releases/download/pi-document-runtime-v0.1.0-rc.2/runtime-bundle.tar.gz",
  ],
]);
const maxBundleBytes = 256 * 1024 * 1024;

/** Optional operator bootstrap; never invoked by a browser request. */
export async function initializeStorage(
  config: Config,
  objects: S3Objects,
  source: string,
) {
  if (source !== approvedSources.get(config.runtimeBundleSha256))
    throw new Error("Unapproved runtime distribution source");
  try {
    await objects.client.send(
      new HeadBucketCommand({ Bucket: config.s3Bucket }),
    );
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !["NotFound", "NoSuchBucket"].includes(error.name)
    )
      throw error;
    await objects.client.send(
      new CreateBucketCommand({ Bucket: config.s3Bucket }),
    );
  }
  try {
    const existing = await objects.get(config.runtimeBundleKey, maxBundleBytes);
    if (
      createHash("sha256").update(existing).digest("hex") !==
      config.runtimeBundleSha256
    )
      throw new Error(
        "Existing runtime object does not match the approved checksum",
      );
    return;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !["NoSuchKey", "NotFound"].includes(error.name)
    )
      throw error;
  }
  const directory = await mkdtemp(join(tmpdir(), "workflow-runtime-"));
  try {
    const path = join(directory, "bundle.tar.gz");
    const file = await open(path, "wx", 0o600);
    const hash = createHash("sha256");
    let bytes = 0;
    try {
      const response = await fetch(source, {
        signal: AbortSignal.timeout(180000),
      });
      if (!response.ok || !response.body)
        throw new Error("Runtime distribution unavailable");
      const reader = response.body.getReader();
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.length;
        if (bytes > maxBundleBytes) {
          await reader.cancel();
          throw new Error("Runtime distribution exceeds configured bound");
        }
        hash.update(next.value);
        // FileHandle.write may perform a partial write; writeFile handles it.
        await file.writeFile(next.value);
      }
    } finally {
      await file.close();
    }
    if (bytes === 0 || hash.digest("hex") !== config.runtimeBundleSha256)
      throw new Error("Runtime distribution checksum mismatch");
    try {
      await objects.client.send(
        new PutObjectCommand({
          Bucket: config.s3Bucket,
          Key: config.runtimeBundleKey,
          Body: createReadStream(path),
          ContentLength: bytes,
          ContentType: "application/gzip",
          Metadata: { sha256: config.runtimeBundleSha256 },
          IfNoneMatch: "*",
        }),
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !["PreconditionFailed", "ConditionalRequestConflict"].includes(
          error.name,
        )
      )
        throw error;
      const current = await objects.get(
        config.runtimeBundleKey,
        maxBundleBytes,
      );
      if (
        createHash("sha256").update(current).digest("hex") !==
        config.runtimeBundleSha256
      )
        throw new Error("Runtime publication conflict");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
