import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
export const id = z.uuid();
export const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const iso = z.preprocess(
  (v) => (v instanceof Date ? v.toISOString() : v),
  z.iso.datetime(),
);
export const status = z.enum(["pending", "running", "completed", "failed"]);
export const requestRow = z.object({
  id,
  owner_id: z.string(),
  title: z.string(),
  instructions: z.string(),
  system_prompt: z.string(),
  workspace_id: id.nullable(),
  progress_message: z.string().nullable(),
  status,
  created_at: iso,
  updated_at: iso,
  sandbox_id: z.string().nullable(),
  job_id: z.string().nullable(),
  event_cursor: z.string().nullable(),
  final_text: z.string().nullable(),
  failure_message: z.string().nullable(),
  validation_summary: z.string().nullable(),
  export_complete: z.boolean(),
  sandbox_stopped: z.boolean(),
  terminal_error: z.boolean(),
  attempts: z.number(),
  next_attempt_at: iso,
  correlation_id: z.string(),
});
export type RequestRow = z.infer<typeof requestRow>;
export const fileRow = z.object({
  id,
  owner_id: z.string(),
  request_id: id.nullable(),
  kind: z.enum(["input", "output", "checkpoint"]),
  name: z.string(),
  media_type: z.string(),
  size_bytes: z.number(),
  sha256: sha,
  object_key: z.string(),
  created_at: iso,
});
export type FileRow = z.infer<typeof fileRow>;
export const submitBody = z
  .object({
    instructions: z.string().trim().min(1).max(16000),
    system_prompt: z.string().trim().min(1).max(16000).optional(),
    attachment_ids: z.array(id).max(8).default([]),
  })
  .strict();
export const validation = z
  .object({
    category: z.enum(["structural", "content", "rendered_layout"]),
    status: z.enum(["passed", "failed", "not_performed"]),
    code: z.string().max(128),
    message: z.string().max(2000),
  })
  .strict();
export const artifact = z
  .object({
    path: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    media_type: z.string().max(128),
    size_bytes: z.number().int().min(0).max(MAX_FILE_BYTES),
    sha256: sha,
  })
  .strict();
export const manifest = z
  .object({
    schema_version: z.literal(1),
    request_id: id,
    outcome: z.enum(["completed", "failed"]),
    text: z.string().max(128000),
    artifacts: z.array(artifact).max(16),
    validations: z.array(validation).max(64),
    session_files: z
      .array(
        z
          .object({
            path: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
            media_type: z.literal("application/x-ndjson"),
            sha256: sha,
            size_bytes: z.number().int().min(0).max(MAX_FILE_BYTES),
          })
          .strict(),
      )
      .max(16),
  })
  .strict();
export type Manifest = z.infer<typeof manifest>;
export function digest(data: Buffer | string) {
  return createHash("sha256").update(data).digest("hex");
}
export function uuid() {
  return randomUUID();
}
export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function permittedFile(name: string, mediaType: string) {
  const extension = name.toLowerCase().split(".").pop();
  if (
    extension === "docx" &&
    [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/octet-stream",
    ].includes(mediaType)
  )
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (
    (extension === "txt" || extension === "md") &&
    ["text/plain", "text/markdown", "application/octet-stream"].includes(
      mediaType,
    )
  )
    return extension === "md" ? "text/markdown" : "text/plain";
  throw new AppError(
    422,
    "unsupported_file",
    "Attach a DOCX, TXT, or Markdown file.",
  );
}

export const workspaceRow = z.object({
  owner_id: z.string(),
  id,
  sandbox_id: z.string().nullable(),
  prepare_job_id: z.string().nullable(),
  runtime_sha256: sha,
  status: z.enum([
    "pending",
    "uploading",
    "preparing",
    "ready",
    "stopping",
    "stopped",
    "failed",
  ]),
  sandbox_stopped: z.boolean(),
  wake_requested: z.boolean(),
  uploaded_bytes: z.number(),
  total_bytes: z.number(),
  failure_message: z.string().nullable(),
  attempts: z.number(),
  next_attempt_at: iso,
  updated_at: iso,
});
export type WorkspaceRow = z.infer<typeof workspaceRow>;
