import yauzl from "yauzl";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { crc32 } from "node:zlib";
import path from "node:path";
import { z } from "zod";
import { AppError, digest, MAX_FILE_BYTES, type Manifest } from "./model.js";

const relationshipsNamespace =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const wordNamespaces = new Set([
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
]);
const recordSchema = z.record(z.string(), z.unknown());
function element(value: unknown): Record<string, unknown> {
  return value === "" ? {} : recordSchema.parse(value);
}
function localName(name: string) {
  return name.split(":").at(-1);
}
function namespace(
  name: string,
  value: Record<string, unknown>,
  inherited: Record<string, unknown> = {},
) {
  const colon = name.indexOf(":");
  const key = colon < 0 ? "@_xmlns" : "@_xmlns:" + name.slice(0, colon);
  return value[key] ?? inherited[key];
}
function xmlRoot(xml: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true)
    throw new Error("invalid_docx_xml");
  const parsed: unknown = new XMLParser({
    ignoreAttributes: false,
    processEntities: false,
    parseTagValue: false,
    parseAttributeValue: false,
  }).parse(xml);
  const roots = Object.entries(recordSchema.parse(parsed)).filter(
    ([key]) => !key.startsWith("?") && !key.startsWith("@_") && key !== "#text",
  );
  if (roots.length !== 1 || !roots[0]) throw new Error("invalid_docx_xml_root");
  const [name, raw] = roots[0];
  return { name, value: element(raw) };
}

export async function inspectDocx(data: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    yauzl.fromBuffer(
      data,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, zip) => {
        if (error || !zip) {
          reject(new Error("invalid_docx_archive"));
          return;
        }
        let count = 0,
          total = 0,
          settled = false,
          mainRelationship = false;
        const names = new Set<string>(),
          targets: string[] = [];
        const required = new Set([
          "[Content_Types].xml",
          "word/document.xml",
          "_rels/.rels",
        ]);
        const fail = (reason: Error) => {
          if (settled) return;
          settled = true;
          zip.close();
          reject(reason);
        };
        function inspectXml(filename: string, bytes: Buffer) {
          const xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          const root = xmlRoot(xml);
          if (filename === "word/document.xml") {
            const ns = namespace(root.name, root.value);
            if (
              localName(root.name) !== "document" ||
              typeof ns !== "string" ||
              !wordNamespaces.has(ns)
            )
              throw new Error("invalid_word_namespace");
            const bodies = Object.entries(root.value).filter(
              ([key]) => localName(key) === "body" && !key.startsWith("@_"),
            );
            if (
              bodies.length !== 1 ||
              !bodies[0] ||
              Array.isArray(bodies[0][1]) ||
              namespace(bodies[0][0], element(bodies[0][1]), root.value) !== ns
            )
              throw new Error("missing_word_body");
          }
          if (filename === "[Content_Types].xml") {
            const ns =
              "http://schemas.openxmlformats.org/package/2006/content-types";
            if (
              localName(root.name) !== "Types" ||
              namespace(root.name, root.value) !== ns
            )
              throw new Error("invalid_content_types");
            const overrides = new Map<string, string>(),
              defaults = new Map<string, string>();
            for (const [key, value] of Object.entries(root.value)) {
              if (key.startsWith("@_") || key === "#text") continue;
              const kind = localName(key);
              if (kind !== "Override" && kind !== "Default")
                throw new Error("invalid_content_type_entry");
              for (const item of Array.isArray(value) ? value : [value]) {
                const itemRecord = element(item);
                if (namespace(key, itemRecord, root.value) !== ns)
                  throw new Error("invalid_content_type_namespace");
                const contentType = z
                  .string()
                  .min(1)
                  .parse(itemRecord["@_ContentType"]);
                const name = z
                  .string()
                  .min(1)
                  .parse(
                    itemRecord[
                      kind === "Override" ? "@_PartName" : "@_Extension"
                    ],
                  );
                const declarations = kind === "Override" ? overrides : defaults;
                const normalized =
                  kind === "Override" ? name : name.toLowerCase();
                if (declarations.has(normalized))
                  throw new Error("duplicate_content_type");
                declarations.set(normalized, contentType);
              }
            }
            const effectiveType =
              overrides.get("/word/document.xml") ?? defaults.get("xml");
            if (
              effectiveType !==
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
            )
              throw new Error("missing_document_content_type");
          }
          if (filename.endsWith(".rels")) {
            if (
              localName(root.name) !== "Relationships" ||
              namespace(root.name, root.value) !== relationshipsNamespace
            )
              throw new Error("invalid_relationships_namespace");
            const base =
              filename === "_rels/.rels"
                ? ""
                : path.posix.dirname(
                    filename.replace(/\/_rels\/([^/]+)\.rels$/, "/$1"),
                  );
            for (const [key, value] of Object.entries(root.value))
              if (!key.startsWith("@_") && key !== "#text") {
                if (localName(key) !== "Relationship")
                  throw new Error("invalid_relationship");
                const items = Array.isArray(value) ? value : [value];
                if (items.length > 4096) throw new Error("relationship_limit");
                for (const item of items) {
                  const relation = element(item);
                  if (
                    namespace(key, relation, root.value) !==
                    relationshipsNamespace
                  )
                    throw new Error("invalid_relationship_namespace");
                  const mode = relation["@_TargetMode"];
                  if (mode !== undefined && mode !== "Internal")
                    throw new Error("external_relationship");
                  const target = z
                    .string()
                    .min(1)
                    .max(2048)
                    .parse(relation["@_Target"]);
                  let decoded: string;
                  try {
                    decoded = decodeURIComponent(target.split("#")[0] ?? "");
                  } catch {
                    throw new Error("invalid_relationship_target");
                  }
                  if (
                    decoded.startsWith("//") ||
                    (decoded.startsWith("/") && !target.startsWith("/")) ||
                    decoded.includes("\\") ||
                    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(decoded) ||
                    /[\x00-\x1f]/.test(decoded)
                  )
                    throw new Error("unsafe_relationship_target");
                  if (decoded) {
                    const normalized = path.posix.normalize(
                      path.posix.join(
                        decoded.startsWith("/") ? "" : base,
                        decoded.startsWith("/") ? decoded.slice(1) : decoded,
                      ),
                    );
                    if (normalized === ".." || normalized.startsWith("../"))
                      throw new Error("unsafe_relationship_target");
                    targets.push(normalized);
                    if (
                      filename === "_rels/.rels" &&
                      normalized === "word/document.xml" &&
                      relation["@_Type"] ===
                        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
                    )
                      mainRelationship = true;
                  }
                }
              }
          }
        }
        zip.on("error", () => fail(new Error("invalid_docx_archive")));
        zip.on("entry", (entry: yauzl.Entry) => {
          count++;
          total += entry.uncompressedSize;
          const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (
            names.has(entry.fileName) ||
            count > 2048 ||
            total > 64 * 1024 * 1024 ||
            entry.uncompressedSize > 16 * 1024 * 1024 ||
            (entry.generalPurposeBitFlag & 1) !== 0 ||
            ![0, 0x8000, 0x4000].includes(mode) ||
            entry.fileName
              .split("/")
              .some((segment) => segment === ".." || segment === ".") ||
            /[\x00-\x1f]/.test(entry.fileName) ||
            /vbaProject|activeX|embeddings\//i.test(entry.fileName)
          ) {
            fail(new Error("unsafe_docx_archive"));
            return;
          }
          names.add(entry.fileName);
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) {
              fail(new Error("invalid_docx_entry"));
              return;
            }
            const isXml = /\.(xml|rels)$/.test(entry.fileName);
            const buffers: Buffer[] = [];
            let read = 0,
              checksum = 0;
            stream.on("data", (chunk: Buffer) => {
              read += chunk.length;
              checksum = crc32(chunk, checksum);
              if (read > 16 * 1024 * 1024) {
                stream.destroy();
                fail(new Error("docx_entry_limit"));
              } else if (isXml) buffers.push(chunk);
            });
            stream.on("error", () => fail(new Error("invalid_docx_entry")));
            stream.on("end", () => {
              if (settled) return;
              try {
                if (read !== entry.uncompressedSize || checksum !== entry.crc32)
                  throw new Error("docx_crc_mismatch");
                if (isXml) inspectXml(entry.fileName, Buffer.concat(buffers));
                required.delete(entry.fileName);
                zip.readEntry();
              } catch {
                fail(new Error("invalid_docx_structure"));
              }
            });
          });
        });
        zip.on("end", () => {
          if (settled) return;
          settled = true;
          if (
            required.size ||
            !mainRelationship ||
            targets.some((target) => !names.has(target))
          )
            reject(new Error("missing_docx_parts"));
          else resolve();
        });
        zip.readEntry();
      },
    );
  });
}
export async function validateDelivery(
  result: Manifest,
  files: Map<string, Buffer>,
) {
  if (
    result.outcome !== "completed" ||
    result.validations.some((v) => v.status === "failed")
  )
    throw new AppError(
      422,
      "validation_failed",
      "The result did not pass validation. Review your inputs and submit a new request.",
    );
  if (result.text.trim() === "" && result.artifacts.length === 0)
    throw new AppError(
      422,
      "missing_result",
      "The request produced no deliverable result. Submit a new request.",
    );
  if (
    new Set(result.artifacts.map((a) => a.path)).size !==
    result.artifacts.length
  )
    throw new AppError(
      422,
      "duplicate_artifact",
      "Result files could not be verified.",
    );
  let total = 0;
  for (const artifact of result.artifacts) {
    const data = files.get(artifact.path);
    if (
      !data ||
      data.length !== artifact.size_bytes ||
      digest(data) !== artifact.sha256
    )
      throw new AppError(
        422,
        "checksum_mismatch",
        "Result file integrity could not be verified.",
      );
    total += data.length;
    if (total > 20 * 1024 * 1024 || data.length > MAX_FILE_BYTES)
      throw new AppError(
        422,
        "result_size_limit",
        "Result files exceed the permitted size.",
      );
    if (
      artifact.path.toLowerCase().endsWith(".docx") &&
      artifact.media_type ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      try {
        await inspectDocx(data);
      } catch {
        throw new AppError(
          422,
          "invalid_document",
          "The result document could not be opened safely. Contact support with the request identifier.",
        );
      }
    } else if (
      /\.(txt|md)$/.test(artifact.path) &&
      ["text/plain", "text/markdown"].includes(artifact.media_type)
    ) {
      new TextDecoder("utf-8", { fatal: true }).decode(data);
    } else
      throw new AppError(
        422,
        "unsupported_result",
        "The result file format is not supported.",
      );
  }
  return `${result.artifacts.length > 0 ? "File integrity and structure checked." : "Result and saved session verified."} Content accuracy and rendered layout were not independently reviewed.`;
}
