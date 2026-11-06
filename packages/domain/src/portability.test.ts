import { describe, expect, it } from 'vitest';
import {
  artifactPartPath,
  exportObjectKey,
  importedWorkStatus,
  isArchivePath,
  recordPartPath,
} from './portability';

const ID = '6f1c2c6e-1111-4111-8111-111111111111';

describe('archive paths', () => {
  it('reads back what it makes', () => {
    expect(isArchivePath(recordPartPath('work', 'work_units', 1))).toBe(true);
    expect(isArchivePath(recordPartPath('audit-redacted', 'audit_events', 12))).toBe(true);
    expect(isArchivePath(artifactPartPath(ID))).toBe(true);
    expect(isArchivePath('manifest.json.sealed')).toBe(true);
  });

  it.each([
    '../../etc/passwd',
    '/work/work_units-000001.jsonl.sealed',
    'work/../secrets/x-000001.jsonl.sealed',
    'work\\work_units-000001.jsonl.sealed',
    'secrets/sealed-000001.jsonl.sealed',
    'work/work_units-000001.jsonl',
    'work/work_units-1.jsonl.sealed',
    'work/WORK-000001.jsonl.sealed',
    `work/${ID}.bin.sealed`,
    'artifacts/not-an-id.bin.sealed',
    'manifest.json',
    '',
  ])('refuses %s', (path) => {
    expect(isArchivePath(path)).toBe(false);
  });

  it('refuses to build a path or a key from anything else', () => {
    expect(() => recordPartPath('work', '../x', 1)).toThrow();
    expect(() => recordPartPath('work', 'x', 0)).toThrow();
    expect(() => artifactPartPath('../x')).toThrow();
    expect(() => exportObjectKey(ID, ID, '../x')).toThrow();
    expect(() => exportObjectKey('x', ID, 'manifest.json.sealed')).toThrow();
  });
});

describe('what an import does to work that was moving', () => {
  it('keeps what had settled, and leaves what was in flight for a person', () => {
    for (const status of ['queued', 'ready', 'completed', 'failed', 'cancelled']) {
      expect(importedWorkStatus(status)).toBe(status);
    }
    for (const status of ['running', 'blocked', 'awaiting_approval', 'verifying', 'nonsense']) {
      expect(importedWorkStatus(status)).toBe('blocked');
    }
  });
});
