import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, readdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { cacheApprovedRuntime } from '../cache-approved-runtime.mjs';

const digest = '08a6dda2a800958428a2089639c721b19bf866d83e55976c8cf2ef167772094a';
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'workflow-cache-test-'));
  try {
    const directory = join(root, 'runtime', digest);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await fn(root, directory, join(directory, 'runtime-bundle.tar.gz'));
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('rejects unapproved digests before touching the network or filesystem', async () => {
  await assert.rejects(cacheApprovedRuntime({ cacheDirectory: '/tmp/unused', sha256: 'a'.repeat(64) }), /unapproved_checksum/);
});
test('corrupt existing file is rejected and preserved without a download', async () => {
  await fixture(async (root, directory, file) => {
    await writeFile(file, 'changed bytes', { mode: 0o600 });
    await assert.rejects(cacheApprovedRuntime({ cacheDirectory: root, sha256: digest }), /existing_checksum_mismatch/);
    assert.deepEqual(await readdir(directory), ['runtime-bundle.tar.gz']);
  });
});
test('symlink files, symlink cache roots and nonregular destinations are rejected', async () => {
  await fixture(async (root, directory, file) => {
    await symlink('/etc/passwd', file);
    await assert.rejects(cacheApprovedRuntime({ cacheDirectory: root, sha256: digest }), /unsafe_existing_file/);
    await rm(file);
    await mkdir(file, { mode: 0o700 });
    await assert.rejects(cacheApprovedRuntime({ cacheDirectory: root, sha256: digest }), /unsafe_existing_file/);
    const alias = join(root, 'alias');
    await symlink(directory, alias);
    await assert.rejects(cacheApprovedRuntime({ cacheDirectory: alias, sha256: digest }), /unsafe_directory/);
  });
});
test('rejects cache directories with public permissions', async () => {
  await fixture(async root => {
    await chmod(root, 0o755);
    await assert.rejects(cacheApprovedRuntime({ cacheDirectory: root, sha256: digest }), /private_directory_required/);
  });
});
test('oversized streams and wrong download checksums leave no published file or partial', async () => {
  const savedFetch = globalThis.fetch;
  try {
    await fixture(async (root, directory) => {
      globalThis.fetch = async () => new Response('small', { headers: { 'content-length': String(256 * 1024 * 1024 + 1) } });
      await assert.rejects(cacheApprovedRuntime({ cacheDirectory: root, sha256: digest }), /download_size_limit/);
      assert.deepEqual(await readdir(directory), []);
      globalThis.fetch = async () => new Response('incorrect archive bytes');
      await assert.rejects(cacheApprovedRuntime({ cacheDirectory: root, sha256: digest }), /download_checksum_mismatch/);
      assert.deepEqual(await readdir(directory), []);
    });
  } finally { globalThis.fetch = savedFetch; }
});
