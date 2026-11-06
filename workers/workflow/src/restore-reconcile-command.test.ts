// What needs no database: the arguments, the exit status, what gets printed, the probe, and the pure rules the
// reconcile runs on. tests/integration/restore-reconcile.test.ts runs all of it against real roles and
// tests/stack/restore-drill.test.ts from the image, and both are written and have not been run.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  countNeedsAttention,
  decideIntentAfterRestore,
  tenantOfObject,
  type LedgerReader,
  type ObjectStore,
  type ReapplyResult,
  type RestoreReport,
  type TenantRestoreReport,
} from '@ensemus/application';
import type { AppDatabase } from '@ensemus/database';
import {
  BACKUP_MANIFEST_FILE,
  mayRestoreObject,
  objectManifestText,
  parseObjectManifest,
} from '@ensemus/sovereign/backup';
import { exportRecipientPublicKey, generateRecipientKeyPair } from '@ensemus/sovereign/sealed';
import { ledgerKeyFor, ledgerRef } from '@ensemus/domain/tombstone-ledger';
import { WorkflowNotFoundError } from '@temporalio/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { RESTORE_CONTRIBUTORS } from './restore-contributors';
import {
  createRunProbe,
  readReconcileArguments,
  restoreReconcileCommand,
} from './restore-reconcile-command';
import { objectsFromParts, openComponent, readManifest, verifyBackup } from './tools/open-parts';
import { readRecipient, sealComponent, writeSealedManifest } from './tools/seal-parts';

const folder = mkdtempSync(join(tmpdir(), 'restore-reconcile-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

const fileWith = (text: string) => {
  const path = join(folder, `${randomUUID()}.txt`);
  writeFileSync(path, text);
  return path;
};

const entry = () =>
  ledgerRef({ organizationId: randomUUID(), targetType: 'artifact', targetId: randomUUID() });

const emptyLedger: ReapplyResult = {
  entries: 0,
  tombstonesAdded: 0,
  artifactsRemoved: 0,
  bytesRemoved: 0,
  organizationsMissing: 0,
  invalid: 0,
  unconfirmed: 0,
  failed: 0,
};

const quietTenant = (organizationId: string): TenantRestoreReport => ({
  organizationId,
  runsClosed: 0,
  runsUnknown: 0,
  runsOpen: 0,
  actionsNeedingReview: 0,
  actionsMovedToUnknown: 0,
  actionsReadyUnattempted: 0,
  unreferencedObjects: 0,
  artifactsMissingBytes: 0,
  bytesUnchecked: 0,
  checksFailed: 0,
  contributors: [],
});

const noStore = {} as ObjectStore & LedgerReader;
const noDatabase = {} as AppDatabase;

function run(args: string[], report: Partial<RestoreReport> = {}) {
  const lines: string[] = [];
  const reconcile = vi.fn(async (): Promise<RestoreReport> => ({
    mode: args.includes('--apply') ? 'apply' : 'report',
    ledger: emptyLedger,
    tenants: [],
    objectsWithoutTenant: 0,
    contributorsNotRun: [],
    needsAttention: 0,
    ...report,
  }));
  const quarantine = vi.fn(async () => undefined);
  const result = restoreReconcileCommand(args, {
    database: noDatabase,
    store: noStore,
    listOrganizations: async () => ['00000000-0000-4000-8000-000000000001'],
    probeRun: async () => 'unknown',
    contributors: [],
    write: (line) => lines.push(line),
    reconcile: reconcile as never,
    quarantine: quarantine as never,
  });
  return { result, lines, reconcile, quarantine };
}

describe('the arguments', () => {
  it('reports and changes nothing unless it is told to apply', () => {
    expect(readReconcileArguments([]).mode).toBe('report');
    expect(readReconcileArguments(['--apply']).mode).toBe('apply');
  });

  it('takes the confirmations the re-apply takes, from the command line and from a file', () => {
    const [one, two, three] = [entry(), entry(), entry()];
    const parsed = readReconcileArguments([
      '--apply',
      '--confirm',
      one,
      '--confirm-file',
      fileWith(`${two}\n${three}\n`),
    ]);
    expect([...parsed.confirmed].sort()).toEqual([one, two, three].sort());
  });

  it.each([
    ['an option nobody wrote', ['--everything']],
    ['a word that is not an option', ['apply']],
    ['a confirmation that is not an entry', ['--confirm', 'all']],
    ['a wildcard', ['--confirm', `${randomUUID()}:artifact:*`]],
    ['a confirm file that is not there', ['--confirm-file', join(folder, 'missing.txt')]],
    ['a confirm file with a pattern in it', ['--confirm-file', fileWith(`${randomUUID()}:*:*\n`)]],
    ['a confirm file with nothing in it', ['--confirm-file', fileWith('')]],
    ['a quarantine that is not an entry', ['--apply', '--quarantine', 'everything']],
    ['a quarantine with no apply, which would have to change something', ['--quarantine', entry()]],
  ])('refuses %s with status 2, having done nothing', async (_name, args) => {
    const { result, reconcile, quarantine } = run(args);
    await expect(result).resolves.toBe(2);
    expect(reconcile).not.toHaveBeenCalled();
    expect(quarantine).not.toHaveBeenCalled();
  });
});

describe('the command', () => {
  it('asks for report mode by default, and quarantines nothing', async () => {
    const { result, reconcile, quarantine } = run([]);
    await expect(result).resolves.toBe(0);
    expect(reconcile).toHaveBeenCalledWith(
      noDatabase,
      noStore,
      expect.objectContaining({ mode: 'report' }),
    );
    expect(quarantine).not.toHaveBeenCalled();
  });

  it('asks to apply only when told, and passes on what was confirmed', async () => {
    const ref = entry();
    const { result, reconcile } = run(['--apply', '--confirm', ref]);
    await expect(result).resolves.toBe(0);
    const input = (
      reconcile.mock.calls as unknown as [unknown, unknown, Record<string, never>][]
    )[0]?.[2];
    expect(input).toMatchObject({ mode: 'apply' });
    expect((input?.ledgerOptions as { confirmed: Set<string> }).confirmed.has(ref)).toBe(true);
  });

  it('moves a quarantined object aside before anything else looks at the ledger', async () => {
    const ref = entry();
    const { result, reconcile, quarantine } = run(['--apply', '--quarantine', ref]);
    await expect(result).resolves.toBe(0);
    expect(quarantine).toHaveBeenCalledOnce();
    expect(quarantine.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      reconcile.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('exits 1 when anything needs a person, and 0 only when nothing does', async () => {
    await expect(run([], { needsAttention: 1 }).result).resolves.toBe(1);
    await expect(run([], { needsAttention: 0 }).result).resolves.toBe(0);
  });

  it('exits 1 when the reconcile itself fails, as when the ledger cannot be read', async () => {
    const reconcile = vi.fn(async () => {
      throw new Error('store down at http://objects:8333 for owner@example.invalid');
    });
    const lines: string[] = [];
    const code = await restoreReconcileCommand([], {
      database: noDatabase,
      store: noStore,
      listOrganizations: async () => [],
      probeRun: async () => 'unknown',
      contributors: [],
      write: (line) => lines.push(line),
      reconcile: reconcile as never,
    });
    expect(code).toBe(1);
    expect(lines.join('')).not.toContain('example.invalid');
  });

  it('says on every run that the connector worker has to stay stopped, and that nothing enforces it', async () => {
    const { result, lines } = run([]);
    await result;
    const [reminder] = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(reminder).toMatchObject({
      event: 'restore_reconcile.reminder',
      reasonCode: 'CONNECTOR_WORKER_STAYS_STOPPED_UNTIL_REVIEWED',
      enforcedByCode: false,
    });
  });

  it('prints counts and IDs a line at a time, each one JSON', async () => {
    const organizationId = randomUUID();
    const { result, lines } = run(['--apply'], {
      tenants: [{ ...quietTenant(organizationId), unreferencedObjects: 2 }],
      needsAttention: 2,
    });
    await result;
    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed.map((line) => line.event)).toEqual([
      'restore_reconcile.reminder',
      'restore_reconcile.ledger',
      'restore_reconcile.tenant',
      'restore_reconcile.finished',
    ]);
    expect(parsed[2]).toMatchObject({ organizationId, unreferencedObjects: 2 });
    expect(parsed[3]).toMatchObject({ needsAttention: 2, tenants: 1 });
  });

  it('starts with no contributors of its own, until M4 and M5 add theirs', () => {
    expect(RESTORE_CONTRIBUTORS).toEqual([]);
  });
});

describe('asking Temporal about a run', () => {
  const input = { organizationId: randomUUID(), workUnitId: randomUUID(), runId: randomUUID() };
  const answering = (name: string) => createRunProbe(async () => ({ status: { name } }));

  it('calls a running one open', async () => {
    await expect(answering('RUNNING')(input)).resolves.toBe('open');
  });

  it.each(['COMPLETED', 'FAILED', 'CANCELLED', 'TERMINATED', 'TIMED_OUT', 'CONTINUED_AS_NEW'])(
    'calls %s closed',
    async (name) => {
      await expect(answering(name)(input)).resolves.toBe('closed');
    },
  );

  it('calls a run Temporal has no record of closed', async () => {
    const probe = createRunProbe(async () => {
      throw new WorkflowNotFoundError('not found', 'workflow', 'run');
    });
    await expect(probe(input)).resolves.toBe('closed');
  });

  it.each(['UNSPECIFIED', 'UNKNOWN', 'SOMETHING_NEW'])(
    'never takes a status it does not know, %s, to mean closed',
    async (name) => {
      await expect(answering(name)(input)).resolves.toBe('unknown');
    },
  );

  it('never takes an outage to mean closed', async () => {
    const probe = createRunProbe(async () => {
      throw Object.assign(new Error('unavailable'), { code: 14 });
    });
    await expect(probe(input)).resolves.toBe('unknown');
  });
});

describe('what an intent gets', () => {
  it.each([
    // Only with an attempt that ended with no answer, which is the trigger's own condition.
    ['reconciling', ['indeterminate'], 'to_unknown'],
    ['sending', ['indeterminate'], 'to_unknown'],
    ['sending', ['not_sent', 'indeterminate'], 'to_unknown'],
    // An attempt still open is not ended, and this never writes its outcome.
    ['sending', [null], 'review'],
    ['sending', ['not_sent', null], 'review'],
    ['reconciling', [null], 'review'],
    // Anything the trigger would refuse is reported instead of tried.
    ['sending', [], 'review'],
    ['reconciling', [], 'review'],
    ['sending', ['not_sent'], 'review'],
    ['reconciling', ['accepted'], 'review'],
    ['sending', ['accepted', 'indeterminate'], 'review'],
    // A retry could go out from here, and this does not start one.
    ['ready', ['not_sent'], 'review'],
    ['ready', [], 'ready_unattempted'],
    // Already in front of a person, and stays there.
    ['unknown', ['indeterminate'], 'review'],
    // Nothing can have happened, or it is over.
    ['awaiting_approval', [], 'none'],
    ['sent', ['accepted'], 'none'],
    ['failed', ['rejected'], 'none'],
    ['cancelled', [], 'none'],
  ] as const)('%s with attempts %j: %s', (status, outcomes, expected) => {
    expect(decideIntentAfterRestore(status, outcomes)).toBe(expected);
  });
});

describe('what counts as needing a person', () => {
  const organizationId = randomUUID();
  const base = {
    ledger: emptyLedger,
    tenants: [quietTenant(organizationId)],
    objectsWithoutTenant: 0,
  };

  it('is nothing, when there is nothing', () => {
    expect(countNeedsAttention({ ...base, mode: 'apply' })).toBe(0);
    expect(countNeedsAttention({ ...base, mode: 'report' })).toBe(0);
  });

  it.each(['failed', 'invalid', 'unconfirmed'] as const)('counts a ledger entry %s', (count) => {
    const ledger = { ...emptyLedger, [count]: 1 };
    expect(countNeedsAttention({ ...base, ledger, mode: 'apply' })).toBe(1);
  });

  it.each([
    'runsUnknown',
    'actionsNeedingReview',
    'unreferencedObjects',
    'artifactsMissingBytes',
    'bytesUnchecked',
    'checksFailed',
  ] as const)('counts %s', (count) => {
    const tenants = [{ ...quietTenant(organizationId), [count]: 1 }];
    expect(countNeedsAttention({ ...base, tenants, mode: 'apply' })).toBe(1);
  });

  it('counts what a contributor says, and objects with no tenant', () => {
    const tenants = [
      {
        ...quietTenant(organizationId),
        contributors: [{ name: 'test', checked: 3, changed: 1, needsAttention: 2 }],
      },
    ];
    expect(countNeedsAttention({ ...base, tenants, mode: 'apply' })).toBe(2);
    expect(countNeedsAttention({ ...base, objectsWithoutTenant: 3, mode: 'apply' })).toBe(3);
  });

  it('does not count what was done, or a run still going, once it has been applied', () => {
    const tenants = [{ ...quietTenant(organizationId), runsClosed: 2, runsOpen: 4 }];
    const ledger = { ...emptyLedger, entries: 3, tombstonesAdded: 1, bytesRemoved: 1 };
    expect(countNeedsAttention({ ...base, tenants, ledger, mode: 'apply' })).toBe(0);
  });

  it('does count it in report mode, where it has not been done, so a clean report means nothing to do', () => {
    const tenants = [{ ...quietTenant(organizationId), runsClosed: 2, runsOpen: 4 }];
    const ledger = { ...emptyLedger, entries: 3, tombstonesAdded: 1, bytesRemoved: 1 };
    expect(countNeedsAttention({ ...base, tenants, ledger, mode: 'report' })).toBe(4);
  });
});

describe('who an object belongs to', () => {
  const organizationId = randomUUID();
  const exportId = randomUUID();

  it.each([
    [`${organizationId}/artifacts/${randomUUID()}`, organizationId],
    [`organization-exports/v1/${organizationId}/${exportId}/manifest.json.sealed`, organizationId],
  ])('reads the tenant from %s', (key, expected) => {
    expect(tenantOfObject(key)).toBe(expected);
  });

  it.each([
    ledgerKeyFor({ organizationId, targetType: 'artifact', targetId: randomUUID() }),
    'something/else',
    '',
  ])('does not guess one for %j', (key) => {
    expect(tenantOfObject(key)).toBeNull();
  });
});

describe('sealing and opening a backup', () => {
  const owner = generateRecipientKeyPair();
  const stranger = generateRecipientKeyPair();

  async function* chunks(...items: Buffer[]) {
    for (const item of items) yield item;
  }

  async function aBackup() {
    const dir = mkdtempSync(join(folder, 'backup-'));
    const dump = Buffer.from(Array.from({ length: 5000 }, (_, at) => at % 256));
    const parts = await sealComponent(chunks(dump), {
      component: 'postgres_ensemus',
      recipient: owner.publicKey,
      folder: dir,
      maxBytes: 2048,
    });
    const { manifest, sealedSha256 } = await writeSealedManifest({
      folder: dir,
      recipient: owner.publicKey,
      releaseVersion: '0.0.0-test',
      databaseSchemaVersion: 'test',
      components: [{ component: 'postgres_ensemus', parts }],
    });
    return { dir, dump, parts, manifest, sealedSha256 };
  }

  async function bytesOf(source: AsyncIterable<Buffer>) {
    const held: Buffer[] = [];
    for await (const piece of source) held.push(piece);
    return Buffer.concat(held);
  }

  it('splits at the limit and reads back the same bytes, in order', async () => {
    const { dir, dump, parts } = await aBackup();
    expect(parts.map((part) => part.file)).toEqual([
      'postgres_ensemus/000001.sealed',
      'postgres_ensemus/000002.sealed',
      'postgres_ensemus/000003.sealed',
    ]);
    const manifest = await readManifest(dir, owner.privateKey);
    const opened = await bytesOf(
      openComponent(dir, manifest, 'postgres_ensemus', owner.privateKey),
    );
    expect(opened.equals(dump)).toBe(true);
  });

  it('writes a manifest that says the ledger is out', async () => {
    const { manifest } = await aBackup();
    expect(manifest.excludes_tombstone_ledger).toBe(true);
    expect(manifest.format).toBe('ensemus.backup');
  });

  it('verifies a whole backup, and gives the hash for the record', async () => {
    const { dir, manifest, sealedSha256 } = await aBackup();
    await expect(verifyBackup(dir, owner.privateKey)).resolves.toMatchObject({
      backup_id: manifest.backup_id,
      parts: 3,
      plain_bytes: 5000,
      manifest_sealed_sha256: sealedSha256,
    });
  });

  it('will not open it with the wrong key', async () => {
    const { dir } = await aBackup();
    await expect(verifyBackup(dir, stranger.privateKey)).rejects.toMatchObject({
      code: 'WRONG_KEY',
    });
  });

  it('refuses a changed part', async () => {
    const { dir, parts } = await aBackup();
    const path = join(dir, parts[1]?.file ?? '');
    const size = statSync(path).size;
    writeFileSync(path, Buffer.alloc(size, 7));
    await expect(verifyBackup(dir, owner.privateKey)).rejects.toMatchObject({
      code: 'PART_HASH_DIFFERS',
    });
  });

  it('refuses a part that was cut short', async () => {
    const { dir, parts } = await aBackup();
    writeFileSync(join(dir, parts[0]?.file ?? ''), Buffer.from('short'));
    await expect(verifyBackup(dir, owner.privateKey)).rejects.toMatchObject({
      code: 'PART_SIZE_DIFFERS',
    });
  });

  it('refuses a part someone removed', async () => {
    const { dir, parts } = await aBackup();
    rmSync(join(dir, parts[2]?.file ?? ''));
    await expect(verifyBackup(dir, owner.privateKey)).rejects.toThrow();
  });

  it('refuses a file nobody listed', async () => {
    const { dir } = await aBackup();
    writeFileSync(join(dir, 'postgres_ensemus', '000004.sealed'), 'extra');
    await expect(verifyBackup(dir, owner.privateKey)).rejects.toMatchObject({
      code: 'FILE_NOT_LISTED',
    });
  });

  it('refuses a link where a part should be', async (context) => {
    const { dir, parts } = await aBackup();
    const path = join(dir, parts[0]?.file ?? '');
    rmSync(path);
    try {
      symlinkSync(fileWith('elsewhere'), path);
    } catch {
      // Making a link takes a privilege on Windows, and the rule is the same without this run proving it.
      context.skip();
    }
    await expect(verifyBackup(dir, owner.privateKey)).rejects.toMatchObject({
      code: 'LINK_REFUSED',
    });
  });

  it('will not write over an earlier backup', async () => {
    const { dir } = await aBackup();
    await expect(
      writeSealedManifest({
        folder: dir,
        recipient: owner.publicKey,
        releaseVersion: '0.0.0-test',
        databaseSchemaVersion: 'test',
        components: [],
      }),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect(readdirSync(dir)).toContain(BACKUP_MANIFEST_FILE);
  });

  it('reads a recipient the way the customer gives one', async () => {
    const path = fileWith(`${exportRecipientPublicKey(owner.publicKey)}\n`);
    const key = await readRecipient(path);
    expect(key.equals(owner.publicKey)).toBe(true);
  });

  it('carries objects through the parts and out again, whole, with no ledger key among them', async () => {
    const one = Buffer.from('first object');
    const two = Buffer.alloc(3000, 2);
    const dir = mkdtempSync(join(folder, 'objects-'));
    const hash = (body: Buffer) =>
      import('node:crypto').then(({ createHash }) =>
        createHash('sha256').update(body).digest('hex'),
      );
    const lines = [
      { key: `${randomUUID()}/artifacts/${randomUUID()}`, sha256: await hash(one), bytes: 12 },
      { key: `${randomUUID()}/artifacts/${randomUUID()}`, sha256: await hash(two), bytes: 3000 },
    ];
    const objectParts = await sealComponent(chunks(one, two), {
      component: 'objects',
      recipient: owner.publicKey,
      folder: dir,
      maxBytes: 1024,
    });
    const { manifest } = await writeSealedManifest({
      folder: dir,
      recipient: owner.publicKey,
      releaseVersion: '0.0.0-test',
      databaseSchemaVersion: 'test',
      components: [{ component: 'objects', parts: objectParts }],
    });
    const read = parseObjectManifest(objectManifestText(lines));
    const restored = [];
    for await (const { line, body } of objectsFromParts(
      read,
      openComponent(dir, manifest, 'objects', owner.privateKey),
    )) {
      expect(mayRestoreObject(line.key)).toBe(true);
      restored.push(body.length);
    }
    expect(restored).toEqual([12, 3000]);
  });
});
