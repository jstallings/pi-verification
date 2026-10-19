import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverAndLoadExtensions } from '@earendil-works/pi-coding-agent';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = await mkdtemp(join(tmpdir(), 'pi-verification-load-'));
try {
  // The actual Pi loader discovers the package manifest and evaluates TypeScript via jiti.
  const loaded = await discoverAndLoadExtensions([root], dir, join(dir, 'agent'));
  assert.deepEqual(loaded.errors, []);
  assert.deepEqual(loaded.warnings ?? [], []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0];
  assert.equal(extension.tools.size, 5);
  assert.ok(extension.commands.has('verify'));
  await assert.rejects(extension.commands.get('verify').handler('', {}), error => error.message.startsWith('INVALID_INPUT:'));
  assert.deepEqual(await readdir(dir), []);
  console.log('Pi extension-load smoke passed: package manifest, five tools, /verify; no model request or settings changes.');
} finally {
  await rm(dir, { recursive: true, force: true });
}
