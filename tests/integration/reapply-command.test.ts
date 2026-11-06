// The operator's command (ADR-026 D3) through real database roles, with a store in memory. Its exit
// status is what the runbook tells people to go by. tests/stack/restore.test.ts runs it from the image.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addArtifact,
  createWorkUnit,
  objectKey,
  type LedgerReader,
  type ObjectStore,
} from '@ensemus/application';
import {
  createOrganization,
  openAppDatabase,
  resolveTenantContext,
  type TenantContext,
} from '@ensemus/database';
import {
  ledgerKeyFor,
  ledgerRef,
  quarantineKeyFor,
  serializeLedgerEntry,
} from '@ensemus/domain/tombstone-ledger';
import { urls } from '../helpers/stack';
import { reapplyCommand } from '../../workers/workflow/src/reapply-command';

class MemoryStore implements ObjectStore, LedgerReader {
  readonly objects = new Map<string, Buffer>();
  async put(key: string, body: Buffer) {
    this.objects.set(key, body);
  }
  async get(key: string) {
    const body = this.objects.get(key);
    if (!body) throw new Error('missing');
    return body;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async exists(key: string) {
    return this.objects.has(key);
  }
  async *listPages(prefix: string) {
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix));
    if (keys.length > 0) yield keys;
  }
}

describe('the re-apply command', () => {
  let app: ReturnType<typeof openAppDatabase>;
  let auth: pg.Client;
  const folder = mkdtempSync(join(tmpdir(), 'reapply-command-'));

  beforeAll(async () => {
    app = openAppDatabase(urls.app());
    auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
  });

  afterAll(async () => {
    rmSync(folder, { recursive: true, force: true });
    await app?.close();
    await auth?.end();
  });

  async function newOrg(): Promise<TenantContext> {
    const id = randomUUID();
    await auth.query('insert into identity.users (id, name, email) values ($1, $2, $3)', [
      id,
      'owner',
      `owner-${id}@example.invalid`,
    ]);
    const { organizationId } = await createOrganization(app.db, {
      userId: id,
      name: 'Org',
      commercialMode: 'byom',
    });
    return resolveTenantContext(app.db, id, organizationId);
  }

  /** A file still whole, in a store of its own, and an entry naming it that nobody has confirmed. */
  async function wholeFile(store: MemoryStore, context: TenantContext, name = 'whole.txt') {
    const work = await createWorkUnit(app.db, context, { title: 'W' });
    const file = await addArtifact(app.db, store, context, {
      workUnitId: work.id,
      name,
      mimeType: 'text/plain',
      body: Buffer.from(name),
    });
    const entry = {
      organizationId: context.organizationId,
      targetType: 'artifact',
      targetId: file.id,
      deletedAt: new Date(),
    };
    await store.put(ledgerKeyFor(entry), serializeLedgerEntry(entry));
    return { id: file.id, ref: ledgerRef(entry), key: ledgerKeyFor(entry) };
  }

  const run = (store: MemoryStore, ...args: string[]) =>
    reapplyCommand(args, { database: app.db, store });

  const bytesOf = (context: TenantContext, id: string) => objectKey(context.organizationId, id);

  const listing = (...lines: string[]) => {
    const path = join(folder, `${randomUUID()}.txt`);
    writeFileSync(path, `${lines.join('\n')}\n`);
    return path;
  };

  it('exits non-zero while an entry waits for a decision, and zero with none', async () => {
    const store = new MemoryStore();
    const a = await newOrg();
    const file = await wholeFile(store, a);
    await expect(run(store)).resolves.toBe(1);
    expect(store.objects.has(bytesOf(a, file.id))).toBe(true);

    await expect(run(store, '--confirm', file.ref)).resolves.toBe(0);
    expect(store.objects.has(bytesOf(a, file.id))).toBe(false);
    await expect(run(store)).resolves.toBe(0);
  });

  it('exits non-zero for an object that is not an entry, and zero once it is moved aside', async () => {
    const store = new MemoryStore();
    const a = await newOrg();
    const key = ledgerKeyFor({
      organizationId: a.organizationId,
      targetType: 'artifact',
      targetId: randomUUID(),
    });
    await store.put(key, Buffer.from('not an entry'));
    await expect(run(store)).resolves.toBe(1);
    await expect(run(store, '--quarantine', key)).resolves.toBe(0);
    expect(store.objects.has(quarantineKeyFor(key))).toBe(true);
  });

  it('exits non-zero for an entry it could not finish', async () => {
    const store = new MemoryStore();
    const a = await newOrg();
    const file = await wholeFile(store, a);
    store.delete = async () => {
      throw new Error('store refused');
    };
    await expect(run(store, '--confirm', file.ref)).resolves.toBe(1);
  });

  describe('with a list of entries', () => {
    it('confirms every entry the list names', async () => {
      const store = new MemoryStore();
      const a = await newOrg();
      const b = await newOrg();
      const files = [
        await wholeFile(store, a, 'one.txt'),
        await wholeFile(store, a, 'two.txt'),
        await wholeFile(store, b, 'three.txt'),
      ];
      await expect(
        run(store, '--confirm-file', listing(...files.map((file) => file.ref))),
      ).resolves.toBe(0);
      expect(store.objects.has(bytesOf(a, files[0]!.id))).toBe(false);
      expect(store.objects.has(bytesOf(a, files[1]!.id))).toBe(false);
      expect(store.objects.has(bytesOf(b, files[2]!.id))).toBe(false);
    });

    it('does not destroy a live file the list leaves out, even in the same tenant', async () => {
      const store = new MemoryStore();
      const a = await newOrg();
      const real = await wholeFile(store, a, 'real.txt');
      const forged = await wholeFile(store, a, 'forged.txt');
      await expect(run(store, '--confirm-file', listing(real.ref))).resolves.toBe(1);
      expect(store.objects.has(bytesOf(a, real.id))).toBe(false);
      // What the forged entry named is still there, and its tenant is still waiting for a decision.
      expect(store.objects.has(bytesOf(a, forged.id))).toBe(true);
      expect(store.objects.has(forged.key)).toBe(true);
    });

    it('does nothing at all for a list with one line it cannot take', async () => {
      const store = new MemoryStore();
      const a = await newOrg();
      const file = await wholeFile(store, a);
      const another = await wholeFile(store, a, 'another.txt');
      const everything = `${a.organizationId}:artifact:*`;
      await expect(
        run(
          store,
          '--confirm',
          another.ref,
          '--quarantine',
          another.ref,
          '--confirm-file',
          listing(file.ref, everything),
        ),
      ).resolves.toBe(2);
      expect(store.objects.has(bytesOf(a, file.id))).toBe(true);
      expect(store.objects.has(bytesOf(a, another.id))).toBe(true);
      expect(store.objects.has(another.key)).toBe(true);
    });

    it('goes together with --confirm and --quarantine', async () => {
      const store = new MemoryStore();
      const a = await newOrg();
      const listed = await wholeFile(store, a, 'listed.txt');
      const named = await wholeFile(store, a, 'named.txt');
      const forged = await wholeFile(store, a, 'forged.txt');
      await expect(
        run(
          store,
          '--confirm-file',
          listing(listed.ref),
          '--confirm',
          named.ref,
          '--quarantine',
          forged.ref,
        ),
      ).resolves.toBe(0);
      expect(store.objects.has(bytesOf(a, listed.id))).toBe(false);
      expect(store.objects.has(bytesOf(a, named.id))).toBe(false);
      expect(store.objects.has(bytesOf(a, forged.id))).toBe(true);
    });
  });
});
