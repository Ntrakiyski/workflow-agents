import Fastify, { LogController } from "fastify";
import type { FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Config } from "./config.js";
import { Database } from "./database.js";
import type { Objects } from "./storage.js";
import {
  AppError,
  digest,
  fileRow,
  id,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  permittedFile,
  requestRow,
  submitBody,
  uuid,
} from "./model.js";
import { inspectDocx } from "./validate.js";

export function createApi(db: Database, objects: Objects, config: Config) {
  const app = Fastify({
    bodyLimit: 65536,
    logController: new LogController({ disableRequestLogging: true }),
    logger: {
      level: "info",
      redact: [
        "req.headers.authorization",
        "authorization",
        "password",
        "token",
      ],
    },
  });
  const identities = new WeakMap<FastifyRequest, Config["users"][number]>();
  app.register(multipart, {
    limits: { files: 1, fileSize: MAX_FILE_BYTES, fields: 0, parts: 1 },
  });
  app.addHook("onRequest", async (req, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      )
      .header("Cache-Control", "no-store");
    if (req.url === "/health/live" || req.url === "/health/ready") return;
    const header = req.headers.authorization;
    let username = "",
      password = "";
    if (header?.startsWith("Basic ")) {
      const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      if (separator >= 0) {
        username = decoded.slice(0, separator);
        password = decoded.slice(separator + 1);
      }
    }
    const actual = Buffer.from(digest(password), "hex");
    let selected: Config["users"][number] | undefined;
    for (const candidate of config.users) {
      const valid = timingSafeEqual(
        actual,
        Buffer.from(candidate.password_sha256, "hex"),
      );
      if (candidate.username === username && valid) selected = candidate;
    }
    if (!selected) {
      reply.header(
        "WWW-Authenticate",
        'Basic realm="Workflow requests", charset="UTF-8"',
      );
      throw new AppError(
        401,
        "unauthorized",
        "Sign in to access your requests.",
      );
    }
    identities.set(req, selected);
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin !== new URL(config.publicOrigin).origin
    )
      throw new AppError(
        403,
        "invalid_origin",
        "Refresh the page and try again.",
      );
  });
  function user(req: FastifyRequest) {
    const identity = identities.get(req);
    if (!identity)
      throw new AppError(
        401,
        "unauthorized",
        "Sign in to access your requests.",
      );
    return identity;
  }
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof AppError)
      return reply
        .code(error.statusCode)
        .send({ code: error.code, message: error.message });
    if (error instanceof z.ZodError)
      return reply.code(422).send({
        code: "invalid_request",
        message: "Check the request and try again.",
      });
    if (
      error instanceof Error &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode < 500
    )
      return reply.code(error.statusCode).send({
        code: "invalid_request",
        message:
          error.statusCode === 413
            ? "The file is too large. Maximum size is 10 MiB."
            : "Check the request and try again.",
      });
    req.log.error({
      action: "api.request",
      outcome: "failed",
      error_classification: "internal_error",
    });
    return reply.code(503).send({
      code: "unavailable",
      message: "The request service is temporarily unavailable. Try again.",
    });
  });
  app.get("/health/live", async () => ({
    status: "ok",
    service: "application",
    version: "0.1.0-rc.1",
  }));
  app.get("/health/ready", async (_, reply) => {
    try {
      await db.pool.query("SELECT 1");
      await objects.ready();
      return { status: "ok", checks: { database: "ok", object_storage: "ok" } };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });
  app.get("/api/session", async (req) => ({ username: user(req).username }));
  app.post("/api/attachments", async (req, reply) => {
    const identity = user(req);
    const file = await req.file();
    if (!file)
      throw new AppError(422, "missing_file", "Choose a file to attach.");
    if (!/^[^/\\\x00-\x1f]{1,160}$/.test(file.filename))
      throw new AppError(
        422,
        "invalid_filename",
        "Rename the file and try again.",
      );
    const mediaType = permittedFile(file.filename, file.mimetype);
    const data = await file.toBuffer();
    if (file.file.truncated)
      throw new AppError(413, "file_too_large", "Maximum file size is 10 MiB.");
    if (mediaType.includes("wordprocessingml")) {
      try {
        await inspectDocx(data);
      } catch {
        throw new AppError(
          422,
          "invalid_docx",
          "The DOCX file could not be opened safely. Upload a valid DOCX file.",
        );
      }
    } else {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(data);
      } catch {
        throw new AppError(
          422,
          "invalid_text",
          "Text files must use UTF-8 encoding.",
        );
      }
    }
    const fileId = uuid(),
      sha256 = digest(data),
      objectKey = `owners/${identity.owner_id}/inputs/${fileId}/${sha256}`;
    await objects.put(objectKey, data, mediaType, sha256);
    await db.pool.query(
      "INSERT INTO application.files(id,owner_id,kind,name,media_type,size_bytes,sha256,object_key) VALUES($1,$2,'input',$3,$4,$5,$6,$7)",
      [
        fileId,
        identity.owner_id,
        file.filename,
        mediaType,
        data.length,
        sha256,
        objectKey,
      ],
    );
    return reply
      .code(201)
      .send({ id: fileId, name: file.filename, size_bytes: data.length });
  });
  app.post("/api/requests", async (req, reply) => {
    const identity = user(req);
    const body = submitBody.parse(req.body);
    const key = z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/)
      .parse(req.headers["idempotency-key"]);
    if (new Set(body.attachment_ids).size !== body.attachment_ids.length)
      throw new AppError(
        422,
        "duplicate_attachment",
        "Attach each file only once.",
      );
    const fingerprint = digest(
      JSON.stringify({
        instructions: body.instructions,
        attachment_ids: [...body.attachment_ids].sort(),
      }),
    );
    const result = await db.transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `${identity.owner_id}:${key}`,
      ]);
      const replay = await c.query(
        "SELECT * FROM application.requests WHERE owner_id=$1 AND submission_key=$2",
        [identity.owner_id, key],
      );
      if (replay.rows[0]) {
        if (replay.rows[0].fingerprint !== fingerprint)
          throw new AppError(
            409,
            "idempotency_conflict",
            "This submission has changed. Refresh the page before trying again.",
          );
        return requestRow.parse(replay.rows[0]);
      }
      const attachments = await c.query(
        "SELECT * FROM application.files WHERE id=ANY($1::uuid[]) AND owner_id=$2 AND kind='input' AND request_id IS NULL ORDER BY id FOR UPDATE",
        [body.attachment_ids, identity.owner_id],
      );
      if (attachments.rows.length !== body.attachment_ids.length)
        throw new AppError(
          404,
          "attachment_not_found",
          "An attachment is unavailable. Upload it again.",
        );
      const parsed = attachments.rows.map((v) => fileRow.parse(v));
      if (parsed.reduce((sum, f) => sum + f.size_bytes, 0) > MAX_TOTAL_BYTES)
        throw new AppError(
          422,
          "attachments_too_large",
          "Combined attachments must be at most 20 MiB.",
        );
      if (
        parsed.filter((f) => f.media_type.includes("wordprocessingml")).length >
        1
      )
        throw new AppError(
          422,
          "too_many_documents",
          "Attach at most one DOCX file.",
        );
      const requestId = uuid();
      const title =
        body.instructions.split("\n")[0]?.slice(0, 100) ?? "Request";
      const inserted = await c.query(
        "INSERT INTO application.requests(id,owner_id,title,instructions,submission_key,fingerprint,correlation_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
        [
          requestId,
          identity.owner_id,
          title,
          body.instructions,
          key,
          fingerprint,
          requestId,
        ],
      );
      const r = requestRow.parse(inserted.rows[0]);
      await c.query(
        "UPDATE application.files SET request_id=$1 WHERE id=ANY($2::uuid[])",
        [r.id, body.attachment_ids],
      );
      await db.audit(c, r, "request.submitted", identity.username);
      return r;
    });
    return reply.code(201).send({ id: result.id, status: result.status });
  });
  app.get("/api/requests", async (req) => {
    const identity = user(req);
    const query = z
      .object({
        cursor: z.string().max(512).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(25),
      })
      .strict()
      .parse(req.query);
    let cursor: { created_at: string; id: string } | null = null;
    if (query.cursor) {
      try {
        cursor = z
          .object({ created_at: z.iso.datetime(), id })
          .strict()
          .parse(
            JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")),
          );
      } catch {
        throw new AppError(
          400,
          "invalid_cursor",
          "Return to the first page and try again.",
        );
      }
    }
    const rows = await db.pool.query(
      "SELECT * FROM application.requests WHERE owner_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT $4",
      [
        identity.owner_id,
        cursor?.created_at ?? null,
        cursor?.id ?? null,
        query.limit + 1,
      ],
    );
    const list = rows.rows.map((v) => requestRow.parse(v));
    const page = list.slice(0, query.limit);
    const last = page.at(-1);
    return {
      requests: page.map((r) => ({
        id: r.id,
        title: r.title,
        status: r.status,
        created_at: r.created_at,
      })),
      next_cursor:
        list.length > query.limit && last
          ? Buffer.from(
              JSON.stringify({ created_at: last.created_at, id: last.id }),
            ).toString("base64url")
          : null,
    };
  });
  app.get("/api/requests/:id", async (req) => {
    const requestId = id.parse(z.object({ id }).parse(req.params).id);
    const r = await db.ownedRequest(user(req).owner_id, requestId);
    if (!r) throw new AppError(404, "not_found", "Request not found.");
    const files = await db.files(r.id);
    return {
      id: r.id,
      title: r.title,
      instructions: r.instructions,
      status: r.status,
      created_at: r.created_at,
      final_text: r.status === "completed" ? r.final_text : null,
      validation_summary:
        r.status === "completed" ? r.validation_summary : null,
      failure_message: r.failure_message,
      files: files
        .filter(
          (f) =>
            f.kind === "input" ||
            (f.kind === "output" && r.status === "completed"),
        )
        .map((f) => ({
          id: f.id,
          name: f.name,
          kind: f.kind,
          size_bytes: f.size_bytes,
          sha256: f.sha256,
        })),
    };
  });
  app.get("/api/files/:id/download", async (req, reply) => {
    const fileId = z.object({ id }).parse(req.params).id;
    const row = await db.pool.query(
      "SELECT f.* FROM application.files f LEFT JOIN application.requests r ON r.id=f.request_id WHERE f.id=$1 AND f.owner_id=$2 AND f.kind IN ('input','output') AND (f.kind='input' OR r.status='completed')",
      [fileId, user(req).owner_id],
    );
    if (!row.rows[0]) throw new AppError(404, "not_found", "File not found.");
    const file = fileRow.parse(row.rows[0]);
    const data = await objects.get(file.object_key, MAX_FILE_BYTES);
    if (data.length !== file.size_bytes || digest(data) !== file.sha256)
      throw new AppError(
        503,
        "file_integrity",
        "File integrity verification failed. Contact support.",
      );
    return reply
      .type(file.media_type)
      .header(
        "Content-Disposition",
        `attachment; filename="${file.name.replace(/[^A-Za-z0-9._ -]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      )
      .send(data);
  });
  app.get("/favicon.ico", async (_, reply) => reply.code(204).send());
  app.get("/", async (_, reply) =>
    reply
      .type("text/html")
      .send(await readFile(path.resolve("public/index.html"))),
  );
  app.get("/assets/:name", async (req, reply) => {
    const name = z
      .object({ name: z.string().regex(/^[A-Za-z0-9_.-]+\.(js|css)$/) })
      .parse(req.params).name;
    return reply
      .type(name.endsWith(".js") ? "application/javascript" : "text/css")
      .send(await readFile(path.resolve("public/assets", name)));
  });
  return app;
}
