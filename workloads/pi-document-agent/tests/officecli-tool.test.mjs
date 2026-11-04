import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assignedDocument, buildArguments } from '../officecli-arguments.mjs';

test('tool cannot select another file, traverse a symlink or execute a command', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-tool-'));
  try {
    mkdirSync(join(root, 'outputs'));
    const doc = join(root, 'outputs/document.docx');
    writeFileSync(doc, 'fixture');
    assert.equal(assignedDocument({ PI_REQUEST_ROOT: root, PI_DOCX_PATH: doc }), doc);
    assert.throws(() => assignedDocument({ PI_REQUEST_ROOT: root, PI_DOCX_PATH: '/etc/passwd' }));
    assert.throws(() => buildArguments(doc, 'bash', { text: 'id' }));
    assert.throws(() => buildArguments(doc, 'get', { path: '\0' }));
    rmSync(doc);
    symlinkSync('/etc/passwd', doc);
    assert.throws(() => assignedDocument({ PI_REQUEST_ROOT: root, PI_DOCX_PATH: doc }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('user text and shell metacharacters remain literal argv', () => {
  const doc = '/opt/workflow-transfer/requests/test/outputs/document.docx';
  const text = '$(touch /tmp/forbidden); `id`';
  assert.deepEqual(buildArguments(doc, 'replace_text', { find: 'old', text }),
    ['set', doc, '/', '--find', 'old', '--replace', text]);
  assert.deepEqual(buildArguments(doc, 'read', { start: 201, end: 400 }),
    ['view', doc, 'text', '--max-lines', '200', '--start', '201', '--end', '400']);
  assert.throws(() => buildArguments(doc, 'add_paragraph', { text: 'hello', after: '/p[1]', before: '/p[2]' }));
});
