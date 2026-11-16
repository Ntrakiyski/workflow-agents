import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyApplicationScope } from './coolify-scope.mjs';
const scope = { project: 'p', environment: 'e', uuid: 'a', name: 'application' };
const fixture = () => ({ '/projects/p': { uuid: 'p', environments: [{ uuid: 'e', name: 'staging' }] },
  '/projects/p/staging': { uuid: 'e', id: 11, applications: [{ uuid: 'a', name: 'application', environment_id: 11 }] },
  '/applications/a': { uuid: 'a', name: 'application', environment_id: 11 } });
const call = rows => verifyApplicationScope(async (method, path) => {
  assert.equal(method, 'GET'); assert.ok(Object.hasOwn(rows, path)); return rows[path];
}, scope);
test('exact project and environment membership verifies without nested application environment', async () => {
  assert.equal((await call(fixture())).uuid, 'a');
});
test('foreign, renamed, missing and contradictory identities fail closed', async () => {
  const edits = [
    rows => { rows['/projects/p'].uuid = 'foreign'; },
    rows => { rows['/projects/p'].environments[0].uuid = 'foreign'; },
    rows => { rows['/projects/p/staging'].uuid = 'foreign'; },
    rows => { rows['/projects/p/staging'].applications = []; },
    rows => { rows['/projects/p/staging'].applications[0].environment_id = 12; },
    rows => { rows['/applications/a'].name = 'foreign'; },
    rows => { rows['/applications/a'].environment_id = 12; },
    rows => { rows['/applications/a'].environment = { uuid: 'foreign' }; },
  ];
  for (const edit of edits) { const rows = fixture(); edit(rows); await assert.rejects(call(rows), /mismatch/); }
});
