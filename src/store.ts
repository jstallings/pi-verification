import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { withFileMutationQueue } from '@earendil-works/pi-coding-agent';

export type AcceptanceCriterion = { id: string; text: string };
export type State = 'not run' | 'passed' | 'failed' | 'blocked';
export type Criterion = {
  id: string; acIds: string[]; instructions: string; expectedOutcome: string; command?: string;
  state: State; evidence: string | null;
};
export type VerificationRecord = {
  schemaVersion: 1;
  project: string;
  ticket: string;
  acceptanceCriteria: AcceptanceCriterion[];
  criteria: Criterion[];
};

export class VerificationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
function fail(code: string, message: string): never { throw new VerificationError(code, message); }
function ioError(error: unknown): never {
  if (error instanceof VerificationError) throw error;
  fail('IO_ERROR', `Verification filesystem operation failed (${(error as NodeJS.ErrnoException)?.code ?? 'unknown'}).`);
}
function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT', 'Expected an object.');
  const obj = value as Record<string, unknown>;
  for (const field of Object.keys(obj)) if (!fields.includes(field)) fail('INVALID_INPUT', `Unknown field: ${field}.`);
  return obj;
}
function id(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value))
    fail('INVALID_INPUT', `${field} must be 1-100 ASCII letters, digits, hyphens or underscores, starting with a letter or digit.`);
  return value;
}
function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_INPUT', `${field} must contain non-whitespace text.`);
  return value.trim();
}
export function parseVerifyArguments(args: string) {
  const parts = args.trim().split(/\s+/);
  if (parts.length !== 2) fail('INVALID_INPUT', 'Usage: /verify <project> <ticket>.');
  return identity({ project: parts[0], ticket: parts[1] });
}
function identity(input: Record<string, unknown>) {
  return { project: id(input.project, 'project').toLowerCase(), ticket: id(input.ticket, 'ticket').toLowerCase() };
}
function acceptanceCriteria(value: unknown): AcceptanceCriterion[] {
  if (!Array.isArray(value) || !value.length) fail('INVALID_INPUT', 'acceptanceCriteria must be nonempty.');
  const seen = new Set<string>();
  return value.map(entry => {
    const ac = object(entry, ['id', 'text']);
    const key = id(ac.id, 'AC id');
    if (seen.has(key)) fail('INVALID_INPUT', `Duplicate AC id: ${key}.`);
    seen.add(key);
    return { id: key, text: text(ac.text, 'AC text') };
  });
}

function definition(input: Record<string, unknown>, record: VerificationRecord): Criterion {
  if (!Array.isArray(input.acIds) || !input.acIds.length) fail('INVALID_INPUT', 'acIds must be nonempty.');
  const acIds = input.acIds.map(value => id(value, 'acIds entry'));
  if (new Set(acIds).size !== acIds.length) fail('INVALID_INPUT', 'acIds must be distinct.');
  for (const acId of acIds) if (!record.acceptanceCriteria.some(ac => ac.id === acId))
    fail('NOT_FOUND', `Referenced AC not found: ${acId}.`);
  return {
    id: id(input.id, 'criterion id'), acIds,
    instructions: text(input.instructions, 'instructions'), expectedOutcome: text(input.expectedOutcome, 'expectedOutcome'),
    ...('command' in input ? { command: text(input.command, 'command') } : {}),
    state: 'not run', evidence: null,
  };
}
function stateEvidence(input: Record<string, unknown>): { state: State; evidence: string | null } {
  if (!['not run', 'passed', 'failed', 'blocked'].includes(input.state as string)) fail('INVALID_INPUT', 'Unknown state.');
  const state = input.state as State;
  if (state === 'not run') {
    if (input.evidence !== undefined && input.evidence !== null) fail('INVALID_INPUT', 'not run requires omitted or null evidence.');
    return { state, evidence: null };
  }
  return { state, evidence: text(input.evidence, 'evidence') };
}
function parseRecord(bytes: string, project: string, ticket: string): VerificationRecord {
  try {
    const data = object(JSON.parse(bytes), ['schemaVersion', 'project', 'ticket', 'acceptanceCriteria', 'criteria']);
    if (!('schemaVersion' in data)) fail('INVALID_RECORD', 'Missing schemaVersion.');
    if (data.schemaVersion !== 1) fail('UNSUPPORTED_VERSION', 'Unsupported verification schema version.');
    if (data.project !== project || data.ticket !== ticket) fail('INVALID_RECORD', 'Stored record identity does not match its path.');
    const record: VerificationRecord = { schemaVersion: 1, project, ticket, acceptanceCriteria: acceptanceCriteria(data.acceptanceCriteria), criteria: [] };
    if (!Array.isArray(data.criteria)) fail('INVALID_RECORD', 'criteria must be an array.');
    const seen = new Set<string>();
    record.criteria = data.criteria.map(value => {
      const c = object(value, ['id', 'acIds', 'instructions', 'expectedOutcome', 'command', 'state', 'evidence']);
      if (!('evidence' in c)) fail('INVALID_RECORD', 'Stored criterion requires evidence.');
      const criterion = { ...definition(c, record), ...stateEvidence(c) };
      if (seen.has(criterion.id)) fail('INVALID_RECORD', 'Duplicate stored criterion id.');
      seen.add(criterion.id);
      return criterion;
    });
    return record;
  } catch (error) {
    if (error instanceof VerificationError && ['INVALID_RECORD', 'UNSUPPORTED_VERSION'].includes(error.code)) throw error;
    fail('INVALID_RECORD', 'Stored verification JSON violates the record invariants.');
  }
}

function result(record: VerificationRecord) {
  const coverage = record.acceptanceCriteria.map(ac => ({
    acId: ac.id, criterionIds: record.criteria.filter(c => c.acIds.includes(ac.id)).map(c => c.id),
  }));
  const uncoveredAcIds = coverage.filter(ac => !ac.criterionIds.length).map(ac => ac.acId);
  const counts = { 'not run': 0, passed: 0, failed: 0, blocked: 0 };
  for (const criterion of record.criteria) counts[criterion.state]++;
  return { ok: true as const, record, summary: {
    verified: record.acceptanceCriteria.length > 0 && !uncoveredAcIds.length && record.criteria.every(c => c.state === 'passed'),
    coverage, uncoveredAcIds, counts,
  } };
}

export class VerificationStore {
  readonly root: string;
  private readonly io: Pick<typeof fs, 'readFile' | 'writeFile' | 'mkdir' | 'rename' | 'rm' | 'lstat'>;
  constructor(root = join(homedir(), '.pi', 'agent', 'verification'), io: VerificationStore['io'] = fs) {
    this.root = resolve(root); this.io = io;
  }

  private path(project: string, ticket: string) { return join(this.root, project, `${ticket}.json`); }

  private async write(record: VerificationRecord) {
    const path = this.path(record.project, record.ticket);
    const temp = `${path}.${randomUUID()}.tmp`;
    let committed = false;
    try {
      await this.io.mkdir(dirname(path), { recursive: true });
      await this.io.writeFile(temp, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      await this.io.rename(temp, path);
      committed = true;
    } catch (error) { ioError(error); }
    finally {
      // Replacement is the commit point; cleanup must not turn a committed write into a failure.
      if (!committed) await this.io.rm(temp, { force: true }).catch(() => {});
    }
  }

  async create(value: unknown) {
    const input = object(value, ['project', 'ticket', 'acceptanceCriteria']);
    const record: VerificationRecord = {
      schemaVersion: 1, ...identity(input), acceptanceCriteria: acceptanceCriteria(input.acceptanceCriteria), criteria: [],
    };
    return withFileMutationQueue(this.path(record.project, record.ticket), async () => {
      try {
        await this.io.lstat(this.path(record.project, record.ticket));
        await this.read({ project: record.project, ticket: record.ticket });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') ioError(error);
        await this.write(record);
        return result(record);
      }
      fail('ALREADY_EXISTS', 'Verification record already exists.');
    });
  }

  async add(value: unknown) {
    const input = object(value, ['project', 'ticket', 'id', 'acIds', 'instructions', 'expectedOutcome', 'command']);
    return this.mutate(input, record => {
      const criterion = definition(input, record);
      if (record.criteria.some(c => c.id === criterion.id)) fail('ALREADY_EXISTS', `Criterion already exists: ${criterion.id}.`);
      record.criteria.push(criterion);
    });
  }

  async edit(value: unknown) {
    const input = object(value, ['project', 'ticket', 'change']);
    return this.mutate(input, record => {
      const change = object(input.change, ['op', 'id', 'text', 'acIds', 'instructions', 'expectedOutcome', 'command']);
      const key = id(change.id, 'change.id');
      const acIndex = record.acceptanceCriteria.findIndex(ac => ac.id === key);
      const criterionIndex = record.criteria.findIndex(c => c.id === key);
      switch (change.op) {
        case 'add_ac':
          object(change, ['op', 'id', 'text']);
          if (acIndex !== -1) fail('ALREADY_EXISTS', `AC already exists: ${key}.`);
          record.acceptanceCriteria.push({ id: key, text: text(change.text, 'text') });
          break;
        case 'update_ac': {
          object(change, ['op', 'id', 'text']);
          if (acIndex === -1) fail('NOT_FOUND', `AC not found: ${key}.`);
          const replacement = text(change.text, 'text');
          if (record.acceptanceCriteria[acIndex].text === replacement) return false;
          record.acceptanceCriteria[acIndex].text = replacement;
          for (const criterion of record.criteria) if (criterion.acIds.includes(key)) {
            criterion.state = 'not run'; criterion.evidence = null;
          }
          break;
        }
        case 'remove_ac':
          object(change, ['op', 'id']);
          if (acIndex === -1) fail('NOT_FOUND', `AC not found: ${key}.`);
          if (record.criteria.some(c => c.acIds.includes(key))) fail('AC_IN_USE', `AC has linked criteria: ${key}.`);
          if (record.acceptanceCriteria.length === 1) fail('LAST_AC', 'Cannot remove the last AC.');
          record.acceptanceCriteria.splice(acIndex, 1);
          break;
        case 'update_criterion':
          object(change, ['op', 'id', 'acIds', 'instructions', 'expectedOutcome', 'command']);
          if (criterionIndex === -1) fail('NOT_FOUND', `Criterion not found: ${key}.`);
          record.criteria[criterionIndex] = definition(change, record);
          break;
        case 'remove_criterion':
          object(change, ['op', 'id']);
          if (criterionIndex === -1) fail('NOT_FOUND', `Criterion not found: ${key}.`);
          record.criteria.splice(criterionIndex, 1);
          break;
        default: fail('INVALID_INPUT', 'Unknown change.op.');
      }
    });
  }

  async recordResult(value: unknown) {
    const input = object(value, ['project', 'ticket', 'criterionId', 'state', 'evidence']);
    return this.mutate(input, record => {
      const criterionId = id(input.criterionId, 'criterionId');
      const criterion = record.criteria.find(c => c.id === criterionId);
      if (!criterion) fail('NOT_FOUND', `Criterion not found: ${criterionId}.`);
      Object.assign(criterion, stateEvidence(input));
    });
  }

  async resetForVerification(value: unknown, assertIdle: () => void) {
    const input = object(value, ['project', 'ticket']);
    return this.mutate(input, record => {
      assertIdle();
      if (!record.criteria.length) fail('NO_CRITERIA', 'Record has no verification criteria.');
      for (const criterion of record.criteria) { criterion.state = 'not run'; criterion.evidence = null; }
    });
  }

  private async mutate(input: Record<string, unknown>, update: (record: VerificationRecord) => void | false) {
    const keys = identity(input);
    return withFileMutationQueue(this.path(keys.project, keys.ticket), async () => {
      const { record } = await this.read(keys);
      if (update(record) !== false) await this.write(record);
      return result(record);
    });
  }

  async read(value: unknown) {
    const input = identity(object(value, ['project', 'ticket']));
    try {
      const record = parseRecord(await this.io.readFile(this.path(input.project, input.ticket), 'utf8'), input.project, input.ticket);
      return result(record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('NOT_FOUND', 'Verification record not found.');
      ioError(error);
    }
  }
}
