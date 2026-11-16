#!/usr/bin/env node
/** Cache public pinned runtime bundles independently of the source hosting account. */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, link, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const APPROVED_RUNTIME_URLS = Object.freeze({
  '9ffbbd3ed2856013192049986f1062396e46461aa81998f607eaeda9acb3d033':
    'https://github.com/Ntrakiyski/workflow-agents/releases/download/pi-document-runtime-v0.1.0-rc.1/runtime-bundle.tar.gz',
  '08a6dda2a800958428a2089639c721b19bf866d83e55976c8cf2ef167772094a':
    'https://github.com/Ntrakiyski/workflow-agents/releases/download/pi-document-runtime-v0.1.0-rc.2/runtime-bundle.tar.gz',
  '2ce2c1ee993c9f8706e208c99ac98d884c349408f1546fadbb7093ba211a22cc':
    'https://github.com/Ntrakiyski/workflow-agents/releases/download/pi-document-runtime-v0.1.0-rc.3/runtime-bundle.tar.gz',
});
const MAX_BYTES = 256 * 1024 * 1024;
const fail = code => { throw Error('runtime_cache_' + code); };
const owned = info => typeof process.getuid !== 'function' || info.uid === process.getuid();
const safeError = error => /^runtime_cache_[a-z_]+$/.test(error?.message ?? '')
  ? error.message : 'runtime_cache_operation_failed';

async function privateDirectory(path, create = true) {
  // Inspect ancestors too: recursive mkdir alone would follow existing symlinks.
  const absolute = resolve(path);
  let current = sep;
  for (const part of absolute.split(sep).filter(Boolean)) {
    current = join(current, part);
    if (create) {
      try { await mkdir(current, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('unsafe_directory');
  }
  const info = await lstat(absolute);
  if ((info.mode & 0o777) !== 0o700 || !owned(info)) fail('private_directory_required');
}

async function verifyExisting(path, expected) {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    fail('unsafe_existing_file');
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || !owned(info))
      fail('unsafe_existing_file');
    if (!info.size || info.size > MAX_BYTES) fail('existing_size_invalid');
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > MAX_BYTES) fail('existing_size_invalid');
      hash.update(chunk);
    }
    if (size !== info.size || hash.digest('hex') !== expected) fail('existing_checksum_mismatch');
    return size;
  } finally { await file.close(); }
}

async function downloadResponse(url, signal) {
  const allowed = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const target = new URL(url);
    if (target.protocol !== 'https:' || !allowed.has(target.hostname) || target.port
      || target.username || target.password) fail('unapproved_redirect');
    const response = await fetch(target, { signal, redirect: 'manual', headers: { 'User-Agent': 'workflow-agents-runtime-cache' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) fail('invalid_redirect');
      url = new URL(location, target).href;
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      fail('download_failed');
    }
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) {
      await response.body.cancel();
      fail('download_size_limit');
    }
    return response;
  }
  fail('redirect_limit');
}

async function cacheRuntime({ cacheDirectory, sha256, timeoutMs = 180000 } = {}) {
  if (typeof cacheDirectory !== 'string' || !isAbsolute(cacheDirectory)) fail('absolute_directory_required');
  if (typeof sha256 !== 'string' || !Object.hasOwn(APPROVED_RUNTIME_URLS, sha256)) fail('unapproved_checksum');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) fail('invalid_timeout');
  const root = resolve(cacheDirectory);
  await privateDirectory(root);
  const directory = join(root, 'runtime', sha256);
  await privateDirectory(join(root, 'runtime'));
  await privateDirectory(directory);
  const destination = join(directory, 'runtime-bundle.tar.gz');
  const descriptor = size => ({ relative_path: relative(root, destination).split(sep).join('/'),
    sha256, size_bytes: size, url: APPROVED_RUNTIME_URLS[sha256] });
  const existing = await verifyExisting(destination, sha256);
  if (existing !== null) return descriptor(existing);
  const temporary = join(directory, '.runtime-' + randomUUID() + '.partial');
  let file;
  try {
    file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const response = await downloadResponse(APPROVED_RUNTIME_URLS[sha256], AbortSignal.timeout(timeoutMs));
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_BYTES) fail('download_size_limit');
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset);
        if (!bytesWritten) fail('write_failed');
        offset += bytesWritten;
      }
    }
    if (!size || hash.digest('hex') !== sha256) fail('download_checksum_mismatch');
    await file.sync();
    await file.close();
    file = null;
    // Same-filesystem hard-link publication is atomic and never replaces an existing name.
    try { await link(temporary, destination); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await unlink(temporary);
    const verified = await verifyExisting(destination, sha256);
    if (verified === null) fail('publication_missing');
    const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await parent.sync(); } finally { await parent.close(); }
    return descriptor(verified);
  } catch (error) {
    throw Error(safeError(error));
  } finally {
    await file?.close();
    try { await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw Error('runtime_cache_cleanup_failed'); }
  }
}

export async function cacheApprovedRuntime(options) {
  try { return await cacheRuntime(options); }
  catch (error) { throw Error(safeError(error)); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4) fail('usage_directory_checksum');
    console.log(JSON.stringify(await cacheApprovedRuntime({ cacheDirectory: process.argv[2], sha256: process.argv[3] })));
  } catch (error) {
    console.error(JSON.stringify({ outcome: 'failed', code: safeError(error) }));
    process.exitCode = 1;
  }
}
