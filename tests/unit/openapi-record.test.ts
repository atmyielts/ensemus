// API-12: what the shared record says about who saw an operation answer. tests/stack/api.test.ts counts an
// operation as tested only when a running test saw its documented answer, not when a suite's setup did.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  contractProblems,
  currentCaller,
  readRecord,
  recordLine,
  validatedOperations,
} from '../helpers/openapi';

const ORG = '6f1c2c6e-1111-4111-8111-111111111111';
const ID = '6f1c2c6e-2222-4222-8222-222222222222';
const workUnit = {
  id: ID,
  organization_id: ORG,
  title: 'A title',
  status: 'queued',
  version: 1,
  due_at: null,
};
const json = (extra: Record<string, string> = {}) =>
  new Headers({ 'content-type': 'application/json', ...extra });
const ONE = 'GET /organizations/{organization_id}/work-units/{work_unit_id}';
const LIST = 'GET /organizations/{organization_id}/work-units';
const HERE = 'tests/unit/openapi-record.test.ts';

const readOne = () =>
  contractProblems({
    method: 'GET',
    path: `/api/v1/organizations/${ORG}/work-units/${ID}`,
    status: 200,
    headers: json({ etag: '"1"' }),
    text: JSON.stringify(workUnit),
  });
const readList = () =>
  contractProblems({
    method: 'GET',
    path: `/api/v1/organizations/${ORG}/work-units`,
    status: 200,
    headers: json(),
    text: JSON.stringify({ items: [workUnit], next_cursor: null }),
  });

describe('the record of who saw an operation answer', () => {
  let folder: string;
  const before = process.env.ENSEMUS_API_RECORD_DIR;
  let setupCaller: ReturnType<typeof currentCaller>;

  beforeAll(() => {
    folder = mkdtempSync(join(tmpdir(), 'ensemus-api-record-test-'));
    process.env.ENSEMUS_API_RECORD_DIR = folder;
    setupCaller = currentCaller();
    // A suite setting itself up: the operation answered, and no test of it was running.
    expect(readList().problems).toEqual([]);
  });
  afterAll(() => {
    if (before === undefined) delete process.env.ENSEMUS_API_RECORD_DIR;
    else process.env.ENSEMUS_API_RECORD_DIR = before;
    rmSync(folder, { recursive: true, force: true });
  });

  it('knows a running test from setup, and names the file either way', () => {
    expect(setupCaller).toEqual({ phase: 'setup', file: HERE });
    expect(currentCaller()).toEqual({ phase: 'test', file: HERE });
  });

  it('counts an operation a running test saw as tested, and one only setup saw as not', () => {
    expect(readOne().problems).toEqual([]);
    const seen = validatedOperations();
    expect(seen.shared).toBe(true);
    expect([...seen.operations].sort()).toEqual([LIST, ONE].sort());
    expect([...seen.tested]).toEqual([ONE]);
    expect(seen.setupOnly).toEqual(new Map([[LIST, [HERE]]]));
    const lines = readFileSync(join(folder, 'validated-operations.txt'), 'utf8')
      .split('\n')
      .filter(Boolean);
    expect(lines.sort()).toEqual([`${LIST}\tsetup\t${HERE}`, `${ONE}\ttest\t${HERE}`].sort());
  });

  it('records nothing for a refusal, or for an answer the spec does not allow', () => {
    const lines = () => readFileSync(join(folder, 'validated-operations.txt'), 'utf8');
    const was = lines();
    contractProblems({
      method: 'GET',
      path: `/api/v1/organizations/${ORG}/work-units/${ID}`,
      status: 404,
      headers: json(),
      text: JSON.stringify({ code: 'NOT_FOUND', message: 'x', request_id: ID, retryable: false }),
    });
    const leaked = contractProblems({
      method: 'GET',
      path: `/api/v1/organizations/${ORG}/work-units/${ID}`,
      status: 200,
      headers: json({ etag: '"1"' }),
      text: JSON.stringify({ ...workUnit, owner_membership_id: ID }),
    });
    expect(leaked.problems).not.toEqual([]);
    expect(lines()).toBe(was);
  });

  it('takes a caller given with a check made after the request, as the setup file makes it', () => {
    contractProblems(
      {
        method: 'GET',
        path: `/api/v1/organizations/${ORG}/work-units`,
        status: 200,
        headers: json(),
        text: JSON.stringify({ items: [], next_cursor: null }),
      },
      { phase: 'test', file: 'tests/stack/elsewhere.test.ts' },
    );
    const seen = validatedOperations();
    expect(seen.tested.has(LIST)).toBe(true);
    expect(seen.setupOnly.has(LIST)).toBe(false);
  });
});

describe('reading record lines', () => {
  it('counts a line written before the phase was recorded as answered, never as tested', () => {
    const read = readRecord([ONE, '', `${LIST}\tsetup\ttests/stack/a.test.ts`]);
    expect([...read.operations].sort()).toEqual([LIST, ONE].sort());
    expect(read.tested.size).toBe(0);
    expect(read.setupOnly).toEqual(
      new Map([
        [ONE, ['unknown']],
        [LIST, ['tests/stack/a.test.ts']],
      ]),
    );
  });

  it('lists every file that saw an operation only in setup, once each', () => {
    const read = readRecord([
      `${ONE}\tsetup\ttests/stack/b.test.ts`,
      `${ONE}\tsetup\ttests/stack/a.test.ts`,
      `${ONE}\tsetup\ttests/stack/b.test.ts`,
    ]);
    expect(read.setupOnly.get(ONE)).toEqual(['tests/stack/a.test.ts', 'tests/stack/b.test.ts']);
  });

  it('does not let a phase it does not know count as tested', () => {
    expect(readRecord([`${ONE}\tTEST\tx`, `${ONE}\ttested\tx`]).tested.size).toBe(0);
  });

  it('keeps a field from breaking the line apart', () => {
    expect(recordLine(ONE, { phase: 'test', file: 'a\tb\nc' })).toBe(`${ONE}\ttest\ta b c`);
  });
});
