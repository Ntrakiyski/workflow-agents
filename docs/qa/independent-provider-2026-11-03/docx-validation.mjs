import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(resolve(process.cwd(), 'package.json'));
const yazl = require('yazl');
const source = resolve(process.cwd(), 'src/validate.ts');
const { inspectDocx } = await import(pathToFileURL(source).href);
const word = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Independent QA</w:t></w:r></w:p></w:body></w:document>';
const types = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
const rels = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
async function archive({ document = word, relationships = rels, extra = [] } = {}) {
  const zip = new yazl.ZipFile();
  for (const [name, data, options] of [['[Content_Types].xml', types], ['_rels/.rels', relationships], ['word/document.xml', document], ...extra])
    zip.addBuffer(Buffer.from(data), name, { compress: false, ...(options ?? {}) });
  zip.end();
  const chunks = [];
  for await (const chunk of zip.outputStream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
const cases = [
  { name: 'valid_minimal_docx', expected: 'accepted', input: {} },
  { name: 'duplicate_document_part', expected: 'rejected', input: { extra: [['word/document.xml', '<malformed>']] } },
  { name: 'wrong_word_namespace', expected: 'rejected', input: { document: '<x:document xmlns:x="urn:wrong"><x:body/></x:document>' } },
  { name: 'external_file_relationship', expected: 'rejected', input: { relationships: rels.replace('</Relationships>', '<Relationship Id="r2" Type="extra" TargetMode="External" Target="file:///private.txt"/></Relationships>') } },
  { name: 'encoded_absolute_relationship', expected: 'rejected', input: { relationships: rels.replace('Target="word/document.xml"', 'Target="%2Fword/document.xml"') } },
  { name: 'traversal_relationship', expected: 'rejected', input: { relationships: rels.replace('Target="word/document.xml"', 'Target="../private.txt"') } },
  { name: 'unused_malformed_xml_part', expected: 'rejected', input: { extra: [['word/unused.xml', '<broken>']] } },
  { name: 'dtd_entity_part', expected: 'rejected', input: { extra: [['word/unused.xml', '<!DOCTYPE x [<!ENTITY x "hello">]><x>&x;</x>']] } },
  { name: 'missing_relationship_target', expected: 'rejected', input: { relationships: rels.replace('word/document.xml', 'word/missing.xml') } },
  { name: 'symlink_entry', expected: 'rejected', input: { extra: [['word/linked.txt', '/etc/passwd', { mode: 0o120777 }]] } },
  { name: 'crc_corruption_in_unused_binary', expected: 'rejected', input: { extra: [['word/media/binary.bin', 'unique-qa-crc-sentinel']] }, corrupt: true },
];
const results = [];
for (const test of cases) {
  const data = await archive(test.input);
  if (test.corrupt) {
    const offset = data.indexOf(Buffer.from('unique-qa-crc-sentinel'));
    if (offset < 0) throw new Error('test_fixture_missing');
    data[offset] ^= 0x01;
  }
  let actual = 'accepted';
  let reason = null;
  try { await inspectDocx(data); } catch (error) { actual = 'rejected'; reason = error.message; }
  results.push({ name: test.name, expected: test.expected, actual, passed: actual === test.expected, reason });
}
console.log(JSON.stringify({ date: new Date().toISOString(), source: 'apps/application/src/validate.ts', source_sha256: createHash('sha256').update(await readFile(source)).digest('hex'), execution: 'Independent process against application controller; no runtime or database involved', results }, null, 2));
if (results.some(test => !test.passed)) process.exitCode = 1;
