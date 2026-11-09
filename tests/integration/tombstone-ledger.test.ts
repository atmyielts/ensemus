// LIFE-01, ADR-026: a tombstone survives a database restore. Through real database roles, with a store
// in memory. tests/stack/restore.test.ts does the same with a real dump, restore and object store.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptInvitation,
  addArtifact,
  countUnappliedTombstones,
  createInvitation,
  createRestoreGate,
  createWorkUnit,
  deleteArtifact,
  getApproval,
  getWorkUnit,
  listMyNotifications,
  objectKey,
  purgeDueBlobs,
  quarantineLedgerObject,
  readArtifact,
  reapplyTombstoneLedger,
  requestExecution,
  requestWorkReview,
  transitionWorkUnit,
  updateWorkUnit,
  type LedgerReader,
  type ObjectStore,
} from '@ensemus/application';
import {
  createOrganization,
  openAppDatabase,
  resolveTenantContext,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import {
  dispatchDueEvents,
  eventBacklog,
  openDispatcherDatabase,
} from '@ensemus/database/dispatcher';
import { createServiceContext } from '@ensemus/database/service';
import {
  ledgerKeyFor,
  ledgerRef,
  quarantineKeyFor,
  serializeLedgerEntry,
  TOMBSTONE_RECORDED,
  type LedgerEntry,
} from '@ensemus/domain/tombstone-ledger';
import { createActivities } from '@ensemus/workflows/activities';
import { sql } from 'drizzle-orm';
import { urls } from '../helpers/stack';

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
  // Explicit test-only unversioned map model, as in saas-lifecycle-fixture. The ordinary purge needs
  // these two, as it does from the production S3 adapter, to certify that bytes are gone.
  async deleteForPurge(key: string) {
    try {
      await this.delete(key);
    } catch {
      return { transport: 'unknown' as const, capabilityVerified: false };
    }
    return { transport: 'deleted' as const, capabilityVerified: true };
  }
  async isPhysicallyAbsent(key: string) {
    return !this.objects.has(key);
  }
  async *listPages(prefix: string) {
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix));
    // Two to a page, so that nothing here can pass by reading only the first.
    for (let at = 0; at < keys.length; at += 2) yield keys.slice(at, at + 2);
  }
}

describe('the tombstone ledger', () => {
  let app: ReturnType<typeof openAppDatabase>;
  let dispatcher: ReturnType<typeof openDispatcherDatabase>;
  let su: pg.Client;
  let auth: pg.Client;
  const db = () => app.db;

  async function makeUser(label: string) {
    const id = randomUUID();
    const email = `${label}-${id}@example.invalid`;
    await auth.query('insert into identity.users (id, name, email) values ($1, $2, $3)', [
      id,
      label,
      email,
    ]);
    return { id, email };
  }

  async function newOrg(): Promise<TenantContext> {
    const user = await makeUser('owner');
    const { organizationId } = await createOrganization(db(), {
      userId: user.id,
      name: `Ledger ${randomUUID()}`,
      commercialMode: 'sovereign',
    });
    return resolveTenantContext(db(), user.id, organizationId);
  }

  async function join(context: TenantContext, label: string) {
    const user = await makeUser(label);
    const { token } = await createInvitation(db(), context, {
      email: user.email,
      role: 'admin',
    });
    await auth.query('update identity.users set email_verified=true where id=$1', [user.id]);
    await acceptInvitation(db(), {
      token,
      userId: user.id,
      email: user.email,
      emailVerified: true,
    });
    return resolveTenantContext(db(), user.id, context.organizationId);
  }

  const file = (context: TenantContext, store: ObjectStore, workUnitId: string, name = 'f.txt') =>
    addArtifact(db(), store, context, {
      workUnitId,
      name,
      mimeType: 'text/plain',
      body: Buffer.from(`bytes of ${name}`),
    });

  /** A deletion this database knows nothing about, which is what a restore leaves behind. */
  function inLedger(
    store: MemoryStore,
    organizationId: string,
    targetId: string,
    deletedAt = new Date('2026-11-01T09:00:00.000Z'),
  ) {
    const entry = { organizationId, targetType: 'artifact', targetId, deletedAt };
    store.objects.set(ledgerKeyFor(entry), serializeLedgerEntry(entry));
    return ledgerKeyFor(entry);
  }

  /** Everything a re-apply could change, so a second run can be shown to change none of it. */
  const stateOf = async (organizationId: string) => ({
    tombstones: (
      await su.query(
        'select target_id, created_at from platform.tombstones where organization_id = $1 order by 1',
        [organizationId],
      )
    ).rows,
    artifacts: (
      await su.query('select id from work.artifacts where organization_id = $1 order by 1', [
        organizationId,
      ])
    ).rows,
    links: (
      await su.query(
        'select artifact_id from work.work_artifacts where organization_id = $1 order by 1',
        [organizationId],
      )
    ).rows,
    blobs: (
      await su.query(
        'select artifact_id, state, purged_at, attempts from platform.blob_lifecycle where organization_id = $1 order by 1',
        [organizationId],
      )
    ).rows,
    audit: (
      await su.query(
        'select count(*)::int as n from governance.audit_events where organization_id = $1',
        [organizationId],
      )
    ).rows,
  });

  beforeAll(async () => {
    app = openAppDatabase(urls.app());
    dispatcher = openDispatcherDatabase(urls.dispatcher());
    su = new pg.Client({ connectionString: urls.superuser() });
    await su.connect();
    auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
  });

  afterAll(async () => {
    await app?.close();
    await dispatcher?.close();
    await su?.end();
    await auth?.end();
  });

  describe('deleting a file', () => {
    it('queues its tombstone for the ledger in the same transaction, with IDs only', async () => {
      const a = await newOrg();
      const store = new MemoryStore();
      const work = await createWorkUnit(db(), a, { title: 'Quarterly numbers' });
      const { id } = await file(a, store, work.id, 'board minutes.pdf');
      await deleteArtifact(db(), store, a, { workUnitId: work.id, artifactId: id });

      const { rows } = await su.query(
        `select e.aggregate_type, e.aggregate_id, e.payload, o.state
         from platform.domain_events e
         join platform.outbox_events o on o.event_id = e.id and o.organization_id = e.organization_id
         where e.organization_id = $1 and e.event_type = $2`,
        [a.organizationId, TOMBSTONE_RECORDED],
      );
      expect(rows).toEqual([
        {
          aggregate_type: 'artifact',
          aggregate_id: id,
          payload: { artifact_id: id },
          state: 'queued',
        },
      ]);
    });

    it('queues nothing when the deletion is refused, including across tenants', async () => {
      const a = await newOrg();
      const b = await newOrg();
      const store = new MemoryStore();
      const work = await createWorkUnit(db(), a, { title: 'W' });
      const { id } = await file(a, store, work.id);
      await expect(
        deleteArtifact(db(), store, b, { workUnitId: work.id, artifactId: id }),
      ).rejects.toEqual(expect.objectContaining({ code: 'NOT_FOUND' }));
      const { rows } = await su.query(
        'select id from platform.domain_events where event_type = $1 and organization_id = any($2)',
        [TOMBSTONE_RECORDED, [a.organizationId, b.organizationId]],
      );
      expect(rows).toEqual([]);
    });
  });

  describe('when the ledger cannot be written', () => {
    /** Clears everything else that is due, so each test sees only its own events. */
    const drain = () =>
      su.query(`update platform.outbox_events set state = 'published' where state = 'queued'`);

    beforeEach(drain);

    it('costs no attempts, holds nothing else up, and shows in the backlog', async () => {
      const a = await newOrg();
      const store = new MemoryStore();
      const work = await createWorkUnit(db(), a, { title: 'W' });
      const { id } = await file(a, store, work.id);
      await drain();
      await deleteArtifact(db(), store, a, { workUnitId: work.id, artifactId: id });

      // Delivered oldest first, so this one is behind the tombstone. An outage would make it wait.
      await createWorkUnit(db(), a, { title: 'Behind it in the queue' });

      const delivered: string[] = [];
      const result = await dispatchDueEvents(
        dispatcher.db,
        async (event) => {
          if (event.eventType === TOMBSTONE_RECORDED) throw new Error('store is down');
          delivered.push(event.eventType);
        },
        { classify: () => 'partial_outage' },
      );
      const types = delivered.slice();
      expect(types[0]).toBe('work.artifact_deleted');
      expect(types.length).toBeGreaterThanOrEqual(2);
      expect(result).toEqual({ handled: types.length, failed: 0, deferred: 1, dead: 0 });

      const { rows } = await su.query(
        `select o.state, o.attempts, o.next_attempt_at > now() as waiting
         from platform.outbox_events o
         join platform.domain_events e on e.id = o.event_id and e.organization_id = o.organization_id
         where e.organization_id = $1 and e.event_type = $2`,
        [a.organizationId, TOMBSTONE_RECORDED],
      );
      expect(rows).toEqual([{ state: 'queued', attempts: 0, waiting: true }]);

      const backlog = await eventBacklog(dispatcher.db, TOMBSTONE_RECORDED);
      expect(backlog.queued).toBe(1);
      expect(backlog.dead).toBe(0);
      expect(backlog.oldestSeconds).toBeGreaterThanOrEqual(0);

      // Once it can be delivered it is, and the backlog is empty.
      await su.query(
        `update platform.outbox_events set next_attempt_at = now() where state = 'queued'`,
      );
      const seen: { eventType: string; occurredAt: Date; aggregateId: string }[] = [];
      await dispatchDueEvents(dispatcher.db, async (event) => {
        seen.push(event);
      });
      expect(seen).toEqual([
        expect.objectContaining({
          eventType: TOMBSTONE_RECORDED,
          aggregateId: id,
          occurredAt: expect.any(Date),
        }),
      ]);
      expect(await eventBacklog(dispatcher.db, TOMBSTONE_RECORDED)).toEqual({
        queued: 0,
        dead: 0,
        oldestSeconds: 0,
      });
    });

    it('counts only tombstones in the backlog, not other events', async () => {
      const a = await newOrg();
      await createWorkUnit(db(), a, { title: 'Another event entirely' });
      expect((await eventBacklog(dispatcher.db, TOMBSTONE_RECORDED)).queued).toBe(0);
    });

    it('writes a tombstone during a Temporal outage, which it does not need Temporal for', async () => {
      const a = await newOrg();
      const store = new MemoryStore();
      const work = await createWorkUnit(db(), a, { title: 'W' });
      const { id } = await file(a, store, work.id);
      await drain();
      // Ahead of the tombstone in the queue, with something else behind it.
      await updateWorkUnit(db(), a, work.id, 1, { title: 'Ahead of it' });
      await deleteArtifact(db(), store, a, { workUnitId: work.id, artifactId: id });
      await createWorkUnit(db(), a, { title: 'Behind it' });

      const written: string[] = [];
      let tried = 0;
      const result = await dispatchDueEvents(
        dispatcher.db,
        async (event) => {
          if (event.eventType === TOMBSTONE_RECORDED) {
            written.push(event.aggregateId);
            return;
          }
          tried += 1;
          throw new Error('Temporal is down');
        },
        {
          classify: () => 'outage',
          needsOnlyTheStore: (event) => event.eventType === TOMBSTONE_RECORDED,
        },
      );

      expect(written).toEqual([id]);
      // The first failure still holds everything that needs Temporal, instead of a timeout each.
      expect(tried).toBe(1);
      expect(result.handled).toBe(1);
      expect(result.deferred).toBeGreaterThanOrEqual(2);
      expect(await eventBacklog(dispatcher.db, TOMBSTONE_RECORDED)).toMatchObject({ queued: 0 });
    });
  });

  describe('noticing a database that went back in time', () => {
    it('finds nothing when the ledger is empty', async () => {
      const a = await newOrg();
      expect(await countUnappliedTombstones(db(), new MemoryStore(), a)).toBe(0);
    });

    it('finds nothing when the ledger is only behind, as it is in ordinary running', async () => {
      const a = await newOrg();
      const store = new MemoryStore();
      const work = await createWorkUnit(db(), a, { title: 'W' });
      const { id } = await file(a, store, work.id);
      await deleteArtifact(db(), store, a, { workUnitId: work.id, artifactId: id });
      expect(await countUnappliedTombstones(db(), store, a)).toBe(0);
      inLedger(store, a.organizationId, id);
      expect(await countUnappliedTombstones(db(), store, a)).toBe(0);
    });

    it('counts every entry the database lacks, across pages of the listing', async () => {
      const a = await newOrg();
      const store = new MemoryStore();
      for (let n = 0; n < 5; n += 1) inLedger(store, a.organizationId, randomUUID());
      expect(await countUnappliedTombstones(db(), store, a)).toBe(5);
    });

    it("does not count another tenant's entries, or anything that is not an entry", async () => {
      const a = await newOrg();
      const b = await newOrg();
      const store = new MemoryStore();
      inLedger(store, b.organizationId, randomUUID());
      store.objects.set(`tombstone-ledger/v1/${a.organizationId}/junk`, Buffer.from('x'));
      expect(await countUnappliedTombstones(db(), store, a)).toBe(0);
      expect(await countUnappliedTombstones(db(), store, b)).toBe(1);
    });

    it("cannot be satisfied by another tenant's tombstone for the same ID", async () => {
      const a = await newOrg();
      const b = await newOrg();
      const store = new MemoryStore();
      const work = await createWorkUnit(db(), b, { title: 'W' });
      const { id } = await file(b, store, work.id);
      await deleteArtifact(db(), store, b, { workUnitId: work.id, artifactId: id });
      inLedger(store, a.organizationId, id);
      expect(await countUnappliedTombstones(db(), store, a)).toBe(1);
    });
  });

  describe('the serving gate', () => {
    const closed = expect.objectContaining({ code: 'RESTORE_PENDING' });

    function gateOver(store: Pick<LedgerReader, 'listPages'>) {
      let clock = 1_000_000;
      const failures: unknown[] = [];
      const gate = createRestoreGate({
        database: db(),
        store,
        now: () => clock,
        onCheckFailed: (error) => failures.push(error),
      });
      return { gate, failures, pass: (ms: number) => (clock += ms) };
    }

    it('lets a tenant through when its database knows every entry', async () => {
      const a = await newOrg();
      const { gate } = gateOver(new MemoryStore());
      await expect(gate.assertServing(a)).resolves.toBeUndefined();
    });

    it('refuses from the first request while the database is behind', async () => {
      const a = await newOrg();
      const store = new MemoryStore();
      inLedger(store, a.organizationId, randomUUID());
      const { gate } = gateOver(store);
      await expect(gate.assertServing(a)).rejects.toEqual(closed);
    });

    it('opens again by itself once the ledger has been re-applied', async () => {
      const a = await newOrg();
      const store = new MemoryStore();
      inLedger(store, a.organizationId, randomUUID());
      const { gate, pass } = gateOver(store);
      await expect(gate.assertServing(a)).rejects.toEqual(closed);

      await reapplyTombstoneLedger(db(), store, createServiceContext);
      // A closed answer is remembered only briefly.
      pass(2_001);
      await expect(gate.assertServing(a)).resolves.toBeUndefined();
    });

    it('notices a restore under a running process within its interval', async () => {
      const a = await newOrg();
      const store = new MemoryStore();
      const { gate, pass } = gateOver(store);
      await gate.assertServing(a);

      inLedger(store, a.organizationId, randomUUID());
      pass(29_000);
      await expect(gate.assertServing(a)).resolves.toBeUndefined();
      pass(1_001);
      await expect(gate.assertServing(a)).rejects.toEqual(closed);
    });

    it('closes for one tenant and not for another', async () => {
      const a = await newOrg();
      const b = await newOrg();
      const store = new MemoryStore();
      inLedger(store, a.organizationId, randomUUID());
      const { gate } = gateOver(store);
      await expect(gate.assertServing(a)).rejects.toEqual(closed);
      await expect(gate.assertServing(b)).resolves.toBeUndefined();
    });

    it('does not let a store outage stop the product, and reports it', async () => {
      const a = await newOrg();
      const { gate, failures } = gateOver({
        // eslint-disable-next-line require-yield
        async *listPages() {
          throw new Error('store is down');
        },
      });
      await expect(gate.assertServing(a)).resolves.toBeUndefined();
      expect(failures).toHaveLength(1);
    });

    it('stays closed if the store goes down while it is closed', async () => {
      const a = await newOrg();
      const store = new MemoryStore();
      inLedger(store, a.organizationId, randomUUID());
      let down = false;
      const { gate, pass } = gateOver({
        listPages: (prefix) => {
          if (down) throw new Error('store is down');
          return store.listPages(prefix);
        },
      });
      await expect(gate.assertServing(a)).rejects.toEqual(closed);
      down = true;
      pass(2_001);
      await expect(gate.assertServing(a)).rejects.toEqual(closed);
    });

    it('asks once for many requests at the same moment, and then remembers', async () => {
      const a = await newOrg();
      const store = new MemoryStore();
      let asked = 0;
      const { gate, pass } = gateOver({
        listPages: (prefix) => {
          asked += 1;
          return store.listPages(prefix);
        },
      });
      await Promise.all([gate.assertServing(a), gate.assertServing(a), gate.assertServing(a)]);
      expect(asked).toBe(1);
      await gate.assertServing(a);
      expect(asked).toBe(1);
      pass(30_001);
      await gate.assertServing(a);
      expect(asked).toBe(2);
    });

    /** A store that answers only when told to, and fails or lists nothing depending on the test. */
    function heldStore() {
      const store = new MemoryStore();
      let asked = 0;
      let down = false;
      let release: () => void = () => undefined;
      let held: Promise<void> | null = null;
      return {
        store,
        asked: () => asked,
        goDown: () => (down = true),
        comeBack: () => (down = false),
        hold: () => (held = new Promise((done) => (release = done))),
        release: () => {
          held = null;
          release();
        },
        reader: {
          async *listPages(prefix: string) {
            asked += 1;
            if (held) await held;
            if (down) throw new Error('store is down');
            yield* store.listPages(prefix);
          },
        },
      };
    }

    it('makes nobody wait again once a check has failed, for as long as the store stays down', async () => {
      const a = await newOrg();
      const held = heldStore();
      const { gate, failures, pass } = gateOver(held.reader);
      await gate.assertServing(a);

      held.goDown();
      pass(30_001);
      // The check that finds out: this one can wait, and it reports the failure.
      await gate.assertServing(a);
      expect(failures).toHaveLength(1);
      expect(held.asked()).toBe(2);

      // The store now hangs. If anyone waited for this check, the test would never get past here.
      held.hold();
      pass(30_001);
      await expect(gate.assertServing(a)).resolves.toBeUndefined();
      await expect(gate.assertServing(a)).resolves.toBeUndefined();
      expect(held.asked()).toBe(3);

      // It finishes behind them, and the answer holds for the next ones.
      held.comeBack();
      inLedger(held.store, a.organizationId, randomUUID());
      held.release();
      await expect
        .poll(() =>
          gate.assertServing(a).then(
            () => 'open',
            () => 'closed',
          ),
        )
        .toBe('closed');
    });

    it('stays closed without waiting while the store is down', async () => {
      const a = await newOrg();
      const held = heldStore();
      inLedger(held.store, a.organizationId, randomUUID());
      const { gate, pass } = gateOver(held.reader);
      await expect(gate.assertServing(a)).rejects.toEqual(closed);

      held.goDown();
      pass(2_001);
      await expect(gate.assertServing(a)).rejects.toEqual(closed);

      held.hold();
      pass(2_001);
      await expect(gate.assertServing(a)).rejects.toEqual(closed);
      held.release();
    });

    it('waits for one check no longer than its limit, however many pages it has to read', async () => {
      const a = await newOrg();
      const held = heldStore();
      held.hold();
      const reported: unknown[] = [];
      const gate = createRestoreGate({
        database: db(),
        store: held.reader,
        now: () => 1_000_000,
        waitMs: 300,
        onCheckFailed: (error) => reported.push(error),
      });
      // The first check of this tenant has nothing to go on, and is not left waiting for ever.
      await expect(gate.assertServing(a)).resolves.toBeUndefined();
      expect(reported).toEqual([expect.objectContaining({ code: 'CHECK_TIMEOUT' })]);
      // Everyone else asking meanwhile does not start the wait again.
      const started = Date.now();
      await expect(gate.assertServing(a)).resolves.toBeUndefined();
      expect(Date.now() - started).toBeLessThan(200);
      expect(held.asked()).toBe(1);

      // The slow check still counts when it ends, so a slow store cannot hide a restore for good.
      inLedger(held.store, a.organizationId, randomUUID());
      held.release();
      await expect
        .poll(() =>
          gate.assertServing(a).then(
            () => 'open',
            () => 'closed',
          ),
        )
        .toBe('closed');
    });

    it('still refuses at the first request after its interval while the store is healthy', async () => {
      const a = await newOrg();
      const store = new MemoryStore();
      const { gate, pass } = gateOver(store);
      await gate.assertServing(a);
      inLedger(store, a.organizationId, randomUUID());
      pass(30_001);
      await expect(gate.assertServing(a)).rejects.toEqual(closed);
    });

    describe('with a store that is slow and still answers', () => {
      /** With limits a test can sit through. The clock is ours, and the waits are real. */
      function slowGate(store: Pick<LedgerReader, 'listPages'>) {
        let clock = 1_000_000;
        const reported: unknown[] = [];
        const gate = createRestoreGate({
          database: db(),
          store,
          now: () => clock,
          waitMs: 800,
          recheckWaitMs: 300,
          onCheckFailed: (error) => reported.push(error),
        });
        return { gate, reported, pass: (ms: number) => (clock += ms) };
      }

      /** Long enough for a check that was let go to finish behind the requests. */
      const settled = () => new Promise((done) => setTimeout(done, 100));

      /** How long the promise took to settle. */
      async function timed(answer: Promise<unknown>) {
        const started = performance.now();
        await answer;
        return performance.now() - started;
      }

      const answerOf = (gate: ReturnType<typeof createRestoreGate>, context: TenantContext) =>
        gate.assertServing(context).then(
          () => 'open',
          () => 'closed',
        );

      it('waits for the first check only, however long the store goes on taking', async () => {
        const a = await newOrg();
        const held = heldStore();
        const { gate, reported, pass } = slowGate(held.reader);

        // The first check past its limit. Requests have nothing to go on, and this is the owner's call.
        held.hold();
        await expect(gate.assertServing(a)).resolves.toBeUndefined();
        expect(reported).toEqual([expect.objectContaining({ code: 'CHECK_TIMEOUT' })]);
        // It answers in the end, without ever failing, so nothing has gone wrong except the time.
        held.release();
        await settled();

        for (let round = 2; round <= 4; round += 1) {
          held.hold();
          pass(30_001);
          // The store hangs here, so anything that waited for this check would take the full limit.
          expect(await timed(gate.assertServing(a))).toBeLessThan(100);
          expect(held.asked()).toBe(round);
          // Held for longer than any limit, so each of these is a slow answer and not a quick one.
          await new Promise((done) => setTimeout(done, 350));
          held.release();
          await settled();
        }
      });

      it('does not wait for a store that stays under the first limit either', async () => {
        const a = await newOrg();
        const slow = {
          async *listPages(prefix: string) {
            await new Promise((done) => setTimeout(done, 400));
            yield* new MemoryStore().listPages(prefix);
          },
        };
        const { gate, reported, pass } = slowGate(slow);
        await gate.assertServing(a);
        expect(reported).toEqual([]);

        pass(30_001);
        expect(await timed(gate.assertServing(a))).toBeLessThan(100);
      });

      it('still says so, and still counts what the slow check found', async () => {
        const a = await newOrg();
        const held = heldStore();
        const { gate, reported, pass } = slowGate(held.reader);
        held.hold();
        await gate.assertServing(a);
        held.release();
        await settled();
        reported.length = 0;

        // Answered from memory while it runs, and it is said aloud once it has gone past the limit.
        held.hold();
        pass(30_001);
        await gate.assertServing(a);
        inLedger(held.store, a.organizationId, randomUUID());
        await expect.poll(() => reported.length, { timeout: 2_000 }).toBe(1);
        expect(reported).toEqual([expect.objectContaining({ code: 'CHECK_TIMEOUT' })]);

        // A slow store delays the answer and never hides a restore from it.
        held.release();
        await expect.poll(() => answerOf(gate, a)).toBe('closed');
      });

      it('never holds a request for the first limit once it has an answer to give', async () => {
        const a = await newOrg();
        const held = heldStore();
        const { gate, reported, pass } = slowGate(held.reader);
        await gate.assertServing(a);
        expect(reported).toEqual([]);

        // Healthy until now, so this one does wait, but only for a moment.
        held.hold();
        pass(30_001);
        expect(await timed(gate.assertServing(a))).toBeLessThan(600);
        expect(reported).toEqual([expect.objectContaining({ code: 'CHECK_TIMEOUT' })]);
        held.release();
      });

      it('goes back to refusing at the first request once the store is quick again', async () => {
        const a = await newOrg();
        const held = heldStore();
        const { gate, pass } = slowGate(held.reader);
        held.hold();
        await gate.assertServing(a);
        held.release();
        await settled();

        // This check runs behind the request and finds the store quick.
        pass(30_001);
        await gate.assertServing(a);
        await settled();

        inLedger(held.store, a.organizationId, randomUUID());
        pass(30_001);
        await expect(gate.assertServing(a)).rejects.toEqual(closed);
      });

      it('answers a closed tenant from memory too, without waiting', async () => {
        const a = await newOrg();
        const held = heldStore();
        inLedger(held.store, a.organizationId, randomUUID());
        const { gate, pass } = slowGate(held.reader);
        held.hold();
        await gate.assertServing(a);
        held.release();
        await expect.poll(() => answerOf(gate, a)).toBe('closed');

        held.hold();
        pass(2_001);
        const started = performance.now();
        await expect(gate.assertServing(a)).rejects.toEqual(closed);
        expect(performance.now() - started).toBeLessThan(100);
        held.release();
      });
    });
  });

  describe('re-applying the ledger', () => {
    /** What an operator says for an entry naming a file that is still whole. */
    const confirming = (organizationId: string, ...ids: string[]) => ({
      confirmed: new Set(
        ids.map((targetId) => ledgerRef({ organizationId, targetType: 'artifact', targetId })),
      ),
    });

    /** The usual state after a restore: the row came back, and the bytes went at deletion. */
    const withoutBytes = (store: MemoryStore, organizationId: string, id: string) =>
      store.objects.delete(objectKey(organizationId, id));

    it('blocks the file, removes its references and its bytes, and leaves other files', async () => {
      const a = await newOrg();
      const store = new MemoryStore();
      const work = await createWorkUnit(db(), a, { title: 'W' });
      const doomed = await file(a, store, work.id, 'doomed.txt');
      const kept = await file(a, store, work.id, 'kept.txt');
      const deletedAt = new Date('2026-10-30T08:30:00.000Z');
      inLedger(store, a.organizationId, doomed.id, deletedAt);

      // Without this, the file is simply there. The rest of this test could not pass by accident.
      expect(
        (await readArtifact(db(), store, a, { workUnitId: work.id, artifactId: doomed.id })).name,
      ).toBe('doomed.txt');

      const result = await reapplyTombstoneLedger(
        db(),
        store,
        createServiceContext,
        undefined,
        confirming(a.organizationId, doomed.id),
      );
      expect(result).toMatchObject({
        tombstonesAdded: 1,
        artifactsRemoved: 1,
        bytesRemoved: 1,
        organizationsMissing: 0,
        invalid: 0,
        failed: 0,
      });

      await expect(
        readArtifact(db(), store, a, { workUnitId: work.id, artifactId: doomed.id }),
      ).rejects.toEqual(expect.objectContaining({ code: 'NOT_FOUND' }));
      expect(store.objects.has(objectKey(a.organizationId, doomed.id))).toBe(false);
      expect(
        (await readArtifact(db(), store, a, { workUnitId: work.id, artifactId: kept.id })).name,
      ).toBe('kept.txt');

      const state = await stateOf(a.organizationId);
      expect(state.tombstones).toEqual([{ target_id: doomed.id, created_at: deletedAt }]);
      expect(state.artifacts).toEqual([{ id: kept.id }]);
      expect(state.links).toEqual([{ artifact_id: kept.id }]);
      expect(state.blobs).toEqual([
        expect.objectContaining({
          artifact_id: doomed.id,
          state: 'purged',
          purged_at: expect.any(Date),
        }),
      ]);
      const { rows } = await su.query(
        `select actor_type, target_ref, safe_reason, decision from governance.audit_events
         where organization_id = $1 and action = 'artifact.deletion_reapplied'`,
        [a.organizationId],
      );
      expect(rows).toEqual([
        {
          actor_type: 'system',
          target_ref: `artifact:${doomed.id}`,
          safe_reason: 'RESTORE_REAPPLY',
          decision: 'allow',
        },
      ]);
    });

    it('changes nothing the second time', async () => {
      const a = await newOrg();
      const store = new MemoryStore();
      const work = await createWorkUnit(db(), a, { title: 'W' });
      const doomed = await file(a, store, work.id);
      inLedger(store, a.organizationId, doomed.id);
      withoutBytes(store, a.organizationId, doomed.id);
      const first = await reapplyTombstoneLedger(db(), store, createServiceContext);
      expect(first.tombstonesAdded).toBeGreaterThanOrEqual(1);
      const before = await stateOf(a.organizationId);
      const objects = [...store.objects.keys()].sort();

      const second = await reapplyTombstoneLedger(db(), store, createServiceContext, (error) => {
        throw error;
      });
      expect(second).toEqual({
        entries: first.entries,
        tombstonesAdded: 0,
        artifactsRemoved: 0,
        bytesRemoved: 0,
        organizationsMissing: first.organizationsMissing,
        invalid: 0,
        unconfirmed: 0,
        failed: 0,
      });
      expect(await stateOf(a.organizationId)).toEqual(before);
      expect([...store.objects.keys()].sort()).toEqual(objects);
    });

    it('removes bytes that came back after an earlier run, without rewriting the record', async () => {
      const a = await newOrg();
      const store = new MemoryStore();
      const work = await createWorkUnit(db(), a, { title: 'W' });
      const doomed = await file(a, store, work.id);
      inLedger(store, a.organizationId, doomed.id);
      withoutBytes(store, a.organizationId, doomed.id);
      await reapplyTombstoneLedger(db(), store, createServiceContext);
      const before = await stateOf(a.organizationId);

      // An object store rolled back separately from the database. The database's own tombstone says
      // this file was deleted, so this needs nobody's word for it.
      const key = objectKey(a.organizationId, doomed.id);
      store.objects.set(key, Buffer.from('back again'));
      const again = await reapplyTombstoneLedger(db(), store, createServiceContext);
      expect(again.bytesRemoved).toBe(1);
      expect(store.objects.has(key)).toBe(false);
      expect(await stateOf(a.organizationId)).toEqual(before);
    });

    it("cannot reach another tenant's file, whatever an entry says", async () => {
      const a = await newOrg();
      const b = await newOrg();
      const store = new MemoryStore();
      const theirs = await createWorkUnit(db(), b, { title: 'Theirs' });
      const victim = await file(b, store, theirs.id, 'theirs.txt');
      // An entry filed under one organization, naming a file that belongs to another.
      inLedger(store, a.organizationId, victim.id);

      await reapplyTombstoneLedger(db(), store, createServiceContext);

      expect(
        (await readArtifact(db(), store, b, { workUnitId: theirs.id, artifactId: victim.id })).name,
      ).toBe('theirs.txt');
      expect(store.objects.has(objectKey(b.organizationId, victim.id))).toBe(true);
      const { rows } = await su.query(
        'select organization_id from platform.tombstones where target_id = $1',
        [victim.id],
      );
      expect(rows).toEqual([{ organization_id: a.organizationId }]);
    });

    it('closes an open review that covered the file, as the deletion itself did', async () => {
      const a = await newOrg();
      const approver = await join(a, 'approver');
      const store = new MemoryStore();
      const work = await createWorkUnit(db(), a, { title: 'W' });
      const doomed = await file(a, store, work.id);
      const review = await requestWorkReview(db(), a, {
        workUnitId: work.id,
        expectedVersion: 1,
        approverMembershipId: approver.membershipId,
      });
      inLedger(store, a.organizationId, doomed.id);
      withoutBytes(store, a.organizationId, doomed.id);

      await reapplyTombstoneLedger(db(), store, createServiceContext);

      const approval = await getApproval(db(), a, review.id);
      expect(approval.approval.status).toBe('cancelled');
    });

    const resolvedOutcomes = async (workUnitId: string) =>
      (
        await su.query(
          `select payload->>'outcome' as outcome from platform.domain_events
           where aggregate_id = $1 and event_type = 'approval.resolved'`,
          [workUnitId],
        )
      ).rows.map((row: { outcome: string }) => row.outcome);

    it('tells people when the review it closes was holding manual work, which stays paused', async () => {
      const a = await newOrg();
      const asker = await join(a, 'asker');
      const approver = await join(a, 'approver');
      const store = new MemoryStore();
      const work = await createWorkUnit(db(), a, { title: 'W' });
      const doomed = await file(a, store, work.id);
      let current = await getWorkUnit(db(), a, work.id);
      for (const to of ['ready', 'running'] as const) {
        current = await transitionWorkUnit(db(), a, {
          id: work.id,
          expectedVersion: current.version,
          to,
        });
      }
      await requestWorkReview(db(), asker, {
        workUnitId: work.id,
        expectedVersion: current.version,
        approverMembershipId: approver.membershipId,
      });
      expect((await getWorkUnit(db(), a, work.id)).status).toBe('awaiting_approval');
      inLedger(store, a.organizationId, doomed.id);
      withoutBytes(store, a.organizationId, doomed.id);

      await reapplyTombstoneLedger(db(), store, createServiceContext);

      // Only a decision can release it, and there is now nothing to decide, so someone has to ask.
      expect((await getWorkUnit(db(), a, work.id)).status).toBe('awaiting_approval');
      expect(await resolvedOutcomes(work.id)).toEqual(['cancelled']);
      const told = async (context: TenantContext) =>
        (await listMyNotifications(db(), context)).map((n) => n.kind);
      expect(await told(a)).toContain('approval.outdated');
      expect(await told(asker)).toContain('approval.outdated');
    });

    it('ends the run when the review it closes was holding a plan', async () => {
      const a = await newOrg();
      const approver = await join(a, 'approver');
      const store = new MemoryStore();
      const work = await createWorkUnit(db(), a, {
        title: 'W',
        executionPlan: 'checklist',
        completionCriteria: [{ kind: 'reviewer_approved' }],
      });
      const doomed = await file(a, store, work.id);
      const edited = await getWorkUnit(db(), a, work.id);
      await transitionWorkUnit(db(), a, {
        id: work.id,
        expectedVersion: edited.version,
        to: 'ready',
      });
      await requestExecution(db(), a, work.id, { reviewerMembershipId: approver.membershipId });
      const activities = createActivities({ database: db(), store });
      const run = { organizationId: a.organizationId, workUnitId: work.id, runId: randomUUID() };
      await activities.prepareWork(run);
      await activities.requestReview(run);
      expect((await getWorkUnit(db(), a, work.id)).status).toBe('awaiting_approval');
      inLedger(store, a.organizationId, doomed.id);
      withoutBytes(store, a.organizationId, doomed.id);

      await reapplyTombstoneLedger(db(), store, createServiceContext);

      const after = await getWorkUnit(db(), a, work.id);
      expect(after.status).toBe('failed');
      expect(after.runId).toBeNull();
      expect(await resolvedOutcomes(work.id)).toEqual(['cancelled']);
      expect((await listMyNotifications(db(), a)).map((n) => n.kind)).toContain('work.failed');
    });

    describe('when an entry names a file that is still whole', () => {
      /** A live file, and an entry for it that only someone with the ledger credential could write. */
      async function forged() {
        const a = await newOrg();
        const store = new MemoryStore();
        const work = await createWorkUnit(db(), a, { title: 'W' });
        const live = await file(a, store, work.id, 'live.txt');
        inLedger(store, a.organizationId, live.id);
        return { a, store, work, live };
      }

      it('does not destroy it on the ledger word alone, and says which entry it is', async () => {
        const { a, store, work, live } = await forged();
        const before = await stateOf(a.organizationId);
        const named: LedgerEntry[] = [];

        const result = await reapplyTombstoneLedger(db(), store, createServiceContext, undefined, {
          onUnconfirmed: (entry) => named.push(entry),
        });

        expect(result).toMatchObject({
          unconfirmed: 1,
          tombstonesAdded: 0,
          artifactsRemoved: 0,
          bytesRemoved: 0,
          failed: 0,
        });
        expect(named.map((entry) => entry.targetId)).toEqual([live.id]);
        expect(await stateOf(a.organizationId)).toEqual(before);
        expect(store.objects.has(objectKey(a.organizationId, live.id))).toBe(true);
        expect(
          (await readArtifact(db(), store, a, { workUnitId: work.id, artifactId: live.id })).name,
        ).toBe('live.txt');
        // The tenant stays refused, because nobody has yet said what this entry is.
        expect(await countUnappliedTombstones(db(), store, a)).toBe(1);
      });

      it('applies it once an operator confirms that entry, and no other', async () => {
        const { a, store, work, live } = await forged();
        const other = await file(a, store, work.id, 'other.txt');
        inLedger(store, a.organizationId, other.id);

        const result = await reapplyTombstoneLedger(
          db(),
          store,
          createServiceContext,
          undefined,
          confirming(a.organizationId, live.id),
        );

        expect(result).toMatchObject({ unconfirmed: 1, artifactsRemoved: 1, bytesRemoved: 1 });
        expect(store.objects.has(objectKey(a.organizationId, live.id))).toBe(false);
        expect(store.objects.has(objectKey(a.organizationId, other.id))).toBe(true);
      });

      it('applies by itself when the bytes have gone, so an ordinary restore needs no decision', async () => {
        const { a, store, live } = await forged();
        withoutBytes(store, a.organizationId, live.id);

        const result = await reapplyTombstoneLedger(db(), store, createServiceContext);

        expect(result).toMatchObject({
          unconfirmed: 0,
          tombstonesAdded: 1,
          artifactsRemoved: 1,
          bytesRemoved: 0,
        });
        expect(await countUnappliedTombstones(db(), store, a)).toBe(0);
      });

      it('changes nothing if the store cannot say whether the bytes exist', async () => {
        const { a, store, work, live } = await forged();
        const before = await stateOf(a.organizationId);
        const blind = Object.assign(Object.create(store) as MemoryStore, {
          exists: async () => {
            throw new Error('store is down');
          },
        });

        const result = await reapplyTombstoneLedger(db(), blind, createServiceContext);

        expect(result).toMatchObject({ failed: 1, unconfirmed: 0, artifactsRemoved: 0 });
        expect(await stateOf(a.organizationId)).toEqual(before);
        expect(
          (await readArtifact(db(), store, a, { workUnitId: work.id, artifactId: live.id })).name,
        ).toBe('live.txt');
      });
    });

    describe('quarantining an entry', () => {
      it('takes a forged entry out of the ledger, opens the gate, and keeps it for inspection', async () => {
        const a = await newOrg();
        const store = new MemoryStore();
        const work = await createWorkUnit(db(), a, { title: 'W' });
        const live = await file(a, store, work.id, 'live.txt');
        const key = inLedger(store, a.organizationId, live.id);
        const body = store.objects.get(key);
        expect(await countUnappliedTombstones(db(), store, a)).toBe(1);

        await quarantineLedgerObject(db(), store, createServiceContext, key);

        expect(store.objects.has(key)).toBe(false);
        expect(store.objects.get(quarantineKeyFor(key))).toEqual(body);
        expect(await countUnappliedTombstones(db(), store, a)).toBe(0);
        const again = await reapplyTombstoneLedger(db(), store, createServiceContext);
        expect(again).toMatchObject({ unconfirmed: 0, artifactsRemoved: 0, invalid: 0 });
        expect(
          (await readArtifact(db(), store, a, { workUnitId: work.id, artifactId: live.id })).name,
        ).toBe('live.txt');
        const { rows } = await su.query(
          `select actor_type, target_ref, safe_reason from governance.audit_events
           where organization_id = $1 and action = 'tombstone_ledger.entry_quarantined'`,
          [a.organizationId],
        );
        expect(rows).toEqual([
          {
            actor_type: 'system',
            target_ref: `artifact:${live.id}`,
            safe_reason: 'OPERATOR_QUARANTINE',
          },
        ]);
      });

      it('clears an object that is not a valid entry, which otherwise refuses the tenant for good', async () => {
        const a = await newOrg();
        const store = new MemoryStore();
        const id = randomUUID();
        const key = ledgerKeyFor({
          organizationId: a.organizationId,
          targetType: 'artifact',
          targetId: id,
        });
        store.objects.set(key, Buffer.from(''));
        expect((await reapplyTombstoneLedger(db(), store, createServiceContext)).invalid).toBe(1);
        expect(await countUnappliedTombstones(db(), store, a)).toBe(1);

        await quarantineLedgerObject(db(), store, createServiceContext, key);

        expect(await countUnappliedTombstones(db(), store, a)).toBe(0);
        expect((await reapplyTombstoneLedger(db(), store, createServiceContext)).invalid).toBe(0);
      });

      it('touches nothing outside the ledger', async () => {
        const a = await newOrg();
        const store = new MemoryStore();
        const work = await createWorkUnit(db(), a, { title: 'W' });
        const live = await file(a, store, work.id, 'live.txt');
        const bytes = objectKey(a.organizationId, live.id);
        await expect(
          quarantineLedgerObject(db(), store, createServiceContext, bytes),
        ).rejects.toEqual(expect.objectContaining({ code: 'INVALID_INPUT' }));
        expect(store.objects.has(bytes)).toBe(true);
      });

      it('moves an entry of an organization this backup predates, with no audit row to write', async () => {
        const store = new MemoryStore();
        const missing = randomUUID();
        const key = inLedger(store, missing, randomUUID());
        await quarantineLedgerObject(db(), store, createServiceContext, key);
        expect(store.objects.has(key)).toBe(false);
        expect(store.objects.has(quarantineKeyFor(key))).toBe(true);
      });
    });

    it('leaves the bytes marked as still to remove if the store refuses, and blocks access', async () => {
      const a = await newOrg();
      const store = new MemoryStore();
      const work = await createWorkUnit(db(), a, { title: 'W' });
      const doomed = await file(a, store, work.id);
      inLedger(store, a.organizationId, doomed.id);
      const refusing = Object.assign(Object.create(store) as MemoryStore, {
        delete: async () => {
          throw new Error('store refused');
        },
      });
      const errors: unknown[] = [];

      const result = await reapplyTombstoneLedger(
        db(),
        refusing,
        createServiceContext,
        (error) => errors.push(error),
        confirming(a.organizationId, doomed.id),
      );
      expect(result.failed).toBe(1);
      expect(result.bytesRemoved).toBe(0);
      expect(errors).toHaveLength(1);
      expect(store.objects.has(objectKey(a.organizationId, doomed.id))).toBe(true);
      await expect(
        readArtifact(db(), store, a, { workUnitId: work.id, artifactId: doomed.id }),
      ).rejects.toEqual(expect.objectContaining({ code: 'NOT_FOUND' }));

      // The ordinary sweep can finish it, and so can running this again.
      expect(await purgeDueBlobs(db(), store, a)).toEqual({ purged: 1, failed: 0 });
      expect(store.objects.has(objectKey(a.organizationId, doomed.id))).toBe(false);
      expect((await stateOf(a.organizationId)).blobs).toEqual([
        expect.objectContaining({ state: 'purged' }),
      ]);
      expect((await reapplyTombstoneLedger(db(), store, createServiceContext)).failed).toBe(0);
    });

    it('takes an upload the backup caught in flight through to purged', async () => {
      const a = await newOrg();
      const store = new MemoryStore();
      const id = randomUUID();
      const key = objectKey(a.organizationId, id);
      store.objects.set(key, Buffer.from('uploaded'));
      await withTenantTx(db(), a, (tx) =>
        tx.execute(sql`
          insert into platform.blob_lifecycle (organization_id, artifact_id, object_key, state, purge_after)
          values (${a.organizationId}, ${id}, ${key}, 'uploading', now() + interval '1 hour')`),
      );
      inLedger(store, a.organizationId, id);

      const result = await reapplyTombstoneLedger(db(), store, createServiceContext);
      expect(result).toMatchObject({ tombstonesAdded: 1, artifactsRemoved: 0, bytesRemoved: 1 });
      expect(store.objects.has(key)).toBe(false);
      expect((await stateOf(a.organizationId)).blobs).toEqual([
        expect.objectContaining({ artifact_id: id, state: 'purged' }),
      ]);
    });

    it('removes the bytes of an organization this backup predates, and writes no rows', async () => {
      const store = new MemoryStore();
      const missing = randomUUID();
      const id = randomUUID();
      const key = objectKey(missing, id);
      store.objects.set(key, Buffer.from('from an organization the backup never saw'));
      inLedger(store, missing, id);

      const result = await reapplyTombstoneLedger(db(), store, createServiceContext);
      expect(result.organizationsMissing).toBe(1);
      expect(result.bytesRemoved).toBe(1);
      expect(result.failed).toBe(0);
      expect(store.objects.has(key)).toBe(false);
      const { rows } = await su.query(
        'select 1 from platform.tombstones where organization_id = $1',
        [missing],
      );
      expect(rows).toEqual([]);
    });

    it('reports an object that is not a valid entry, acts on nothing in it, and carries on', async () => {
      const a = await newOrg();
      const store = new MemoryStore();
      const work = await createWorkUnit(db(), a, { title: 'W' });
      const named = await file(a, store, work.id, 'named.txt');
      const good = await file(a, store, work.id, 'good.txt');
      store.objects.set(
        ledgerKeyFor({
          organizationId: a.organizationId,
          targetType: 'artifact',
          targetId: named.id,
        }),
        Buffer.from('{"not":"an entry"}'),
      );
      inLedger(store, a.organizationId, good.id);
      withoutBytes(store, a.organizationId, good.id);

      const result = await reapplyTombstoneLedger(db(), store, createServiceContext);
      expect(result.invalid).toBe(1);
      expect(result.artifactsRemoved).toBe(1);
      expect(store.objects.has(objectKey(a.organizationId, named.id))).toBe(true);
      expect((await stateOf(a.organizationId)).artifacts).toEqual([{ id: named.id }]);
      // Its key still names a deletion the database lacks, so someone has to look at it.
      expect(await countUnappliedTombstones(db(), store, a)).toBe(1);
    });
  });
});
