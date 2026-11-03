#!/usr/bin/env node
/** Actual hosted browser flow; never queries databases or changes deployments.
 * Credentials stay in a private file. Initial submission is never retried with
 * a fresh identity. Recheck an existing state after an operator replacement.
 * Browser plugin absent: uses the application's installed Playwright Chromium.
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, mkdir, open, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const options = Object.create(null);
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index];
  const value = process.argv[index + 1];
  if (!flag?.startsWith('--') || value === undefined) throw new Error('invalid_arguments');
  options[flag.slice(2)] = value;
}
const origin = new URL(options.origin);
if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
    (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname))))
  throw new Error('https_application_origin_required');
if (!options.credentials) throw new Error('private_credentials_file_required');
const credentialFile = path.resolve(options.credentials);
if (((await stat(credentialFile)).mode & 0o077) !== 0) throw new Error('credential_file_must_be_private');
let raw;
try { raw = JSON.parse(await readFile(credentialFile, 'utf8')); }
catch { throw new Error('private_credentials_json_unreadable'); }
const primary = raw.primary ?? { username: raw.application_username, password: raw.application_password };
const foreign = raw.foreign ?? { username: raw.qa_username, password: raw.qa_password };
for (const identity of [primary, foreign])
  if (typeof identity.username !== 'string' || typeof identity.password !== 'string' || !identity.username || !identity.password)
    throw new Error('two_private_credentials_required');
if (primary.username === foreign.username) throw new Error('distinct_foreign_account_required');
const require = createRequire(path.join(path.resolve(options['application-dir'] ?? path.join(root, 'apps/application')), 'package.json'));
const { chromium, request, expect } = require('@playwright/test');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const recheck = Boolean(options['recheck-state']);
const prior = recheck ? JSON.parse(await readFile(options['recheck-state'], 'utf8')) : null;
if (prior && prior.origin !== origin.origin) throw new Error('recheck_origin_mismatch');
const session = prior?.session ?? randomUUID();
const privateDirectory = path.join(root, 'private', 'hosted-browser-' + session);
await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
const statePath = path.resolve(options.state ?? options['recheck-state'] ?? path.join(privateDirectory, 'state.json'));
if (!recheck) {
  try { await stat(statePath); throw new Error('existing_state_requires_recheck_mode'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const reportPath = path.resolve(options.report ?? path.join(root, 'docs/release', recheck ? 'hosted-application-replacement.json' : 'hosted-application-journey.json'));
const state = prior ?? { version: 1, session, origin: origin.origin, submission_dispatched: false,
                        request_id: null, attachment_id: null, marker: 'Workflow Agents hosted QA ' + session,
                        title: 'Hosted QA ' + session, input_marker: options['input-marker'] ?? 'Independent QA synthetic OfficeCLI fixture.' };
if (prior && !prior.request_id) throw new Error('resume_requires_known_request_identity');
const report = { version: 1, operation: prior?.output ? 'hosted-browser-persistence-recheck' : recheck ? 'hosted-browser-existing-request-resume' : 'hosted-browser-document-journey',
  session, origin: origin.origin, recorded_at_utc: new Date().toISOString(), outcome: 'incomplete',
  deployed_commit: options['deployed-commit'] ?? 'not supplied; verify separately',
  browser: 'Playwright Chromium; Browser plugin not available',
  execution: 'actual hosted application; no request routing or execution mocks installed by this helper',
  checks: [], screenshots: [], state_file: statePath,
  limits: ['No database/deployment mutation or infrastructure credential access',
    'DOCX ZIP/XML/checksum and exact synthetic markers checked; semantic accuracy and rendered page layout not established',
    'Replacement is performed externally; this helper compares saved request/file identities and bytes afterwards',
    'Sandbox stop, durable server audits and deployed commit need separate operator evidence'] };
async function atomicJson(destination, value) {
  const temporary = destination + '.tmp';
  const file = await open(temporary, 'w', 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, destination);
}
async function save() {
  await atomicJson(statePath, state);
  await mkdir(path.dirname(reportPath), { recursive: true });
  await atomicJson(reportPath, report);
}
async function record(scenario, observations = {}) {
  report.checks.push({ scenario, outcome: 'passed', observations });
  await save();
  process.stdout.write(JSON.stringify({ scenario, outcome: 'passed', request_id: state.request_id }) + '\n');
}
function insist(condition, code) { if (!condition) throw new Error(code); }
const validateDocx = String.raw`
import hashlib,json,posixpath,re,stat,sys,urllib.parse,xml.etree.ElementTree as ET,zipfile
from pathlib import Path,PurePosixPath
p=Path(sys.argv[1]);marker=sys.argv[2];original=sys.argv[3]
assert 0<p.stat().st_size<=10*1024*1024
with zipfile.ZipFile(p) as z:
 items=z.infolist();names=[i.filename for i in items]
 assert len(items)<=2048 and len(names)==len(set(names)) and sum(i.file_size for i in items)<=64*1024*1024
 assert {'[Content_Types].xml','_rels/.rels','word/document.xml'}<=set(names)
 checked=0;root=None;word='{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
 for item in items:
  assert not PurePosixPath(item.filename).is_absolute() and '..' not in PurePosixPath(item.filename).parts
  assert '\\' not in item.filename and not stat.S_ISLNK(item.external_attr>>16) and not item.flag_bits&1
  assert item.file_size<=16*1024*1024
  data=z.read(item)
  if item.filename.endswith(('.xml','.rels')):
   assert b'<!DOCTYPE' not in data.upper() and b'<!ENTITY' not in data.upper()
   parsed=ET.fromstring(data);checked+=1
   if item.filename=='word/document.xml':root=parsed
   if item.filename.endswith('.rels'):
    base='' if item.filename=='_rels/.rels' else posixpath.dirname(re.sub(r'/_rels/([^/]+)\.rels$',r'/\1',item.filename))
    for relation in parsed:
     assert relation.attrib.get('TargetMode','Internal')=='Internal'
     target=urllib.parse.unquote(relation.attrib['Target'].split('#')[0])
     assert not target.startswith('//') and '\\' not in target and not re.match(r'^[A-Za-z][A-Za-z0-9+.-]*:',target)
     resolved=posixpath.normpath(target[1:] if target.startswith('/') else posixpath.join(base,target))
     assert resolved!='..' and not resolved.startswith('../') and resolved in names
 assert root is not None and root.tag==word+'document' and root.find(word+'body') is not None
 paragraphs=[''.join(part.itertext()) for part in root.iter(word+'p')]
 text='\n'.join(paragraphs)
 assert paragraphs.count(marker)==1 and original in text
 print(json.dumps({'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'xml_parts_checked':checked,'paragraphs':len(paragraphs),'exact_appended_marker_count':paragraphs.count(marker),'original_marker_preserved':True,'zip_crc_xml_relationship_checks':'passed','semantic_accuracy':'not_performed','rendered_page_layout':'not_performed'}))
`;
let browser, context, unauthenticated, foreignContext;
const consoleEvents = [], pageErrors = [];
try {
  await save();
  unauthenticated = await request.newContext({ baseURL: origin.origin });
  foreignContext = await request.newContext({ baseURL: origin.origin,
    httpCredentials: { username: foreign.username, password: foreign.password, origin: origin.origin, send: 'always' } });
  for (const endpoint of ['/', '/api/requests']) {
    const response = await unauthenticated.get(endpoint);
    insist(response.status() === 401, 'unauthenticated_access_not_denied');
  }
  insist((await foreignContext.get('/api/session')).status() === 200, 'foreign_account_not_configured');
  await record('unauthenticated_entry_denied_and_foreign_account_authenticated');
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ baseURL: origin.origin, viewport: { width: 1366, height: 900 }, acceptDownloads: true,
    httpCredentials: { username: primary.username, password: primary.password, origin: origin.origin } });
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(sha(error.message)));
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type())) consoleEvents.push({ type: message.type(), message_sha256: sha(message.text()) });
  });
  await page.goto('/');
  insist(new URL(page.url()).origin === origin.origin, 'application_origin_redirected');
  await expect(page).toHaveTitle('Workflow requests');
  await expect(page.getByRole('heading', { name: 'New request', exact: true })).toBeVisible();
  insist(await page.locator('main').innerText() !== '', 'blank_application');
  insist(await page.locator('vite-error-overlay, nextjs-portal').count() === 0, 'framework_overlay_visible');
  await record('page_identity_nonblank_no_framework_overlay');
  if (!recheck) {
    insist(typeof options['input-docx'] === 'string', 'synthetic_input_docx_required');
    const input = path.resolve(options['input-docx']);
    const inputBytes = await readFile(input);
    state.input_sha256 = sha(inputBytes);
    state.input_size_bytes = inputBytes.length;
    const instructions = state.title + '\nOpen the attached DOCX using officecli read. Use officecli add_paragraph to append one paragraph at /body whose exact text is "' + state.marker + '" (without the quotation marks or extra punctuation). Preserve every original paragraph. Read back the saved document, then run issues and validate. Reply with a short completion note.';
    await page.getByLabel('Instructions', { exact: true }).fill(instructions);
    await page.getByLabel('Input files').setInputFiles({ name: 'synthetic-hosted-input.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: inputBytes });
    const uploadPromise = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/attachments', { timeout: 60000 });
    const submissionPromise = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/requests', { timeout: 90000 });
    state.submission_dispatched = true;
    await save();
    await page.getByRole('button', { name: 'Submit request', exact: true }).click();
    const [upload, submission] = await Promise.all([uploadPromise, submissionPromise]);
    insist(upload.status() === 201, 'attachment_submission_failed');
    state.attachment_id = (await upload.json()).id;
    insist(submission.status() === 201, 'request_submission_failed');
    state.request_id = (await submission.json()).id;
    insist(/^[a-f0-9-]{36}$/.test(state.request_id), 'invalid_submitted_request_identity');
    report.request_id = state.request_id;
    await save();
    await expect(page.getByRole('status').first()).toContainText('Request submitted');
    await record('actual_browser_attachment_submission_confirmation', { input_sha256: state.input_sha256, input_bytes: state.input_size_bytes });
    const submittedRequest = submission.request();
    const replay = await context.request.post('/api/requests', { headers: { Origin: origin.origin,
      'Idempotency-Key': submittedRequest.headers()['idempotency-key'] }, data: submittedRequest.postDataJSON() });
    insist(replay.status() === 201 && (await replay.json()).id === state.request_id, 'idempotent_submission_identity_changed');
    const changed = await context.request.post('/api/requests', { headers: { Origin: origin.origin,
      'Idempotency-Key': submittedRequest.headers()['idempotency-key'] },
      data: { ...submittedRequest.postDataJSON(), instructions: 'Changed synthetic request body' } });
    insist(changed.status() === 409, 'changed_idempotency_payload_not_rejected');
    await record('same_key_submission_replay_and_changed_payload_conflict');
  } else {
    report.request_id = state.request_id;
  }
  await page.goto('/');
  await page.reload();
  let visible = false;
  for (let count = 0; count < 20; count++) {
    const row = page.getByRole('button', { name: state.title, exact: true });
    await expect(page.getByRole('heading', { name: 'Your requests', exact: true })).toBeVisible();
    await expect(page.getByText('Loading requests…', { exact: true })).toBeHidden({ timeout: 15000 });
    if (await row.isVisible()) { visible = true; break; }
    const next = page.getByRole('button', { name: 'Next', exact: true });
    if (!(await next.isVisible()) || !(await next.isEnabled())) break;
    const nextPage = page.waitForResponse((response) => response.request().method() === 'GET' &&
      new URL(response.url()).pathname === '/api/requests' && new URL(response.url()).searchParams.has('cursor'));
    await next.click();
    await nextPage;
    await page.waitForTimeout(100);
  }
  insist(visible, 'request_missing_from_persistent_paginated_list');
  const listed = page.getByRole('button', { name: state.title, exact: true });
  const rowScreenshot = '/tmp/workflow-hosted-' + session + (recheck ? '-replacement' : '') + '-list-row.png';
  await listed.locator('xpath=ancestor::tr').screenshot({ path: rowScreenshot });
  report.screenshots.push(rowScreenshot);
  await listed.click();
  await record('persistent_paginated_request_list_reload_and_reopen');
  const deadline = Date.now() + Math.min(Number(options['timeout-seconds'] ?? 900), 1800) * 1000;
  let detail, lastProgress = 0;
  while (Date.now() < deadline) {
    const response = await context.request.get('/api/requests/' + state.request_id);
    insist(response.status() === 200, 'authorized_request_read_failed');
    detail = await response.json();
    report.request_status = detail.status;
    if (detail.status === 'completed') break;
    if (detail.status === 'failed') throw new Error('hosted_request_failed');
    insist(['pending', 'running'].includes(detail.status), 'unexpected_request_status');
    if (Date.now() - lastProgress > 30000) {
      process.stdout.write(JSON.stringify({ action: 'hosted_request_wait', request_id: state.request_id, status: detail.status }) + '\n');
      lastProgress = Date.now();
    }
    await page.waitForTimeout(2000);
  }
  insist(detail?.status === 'completed', 'hosted_request_deadline');
  await expect(page.getByRole('heading', { name: 'Result', exact: true })).toBeVisible({ timeout: 10000 });
  await expect(page.locator('.status.completed')).toBeVisible();
  const outputs = detail.files.filter((file) => file.kind === 'output' && file.name.endsWith('.docx'));
  insist(outputs.length === 1 && typeof detail.final_text === 'string' && detail.final_text.trim().length > 0, 'missing_actual_docx_result');
  const output = outputs[0];
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: output.name, exact: true }).click();
  const download = await downloadPromise;
  insist(await download.failure() === null, 'browser_download_failed');
  const downloaded = path.join(privateDirectory, recheck ? 'replacement-result.docx' : 'result.docx');
  await download.saveAs(downloaded);
  const bytes = await readFile(downloaded);
  insist(bytes.length === output.size_bytes && sha(bytes) === output.sha256, 'download_manifest_integrity_mismatch');
  const validation = JSON.parse(execFileSync('python3', ['-c', validateDocx, downloaded, state.marker, state.input_marker],
    { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }));
  if (prior?.output) {
    insist(output.id === prior.output.id && output.sha256 === prior.output.sha256 && bytes.length === prior.output.size_bytes,
      'replacement_result_identity_or_bytes_changed');
    await record('replacement_request_file_identities_and_downloaded_bytes_preserved', { file_id: output.id, sha256: sha(bytes) });
  } else {
    state.output = { id: output.id, sha256: output.sha256, size_bytes: output.size_bytes, name: output.name };
    await save();
  }
  await record('actual_docx_download_and_independent_crc_xml_content_validation', validation);
  const original = await context.request.get('/api/files/' + state.attachment_id + '/download');
  insist(original.status() === 200 && sha(await original.body()) === state.input_sha256, 'original_input_changed');
  await record('original_uploaded_bytes_preserved');
  for (const endpoint of ['/api/requests/' + state.request_id,
    '/api/files/' + state.attachment_id + '/download', '/api/files/' + output.id + '/download']) {
    insist((await unauthenticated.get(endpoint)).status() === 401, 'unauthenticated_resource_access_not_denied');
    insist((await foreignContext.get(endpoint)).status() === 404, 'foreign_owner_resource_access_not_denied');
  }
  const foreignList = await foreignContext.get('/api/requests?limit=100');
  insist(foreignList.status() === 200 && !(await foreignList.json()).requests.some((item) => item.id === state.request_id),
    'foreign_owner_request_list_leak');
  const rejectedOrigin = await context.request.post('/api/requests', { headers: { Origin: 'https://unrelated.invalid',
    'Idempotency-Key': 'origin-negative-' + session }, data: { instructions: 'Untrusted-origin synthetic body', attachment_ids: [] } });
  insist(rejectedOrigin.status() === 403, 'foreign_origin_mutation_not_rejected');
  await record('unauthenticated_and_foreign_owner_request_input_output_denied_and_origin_rejected');
  for (const [label, viewport] of [['desktop', { width: 1366, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
    await page.setViewportSize(viewport);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Result', exact: true })).toBeVisible();
    insist(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'horizontal_viewport_overflow');
    const screenshot = '/tmp/workflow-hosted-' + session + (recheck ? '-replacement' : '') + '-' + label + '.png';
    await page.screenshot({ path: screenshot, fullPage: true });
    report.screenshots.push(screenshot);
  }
  report.console_events = consoleEvents;
  report.page_error_hashes = pageErrors;
  insist(consoleEvents.length === 0 && pageErrors.length === 0, 'browser_console_or_page_errors');
  await record('desktop_mobile_result_view_console_health_and_no_horizontal_overflow');
  report.outcome = 'passed';
  await save();
} catch (error) {
  report.error_classification = /^[a-z0-9_]+$/.test(error.message ?? '') ? error.message : error.name;
  report.console_events = consoleEvents;
  report.page_error_hashes = pageErrors;
  await save();
  process.exitCode = 1;
} finally {
  await context?.close();
  await browser?.close();
  await unauthenticated?.dispose();
  await foreignContext?.dispose();
}
process.stdout.write(JSON.stringify({ outcome: report.outcome, request_id: state.request_id, state_file: statePath,
  report_file: reportPath, error_classification: report.error_classification ?? null }) + '\n');
