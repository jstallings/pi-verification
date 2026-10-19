import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { VerificationStore } from '../src/store.ts';

const keys = { project: 'Accounts', ticket: 'AUTH-123' };
const acs = [{ id: 'AC-1', text: '  Expired reset links are rejected.  ' }];
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-verification-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'records');
  return { root, store: new VerificationStore(root), path: join(root, 'accounts', 'auth-123.json') };
}

test('a reviewer creates an external AC snapshot and can read it in a fresh session', async (t) => {
  const { root, store, path } = await fixture(t);
  await assert.rejects(stat(root), { code: 'ENOENT' });

  const created = await store.create({ ...keys, acceptanceCriteria: acs });
  const read = await new VerificationStore(root).read({ project: 'ACCOUNTS', ticket: 'auth-123' });

  assert.deepEqual(read, created);
  assert.deepEqual(read.record, {
    schemaVersion: 1, project: 'accounts', ticket: 'auth-123',
    acceptanceCriteria: [{ id: 'AC-1', text: 'Expired reset links are rejected.' }], criteria: [],
  });
  assert.deepEqual(read.summary, {
    verified: false, coverage: [{ acId: 'AC-1', criterionIds: [] }], uncoveredAcIds: ['AC-1'],
    counts: { 'not run': 0, passed: 0, failed: 0, blocked: 0 },
  });
  const disk = await readFile(path, 'utf8');
  assert.equal(disk, JSON.stringify(read.record, null, 2) + '\n');
});

test('creation rejects invalid input and duplicates without overwriting the snapshot', async (t) => {
  const { store, path } = await fixture(t);
  const input = { ...keys, acceptanceCriteria: acs };
  for (const bad of [
    { ...input, project: '../escape' }, { ...input, ticket: '-bad' },
    { ...input, project: 'x'.repeat(101) }, { ...input, ticket: 'a/b' },
    { ...input, force: true }, { ...input, acceptanceCriteria: [] },
    { ...input, acceptanceCriteria: [acs[0], acs[0]] },
    { ...input, acceptanceCriteria: [{ id: 'a.b', text: 'text' }] },
    { ...input, acceptanceCriteria: [{ id: 'AC-1', text: '  ' }] },
    { ...input, acceptanceCriteria: [{ ...acs[0], extra: 1 }] },
    null,
  ]) await assert.rejects(store.create(bad), { code: 'INVALID_INPUT' });
  await store.create(input);
  const before = await readFile(path, 'utf8');

  await assert.rejects(store.create(input), { code: 'ALREADY_EXISTS' });
  await assert.rejects(store.read({ ...keys, extra: true }), { code: 'INVALID_INPUT' });
  await assert.rejects(store.read({ ...keys, ticket: 'missing' }), { code: 'NOT_FOUND' });

  assert.equal(await readFile(path, 'utf8'), before);
});

const definition = {
  id: 'V-1', acIds: ['AC-1', 'AC-2'], instructions: '  Attempt expired reset and check password. ',
  expectedOutcome: 'Rejected; original password still works.', command: 'missing-qa-script',
};
async function plan(t) {
  const f = await fixture(t);
  await f.store.create({ ...keys, acceptanceCriteria: [...acs, { id: 'AC-2', text: 'Password unchanged.' }] });
  return f;
}

test('shared criteria count once and a ticket verifies only after full coverage and fresh evidence', async (t) => {
  const { store, path } = await plan(t);
  const added = await store.add({ ...keys, ...definition });
  assert.equal(added.record.criteria[0].state, 'not run');
  assert.equal(added.record.criteria[0].evidence, null);
  assert.equal(added.record.criteria[0].command, 'missing-qa-script');
  assert.equal(added.record.criteria[0].instructions, definition.instructions.trim());
  assert.deepEqual(added.summary.coverage, [
    { acId: 'AC-1', criterionIds: ['V-1'] }, { acId: 'AC-2', criterionIds: ['V-1'] },
  ]);
  assert.equal(added.summary.counts['not run'], 1);

  await store.add({ ...keys, ...definition, id: 'v-1', acIds: ['AC-1'] });
  await store.recordResult({ ...keys, criterionId: 'V-1', state: 'passed', evidence: ' exit 0; both outcomes confirmed. ' });
  const partial = await store.read(keys);
  assert.equal(partial.summary.verified, false);
  assert.deepEqual(partial.summary.counts, { 'not run': 1, passed: 1, failed: 0, blocked: 0 });
  assert.equal(partial.record.criteria[0].evidence, 'exit 0; both outcomes confirmed.');
  for (const state of ['failed', 'blocked', 'passed']) {
    const r = await store.recordResult({ ...keys, criterionId: 'v-1', state, evidence: 'human decision with artifact' });
    assert.equal(r.summary.verified, state === 'passed');
  }
  const beforeRead = await readFile(path, 'utf8');
  await store.read(keys);
  assert.equal(await readFile(path, 'utf8'), beforeRead);
  const reset = await store.recordResult({ ...keys, criterionId: 'V-1', state: 'not run' });
  assert.equal(reset.record.criteria[0].evidence, null);
  assert.equal(reset.summary.verified, false);
});

test('explicit definition edits invalidate only the affected results and recompute coverage', async (t) => {
  const { store } = await plan(t);
  await store.add({ ...keys, ...definition });
  await store.add({ ...keys, ...definition, id: 'V-2', acIds: ['AC-2'] });
  const pass = id => store.recordResult({ ...keys, criterionId: id, state: 'passed', evidence: 'fresh human approval' });
  const edit = change => store.edit({ ...keys, change });
  await pass('V-1'); await pass('V-2');

  let r = await edit({ op: 'update_ac', id: 'AC-1', text: acs[0].text });
  assert.equal(r.summary.verified, true);
  r = await edit({ op: 'update_ac', id: 'AC-1', text: 'Reject with HTTP 410.' });
  assert.deepEqual(r.record.criteria.map(c => [c.state, c.evidence]), [['not run', null], ['passed', 'fresh human approval']]);
  await pass('V-1');
  r = await edit({ op: 'update_criterion', ...definition });
  assert.equal(r.record.criteria[0].state, 'not run');
  assert.equal(r.record.criteria[0].evidence, null);
  await pass('V-1');
  const { command, ...noCommand } = definition;
  r = await edit({ op: 'update_criterion', ...noCommand, acIds: ['AC-2'] });
  assert.equal('command' in r.record.criteria[0], false);
  assert.deepEqual(r.summary.uncoveredAcIds, ['AC-1']);
  r = await edit({ op: 'add_ac', id: 'AC-3', text: 'New outcome' });
  assert.deepEqual(r.record.acceptanceCriteria.map(ac => ac.id), ['AC-1', 'AC-2', 'AC-3']);
  r = await edit({ op: 'remove_ac', id: 'AC-1' });
  assert.deepEqual(r.summary.uncoveredAcIds, ['AC-3']);
  r = await edit({ op: 'remove_criterion', id: 'V-1' });
  assert.deepEqual(r.record.criteria.map(c => c.id), ['V-2']);
  assert.equal(r.record.criteria[0].state, 'passed');
});

test('malformed or unsupported records are rejected on every operation without overwriting bytes', async (t) => {
  const { store, path } = await plan(t);
  await store.add({ ...keys, ...definition });
  const valid = JSON.parse(await readFile(path, 'utf8'));
  const invalid = [
    '{broken', JSON.stringify({ ...valid, project: 'wrong' }),
    JSON.stringify({ ...valid, ticket: 'AUTH-123' }),
    JSON.stringify({ ...valid, acceptanceCriteria: [] }),
    JSON.stringify({ ...valid, acceptanceCriteria: [valid.acceptanceCriteria[0], valid.acceptanceCriteria[0]] }),
    JSON.stringify({ ...valid, criteria: [{ ...valid.criteria[0], acIds: ['missing'] }] }),
    JSON.stringify({ ...valid, criteria: [valid.criteria[0], valid.criteria[0]] }),
    JSON.stringify({ ...valid, criteria: [{ ...valid.criteria[0], state: 'passed', evidence: null }] }),
    JSON.stringify({ ...valid, criteria: [{ ...valid.criteria[0], evidence: 'stale approval' }] }),
    JSON.stringify({ ...valid, criteria: [{ ...valid.criteria[0], state: 'unknown' }] }),
    JSON.stringify({ ...valid, criteria: [{ ...valid.criteria[0], command: null }] }),
    JSON.stringify({ ...valid, extra: 'unknown' }),
    JSON.stringify({ ...valid, schemaVersion: undefined }),
  ];
  for (const bytes of [...invalid, JSON.stringify({ ...valid, schemaVersion: 2 })]) {
    const code = bytes.includes('"schemaVersion":2') ? 'UNSUPPORTED_VERSION' : 'INVALID_RECORD';
    await writeFile(path, bytes);
    for (const operation of [
      () => store.read(keys), () => store.add({ ...keys, ...definition, id: 'V-2' }),
      () => store.edit({ ...keys, change: { op: 'remove_criterion', id: 'V-1' } }),
      () => store.recordResult({ ...keys, criterionId: 'V-1', state: 'passed', evidence: 'new' }),
    ]) await assert.rejects(operation(), { code });
    await assert.rejects(store.create({ ...keys, acceptanceCriteria: acs }), { code });
    assert.equal(await readFile(path, 'utf8'), bytes);
  }
});

test('overlapping local mutations retain every change across store instances and recover after errors', async (t) => {
  const { store, root } = await plan(t);
  const other = new VerificationStore(root);
  const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) =>
    (i % 2 ? other : store).add({ ...keys, ...definition, id: i === 7 ? 'V-0' : `V-${i}` })));
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  const read = await other.read(keys);
  assert.equal(read.record.criteria.length, 19);
  assert.equal(new Set(read.record.criteria.map(c => c.id)).size, 19);
  await Promise.all(read.record.criteria.map(c => store.recordResult({ ...keys, criterionId: c.id, state: 'passed', evidence: 'exit 0; verified' })));
  assert.equal((await other.read(keys)).summary.verified, true);
});

test('write and replacement failures preserve the complete destination and report IO_ERROR', async (t) => {
  const { root, store, path } = await plan(t);
  const before = await readFile(path, 'utf8');
  for (const stage of ['writeFile', 'rename']) {
    const io = { ...fs, [stage]: async (...args) => {
      if (stage === 'writeFile') await fs.writeFile(args[0], '{partial', { flag: 'wx' });
      throw Object.assign(new Error('injected disk failure'), { code: 'ENOSPC' });
    } };
    const broken = new VerificationStore(root, io);
    await assert.rejects(broken.add({ ...keys, ...definition }), { code: 'IO_ERROR' });
    assert.equal(await readFile(path, 'utf8'), before);
    await assert.rejects(broken.create({ ...keys, ticket: 'new', acceptanceCriteria: acs }), { code: 'IO_ERROR' });
    await assert.rejects(stat(join(root, 'accounts', 'new.json')), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(join(root, 'accounts')), ['auth-123.json']);
  }
  const brokenRead = new VerificationStore(root, { ...fs, readFile: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } });
  await assert.rejects(brokenRead.read(keys), { code: 'IO_ERROR' });
  await store.add({ ...keys, ...definition });
  assert.equal((await store.read(keys)).record.criteria.length, 1);
});

test('rejected definitions, results and removals cannot change existing results', async (t) => {
  const { store, path } = await plan(t);
  await store.add({ ...keys, ...definition });
  await store.recordResult({ ...keys, criterionId: 'V-1', state: 'passed', evidence: 'keep fresh approval' });
  const before = await readFile(path, 'utf8');
  const add = extra => store.add({ ...keys, ...definition, id: 'V-2', ...extra });
  const edit = change => store.edit({ ...keys, change });
  const result = extra => store.recordResult({ ...keys, criterionId: 'V-1', state: 'passed', evidence: 'evidence', ...extra });
  const rejected = [
    [() => add({ acIds: [] }), 'INVALID_INPUT'],
    [() => add({ acIds: ['AC-1', 'AC-1'] }), 'INVALID_INPUT'],
    [() => add({ acIds: ['ac-1'] }), 'NOT_FOUND'],
    [() => add({ command: null }), 'INVALID_INPUT'],
    [() => add({ command: ' \t ' }), 'INVALID_INPUT'],
    [() => add({ instructions: '  ' }), 'INVALID_INPUT'],
    [() => add({ expectedOutcome: null }), 'INVALID_INPUT'],
    [() => add({ id: 'V-1' }), 'ALREADY_EXISTS'],
    [() => add({ state: 'passed' }), 'INVALID_INPUT'],
    [() => result({ state: 'not run', evidence: '' }), 'INVALID_INPUT'],
    [() => result({ state: 'not run', evidence: 'old approval' }), 'INVALID_INPUT'],
    [() => result({ evidence: '  ' }), 'INVALID_INPUT'],
    [() => result({ evidence: null }), 'INVALID_INPUT'],
    [() => result({ evidence: undefined }), 'INVALID_INPUT'],
    [() => result({ state: 'unknown' }), 'INVALID_INPUT'],
    [() => result({ criterionId: 'v-1' }), 'NOT_FOUND'],
    [() => result({ instructions: 'edit via result' }), 'INVALID_INPUT'],
    [() => edit({ op: 'add_ac', id: 'AC-1', text: 'duplicate' }), 'ALREADY_EXISTS'],
    [() => edit({ op: 'remove_ac', id: 'AC-1' }), 'AC_IN_USE'],
    [() => edit({ op: 'update_ac', id: 'missing', text: 'text' }), 'NOT_FOUND'],
    [() => edit({ op: 'remove_ac', id: 'missing' }), 'NOT_FOUND'],
    [() => edit({ op: 'remove_criterion', id: 'missing' }), 'NOT_FOUND'],
    [() => edit({ op: 'update_criterion', ...definition, id: 'missing' }), 'NOT_FOUND'],
    [() => edit({ op: 'update_criterion', id: 'V-1', instructions: 'partial' }), 'INVALID_INPUT'],
    [() => edit({ op: 'update_criterion', ...definition, evidence: 'cannot retain' }), 'INVALID_INPUT'],
    [() => edit({ op: 'update_criterion', ...definition, acIds: ['missing'] }), 'NOT_FOUND'],
    [() => edit({ op: 'update_ac', id: 'AC-1', text: 'replacement', command: 'wrong op' }), 'INVALID_INPUT'],
    [() => edit({ op: 'add_criterion', ...definition }), 'INVALID_INPUT'],
  ];
  for (const [operation, code] of rejected) {
    await assert.rejects(operation(), { code });
    assert.equal(await readFile(path, 'utf8'), before);
  }
  await edit({ op: 'remove_criterion', id: 'V-1' });
  await edit({ op: 'remove_ac', id: 'AC-2' });
  const last = await readFile(path, 'utf8');
  await assert.rejects(edit({ op: 'remove_ac', id: 'AC-1' }), { code: 'LAST_AC' });
  assert.equal(await readFile(path, 'utf8'), last);
});
