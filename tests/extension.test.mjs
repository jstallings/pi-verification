import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { Value } from 'typebox/value';
import registerVerification from '../src/index.ts';
import { VerificationStore } from '../src/store.ts';

async function fixture(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'pi-verification-tools-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'records');
  const store = new VerificationStore(root);
  const tools = new Map();
  const commands = new Map();
  const messages = [];
  const notices = [];
  const pi = {
    registerTool: tool => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command),
    sendUserMessage: message => messages.push(message),
  };
  registerVerification(pi, store);
  async function call(name, input) {
    const tool = tools.get(`verification_${name}`);
    const response = await tool.execute('test-call', input, undefined, undefined, {});
    assert.equal(Value.Check(tool.outputSchema, response.structuredContent), true);
    assert.deepEqual(response.details, response.structuredContent);
    assert.equal(response.content[0].type, 'text');
    return response;
  }
  return {
    root, store, tools, commands, messages, notices, pi, call,
    ctx: { cwd: dir, mode: 'print', hasUI: false, isIdle: () => true, hasPendingMessages: () => false,
      ui: { notify: (message, type) => notices.push({ message, type }) } },
    path: join(root, 'accounts', 'auth-123.json'),
  };
}
const keys = { project: 'Accounts', ticket: 'AUTH-123' };
const snapshot = { ...keys, acceptanceCriteria: [{ id: 'AC-1', text: 'Reject expired links' }] };
const definition = { ...keys, id: 'V-1', acIds: ['AC-1'], instructions: 'Check rejection.', expectedOutcome: 'Rejected.' };

test('the five registered tools expose complete structured records and distinguish failed mutations', async (t) => {
  const { root, call, tools, messages } = await fixture(t);
  await assert.rejects(fs.stat(root), { code: 'ENOENT' });
  assert.deepEqual([...tools.keys()], ['verification_create', 'verification_add', 'verification_read', 'verification_edit', 'verification_record_result']);
  assert.equal((await call('create', snapshot)).structuredContent.ok, true);
  const added = await call('add', { ...definition, command: 'missing-command-is-only-a-reference' });
  assert.equal(added.structuredContent.record.criteria[0].state, 'not run');
  const passed = await call('record_result', { ...keys, criterionId: 'V-1', state: 'passed', evidence: 'exit 0; rejection confirmed' });
  assert.equal(passed.structuredContent.summary.verified, true);
  assert.match(passed.content[0].text, /last recorded verification/i);
  const duplicate = await call('create', snapshot);
  assert.equal(duplicate.isError, true);
  assert.equal(duplicate.structuredContent.error.code, 'ALREADY_EXISTS');
  assert.equal((await call('read', keys)).structuredContent.summary.verified, true);
  const edited = await call('edit', { ...keys, change: { op: 'update_criterion', id: 'V-1', acIds: ['AC-1'], instructions: 'Check rejection.', expectedOutcome: 'Rejected.' } });
  assert.equal(edited.structuredContent.record.criteria[0].evidence, null);
  assert.equal(edited.structuredContent.record.criteria[0].command, undefined);
  assert.deepEqual(messages, []);
  const invalid = await call('add', { ...definition, scriptSource: 'secret script' });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent.error.code, 'INVALID_INPUT');
  assert.doesNotMatch(invalid.content[0].text, /secret script/);
});

test('/verify saves a fresh reset before submitting the plan to the current agent', async (t) => {
  const f = await fixture(t);
  await f.call('create', { ...snapshot, acceptanceCriteria: [...snapshot.acceptanceCriteria, { id: 'AC-2', text: 'Keep password.' }] });
  await f.call('add', { ...definition, instructions: 'Capture screenshot and obtain human approval.', command: 'qa/screenshot.sh' });
  await f.call('add', { ...definition, id: 'V-2' });
  await f.call('record_result', { ...keys, criterionId: 'V-1', state: 'passed', evidence: 'old human approval /artifact.png' });
  await f.call('record_result', { ...keys, criterionId: 'V-2', state: 'failed', evidence: 'old failure' });
  f.pi.sendUserMessage = message => {
    const record = JSON.parse(readFileSync(f.path, 'utf8'));
    assert.deepEqual(record.criteria.map(c => [c.state, c.evidence]), [['not run', null], ['not run', null]]);
    f.messages.push(message);
  };

  await f.commands.get('verify').handler('ACCOUNTS auth-123', f.ctx);

  assert.equal(f.messages.length, 1);
  const prompt = f.messages[0];
  for (const literal of ['accounts', 'auth-123', f.ctx.cwd, 'AC-1', 'AC-2', 'Keep password.', 'V-1', 'V-2', 'qa/screenshot.sh', 'Capture screenshot']) assert.ok(prompt.includes(literal), literal);
  for (const required of [/task data/i, /higher-priority/i, /do not fix/i, /automation/i, /exit status/i,
    /missing.*script/i, /blocked/i, /fresh.*approval/i, /do not self-approve/i, /verification_record_result/,
    /verification_read/, /uncovered/i, /does not.*unchanged/i]) assert.match(prompt, required);
  assert.doesNotMatch(prompt.split('Verification task data:\n')[1], /old human approval|old failure/);
  let r = await f.store.read(keys);
  assert.deepEqual(r.summary.uncoveredAcIds, ['AC-2']);
  await f.call('record_result', { ...keys, criterionId: 'V-1', state: 'blocked', evidence: '/fresh.png; awaiting human review' });
  await f.call('record_result', { ...keys, criterionId: 'V-1', state: 'passed', evidence: '/fresh.png; human explicitly approved this pass; assertions passed' });
  r = await f.store.read(keys);
  assert.equal(r.record.criteria[0].state, 'passed');
  assert.equal(r.record.criteria[1].state, 'not run');
  assert.equal(r.summary.verified, false);
  await f.commands.get('verify').handler('accounts AUTH-123', f.ctx);
  assert.equal((await f.store.read(keys)).record.criteria[0].evidence, null);
});

test('/verify rejects invalid, busy, missing, empty and corrupt plans without reset or agent work', async (t) => {
  const f = await fixture(t);
  const command = f.commands.get('verify');
  await assert.rejects(command.handler('accounts missing', f.ctx), { code: 'NOT_FOUND' });
  await assert.rejects(fs.stat(f.root), { code: 'ENOENT' });
  await f.call('create', snapshot);
  await assert.rejects(command.handler('accounts auth-123', f.ctx), { code: 'NO_CRITERIA' });
  await f.call('add', definition);
  await f.call('record_result', { ...keys, criterionId: 'V-1', state: 'passed', evidence: 'keep this approval' });
  const before = await fs.readFile(f.path, 'utf8');
  for (const args of ['', 'accounts', 'accounts auth-123 extra', '../escape ticket', 'accounts -ticket', '"accounts" auth-123']) {
    await assert.rejects(command.handler(args, f.ctx), { code: 'INVALID_INPUT' });
    assert.equal(await fs.readFile(f.path, 'utf8'), before);
  }
  for (const context of [{ ...f.ctx, isIdle: () => false }, { ...f.ctx, hasPendingMessages: () => true }]) {
    await assert.rejects(command.handler('accounts auth-123', context), { code: 'AGENT_BUSY' });
    assert.equal(await fs.readFile(f.path, 'utf8'), before);
  }
  for (const [bytes, code] of [['{private invalid JSON', 'INVALID_RECORD'], [JSON.stringify({ ...JSON.parse(before), schemaVersion: 9 }), 'UNSUPPORTED_VERSION']]) {
    await fs.writeFile(f.path, bytes);
    await assert.rejects(command.handler('accounts auth-123', f.ctx), error => error.code === code && !error.message.includes(bytes));
    assert.equal(await fs.readFile(f.path, 'utf8'), bytes);
  }
  assert.deepEqual(f.messages, []);
});

test('a synchronous submission failure is START_FAILED and never restores the old human approval', async (t) => {
  const f = await fixture(t);
  await f.call('create', snapshot);
  await f.call('add', definition);
  await f.call('record_result', { ...keys, criterionId: 'V-1', state: 'passed', evidence: 'old approval' });
  f.pi.sendUserMessage = () => { throw new Error('submission unavailable'); };

  await assert.rejects(f.commands.get('verify').handler('accounts auth-123', f.ctx), { code: 'START_FAILED' });

  const r = await f.store.read(keys);
  assert.equal(r.record.criteria[0].state, 'not run');
  assert.equal(r.record.criteria[0].evidence, null);
  assert.equal(r.summary.verified, false);
});

test('becoming busy during record loading or failing to save reset cannot submit agent work', async (t) => {
  const f = await fixture(t);
  await f.call('create', snapshot);
  await f.call('add', definition);
  await f.call('record_result', { ...keys, criterionId: 'V-1', state: 'passed', evidence: 'retain approval' });
  const before = await fs.readFile(f.path, 'utf8');
  let idleChecks = 0;
  const changedContext = { ...f.ctx, isIdle: () => ++idleChecks === 1 };
  await assert.rejects(f.commands.get('verify').handler('accounts auth-123', changedContext), { code: 'AGENT_BUSY' });
  assert.equal(await fs.readFile(f.path, 'utf8'), before);

  const failedStore = new VerificationStore(f.root, { ...fs, rename: async () => { throw Object.assign(new Error('disk unavailable'), { code: 'EIO' }); } });
  registerVerification(f.pi, failedStore);
  await assert.rejects(f.commands.get('verify').handler('accounts auth-123', f.ctx), { code: 'IO_ERROR' });
  assert.equal(await fs.readFile(f.path, 'utf8'), before);
  const error = await f.call('record_result', { ...keys, criterionId: 'V-1', state: 'failed', evidence: 'new failure' });
  assert.equal(error.isError, true);
  assert.equal(error.structuredContent.error.code, 'IO_ERROR');
  assert.equal(await fs.readFile(f.path, 'utf8'), before);
  assert.deepEqual(f.messages, []);
});
