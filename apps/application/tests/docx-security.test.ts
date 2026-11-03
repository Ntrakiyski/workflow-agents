import { test } from "node:test";
import assert from "node:assert/strict";
import { ZipFile } from "yazl";
import { inspectDocx } from "../src/validate.js";

const document =
  '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Verified fixture</w:t></w:r></w:p></w:body></w:document>';
const types =
  '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
const rels =
  '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
async function archive({
  body = document,
  relationships = rels,
  additional = [],
}: {
  body?: string;
  relationships?: string;
  additional?: Array<{ name: string; data: string; mode?: number }>;
} = {}) {
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from(types), "[Content_Types].xml", { compress: false });
  zip.addBuffer(Buffer.from(relationships), "_rels/.rels", { compress: false });
  zip.addBuffer(Buffer.from(body), "word/document.xml", { compress: false });
  for (const entry of additional)
    zip.addBuffer(Buffer.from(entry.data), entry.name, {
      compress: false,
      ...(entry.mode ? { mode: entry.mode } : {}),
    });
  const chunks: Buffer[] = [];
  zip.outputStream.on("data", (data: Buffer) => chunks.push(data));
  const result = new Promise<Buffer>((resolve, reject) => {
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
  });
  zip.end();
  return result;
}
test("independent DOCX controller rejects ambiguous ZIP members and corrupt nonrequired XML/CRC", async () => {
  await inspectDocx(await archive());
  await assert.rejects(() =>
    archive({
      additional: [{ name: "word/document.xml", data: "<broken" }],
    }).then(inspectDocx),
  );
  await assert.rejects(() =>
    archive({
      additional: [{ name: "word/styles.xml", data: "<broken" }],
    }).then(inspectDocx),
  );
  await assert.rejects(() =>
    archive({
      additional: [
        { name: "word/linked.txt", data: "/private.txt", mode: 0o120777 },
      ],
    }).then(inspectDocx),
  );
  const corrupt = await archive();
  const marker = corrupt.indexOf("Verified fixture");
  assert.ok(marker >= 0);
  corrupt[marker] = 88;
  await assert.rejects(() => inspectDocx(corrupt));
});
test("independent DOCX controller requires Word namespace/body and refuses external or escaping OPC relationships", async () => {
  await assert.rejects(() =>
    archive({
      body: '<x:document xmlns:x="urn:wrong"><x:body/></x:document>',
    }).then(inspectDocx),
  );
  await assert.rejects(() =>
    archive({
      body: document
        .replace("<w:body>", "<w:other>")
        .replace("</w:body>", "</w:other>"),
    }).then(inspectDocx),
  );
  for (const target of [
    "file:///private.txt",
    "https://unapproved.example/data",
    "../../private.txt",
    "%2F%2Fprivate.txt",
  ]) {
    const unsafe = rels.replace(
      "</Relationships>",
      `<Relationship Id="rId2" Type="test" Target="${target}" TargetMode="External"/></Relationships>`,
    );
    await assert.rejects(() =>
      archive({ relationships: unsafe }).then(inspectDocx),
    );
  }
  const missingTarget = rels.replace(
    'Target="word/document.xml"',
    'Target="word/missing.xml"',
  );
  await assert.rejects(() =>
    archive({ relationships: missingTarget }).then(inspectDocx),
  );
});
