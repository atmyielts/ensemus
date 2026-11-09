// QA-025, ADR-030 D11: after a restore, nothing revoked comes back, nothing goes out again, and what cannot be
// settled by a machine reaches a person. Through real database roles, with a store in memory held by this test.
// tests/stack/restore-drill.test.ts does the same with real dumps and a real store.
//
// As in tests/integration/tombstone-ledger.test.ts, a restore older than a deletion is what it leaves behind:
// the row is there, the ledger knows of the deletion, and the database does not.
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addArtifact,
  createRestoreContributors,
  createRestoreGate,
  createWorkUnit,
  getWorkUnit,
  objectKey,
  readArtifact,
  reconcileAfterRestore,
  REQUIRED_RESTORE_CONTRIBUTORS,
  requestExecution,
  transitionWorkUnit,
  type ContributorReport,
  type LedgerReader,
  type ObjectStore,
  type RestoreContributor,
  type RestoreFinding,
  type RunProbe,
} from '@ensemus/application';
import {
  createOrganization,
  openAppDatabase,
  withTenantTx,
  externalActionAttempts,
  externalActions,
  type TenantContext,
} from '@ensemus/database';
import { listOrganizationIds, openDispatcherDatabase } from '@ensemus/database/dispatcher';
import { createServiceContext } from '@ensemus/database/service';
import type { ExternalActionStatus } from '@ensemus/domain/external-action';
import { exportObjectKey } from '@ensemus/domain/portability';
import { ledgerKeyFor, ledgerRef, serializeLedgerEntry } from '@ensemus/domain/tombstone-ledger';
import { createActivities } from '@ensemus/workflows/activities';
import { eq } from 'drizzle-orm';
import { restoreReconcileCommand } from '../../workers/workflow/src/restore-reconcile-command';
import { seedConnection, seedExternalAction } from '../helpers/integrations';
import { seedExportRow, testRecipient, nativeSovereignContext } from '../helpers/sovereign';
import { urls } from '../helpers/stack';

class MemoryStore implements ObjectStore, LedgerReader {
  readonly objects = new Map<string, Buffer>();
  readonly read: string[] = [];
  failOn = (_key: string) => false;
  async put(key: string, body: Buffer) {
    this.objects.set(key, body);
  }
  async get(key: string) {
    this.read.push(key);
    if (this.failOn(key)) throw new Error('The store did not answer');
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
    // Two to a page, so that nothing here can pass by reading only the first.
    for (let at = 0; at < keys.length; at += 2) yield keys.slice(at, at + 2);
  }
}

type RequiredContributor = (typeof REQUIRED_RESTORE_CONTRIBUTORS)[number];

describe('reconciling after a restore', () => {
  let app: ReturnType<typeof openAppDatabase>;
  let dispatcher: ReturnType<typeof openDispatcherDatabase>;
  let su: pg.Client;
  let auth: pg.Client;
  const db = () => app.db;

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

  async function newOrg(): Promise<TenantContext> {
    const id = randomUUID();
    await auth.query('insert into identity.users (id, name, email) values ($1, $2, $3)', [
      id,
      'owner',
      `owner-${id}@example.invalid`,
    ]);
    // The same name each time: nothing here may tell two tenants apart by what they are called.
    const { organizationId } = await createOrganization(db(), {
      userId: id,
      name: 'Same Name Ltd',
      commercialMode: 'sovereign',
    });
    return nativeSovereignContext(db(), id, organizationId);
  }

  const file = (context: TenantContext, store: MemoryStore, workUnitId: string, name: string) =>
    addArtifact(db(), store, context, {
      workUnitId,
      name,
      mimeType: 'text/plain',
      body: Buffer.from(`bytes of ${name}`),
    });

  function inLedger(store: MemoryStore, organizationId: string, targetId: string) {
    const entry = {
      organizationId,
      targetType: 'artifact',
      targetId,
      deletedAt: new Date('2026-11-01T09:00:00.000Z'),
    };
    store.objects.set(ledgerKeyFor(entry), serializeLedgerEntry(entry));
    return ledgerRef(entry);
  }

  /** Everything a run could change for a tenant, so a run can be shown to change none of it. */
  const stateOf = async (organizationId: string) => {
    const rows = async (text: string) => (await su.query(text, [organizationId])).rows;
    return {
      tombstones: await rows(
        'select target_id, created_at from platform.tombstones where organization_id = $1 order by 1',
      ),
      artifacts: await rows('select id from work.artifacts where organization_id = $1 order by 1'),
      links: await rows(
        'select artifact_id, work_unit_id from work.work_artifacts where organization_id = $1 order by 1, 2',
      ),
      blobs: await rows(
        'select artifact_id, state, purged_at from platform.blob_lifecycle where organization_id = $1 order by 1',
      ),
      audit: await rows(
        'select count(*)::int as n from governance.audit_events where organization_id = $1',
      ),
      events: await rows(
        'select count(*)::int as n from platform.domain_events where organization_id = $1',
      ),
      work: await rows(
        'select id, status, version, run_id from work.work_units where organization_id = $1 order by 1',
      ),
      actions: await rows(
        'select id, status, version, status_reason from integrations.external_actions where organization_id = $1 order by 1',
      ),
      attempts: await rows(
        'select id, outcome, outcome_code from integrations.external_action_attempts where organization_id = $1 order by 1',
      ),
      receipts: await rows(
        'select id, outcome, basis from integrations.external_action_receipts where organization_id = $1 order by 1',
      ),
      notifications: await rows(
        'select count(*)::int as n from platform.notifications where organization_id = $1',
      ),
    };
  };

  /**
   * reconcileAfterRestore refuses to run without exactly the five registered contributors, as the
   * command does in production. Tests about something else get five that report nothing to do, so
   * the attention they count is only what the step under test found. `overrides` replaces one by name.
   */
  const inventory = (
    overrides: Partial<Record<RequiredContributor, RestoreContributor>> = {},
  ): RestoreContributor[] =>
    REQUIRED_RESTORE_CONTRIBUTORS.map(
      (name) =>
        overrides[name] ?? {
          name,
          reconcile: async () => ({ name, checked: 0, changed: 0, needsAttention: 0 }),
        },
    );

  const reconcile = (
    store: MemoryStore,
    organizationIds: readonly string[],
    mode: 'report' | 'apply',
    extra: {
      probeRun?: RunProbe;
      contributors?: readonly RestoreContributor[];
      confirmed?: ReadonlySet<string>;
      findings?: RestoreFinding[];
    } = {},
  ) =>
    reconcileAfterRestore(db(), store, {
      organizationIds,
      contextFor: createServiceContext,
      probeRun: extra.probeRun ?? (async () => 'open'),
      contributors: extra.contributors ?? inventory(),
      mode,
      ledgerOptions: { confirmed: extra.confirmed ?? new Set() },
      onFinding: (finding) => extra.findings?.push(finding),
    });

  const reportFor = (
    result: Awaited<ReturnType<typeof reconcile>>,
    organizationId: string,
  ): (typeof result.tenants)[number] => {
    const found = result.tenants.find((tenant) => tenant.organizationId === organizationId);
    if (!found) throw new Error('No report for this tenant');
    return found;
  };

  describe('a deleted file (QA-025)', () => {
    async function restored() {
      const [a, b] = [await newOrg(), await newOrg()];
      const store = new MemoryStore();
      const workA = await createWorkUnit(db(), a, { title: 'Same title' });
      const workB = await createWorkUnit(db(), b, { title: 'Same title' });
      const doomed = await file(a, store, workA.id, 'same-name.txt');
      const kept = await file(a, store, workA.id, 'kept.txt');
      const other = await file(b, store, workB.id, 'same-name.txt');
      return { a, b, store, workA, workB, doomed, kept, other };
    }

    it('is refused until the re-apply, and gone in row and bytes after, with only its tenant affected', async () => {
      const { a, b, store, workA, workB, doomed, kept, other } = await restored();
      inLedger(store, a.organizationId, doomed.id);
      store.objects.delete(objectKey(a.organizationId, doomed.id));
      const gate = createRestoreGate({ database: db(), store, now: () => Date.now() });

      // Skipping the re-apply: the file is back, and the tenant is refused. The other is served.
      await expect(gate.assertServing(a)).rejects.toMatchObject({ code: 'RESTORE_PENDING' });
      await expect(gate.assertServing(b)).resolves.toBeUndefined();

      const beforeB = await stateOf(b.organizationId);
      const result = await reconcile(store, [a.organizationId, b.organizationId], 'apply');
      expect(result.ledger).toMatchObject({ tombstonesAdded: 1, artifactsRemoved: 1, failed: 0 });

      await expect(
        readArtifact(db(), store, a, { workUnitId: workA.id, artifactId: doomed.id }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(store.objects.has(objectKey(a.organizationId, doomed.id))).toBe(false);
      expect(
        (await readArtifact(db(), store, a, { workUnitId: workA.id, artifactId: kept.id })).name,
      ).toBe('kept.txt');

      // A fresh gate has nothing remembered, as a web process started afterwards would not.
      const fresh = createRestoreGate({ database: db(), store });
      await expect(fresh.assertServing(a)).resolves.toBeUndefined();

      expect(await stateOf(b.organizationId)).toEqual(beforeB);
      expect(
        (await readArtifact(db(), store, b, { workUnitId: workB.id, artifactId: other.id })).name,
      ).toBe('same-name.txt');
    });

    it('keeps the rule about a whole file: it waits for a person, and the tenant stays refused', async () => {
      const { a, store, workA, doomed } = await restored();
      const ref = inLedger(store, a.organizationId, doomed.id);
      const gate = () => createRestoreGate({ database: db(), store });

      const waiting = await reconcile(store, [a.organizationId], 'apply');
      expect(waiting.ledger).toMatchObject({
        unconfirmed: 1,
        artifactsRemoved: 0,
        bytesRemoved: 0,
      });
      expect(waiting.needsAttention).toBeGreaterThan(0);
      expect(store.objects.has(objectKey(a.organizationId, doomed.id))).toBe(true);
      await expect(gate().assertServing(a)).rejects.toMatchObject({ code: 'RESTORE_PENDING' });

      const confirmed = await reconcile(store, [a.organizationId], 'apply', {
        confirmed: new Set([ref]),
      });
      expect(confirmed.ledger).toMatchObject({
        unconfirmed: 0,
        artifactsRemoved: 1,
        bytesRemoved: 1,
      });
      expect(store.objects.has(objectKey(a.organizationId, doomed.id))).toBe(false);
      await expect(
        readArtifact(db(), store, a, { workUnitId: workA.id, artifactId: doomed.id }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(gate().assertServing(a)).resolves.toBeUndefined();
    });

    it('changes nothing in report mode, and says what applying would do', async () => {
      const { a, store, doomed, kept } = await restored();
      inLedger(store, a.organizationId, doomed.id);
      store.objects.delete(objectKey(a.organizationId, doomed.id));
      const whole = inLedger(store, a.organizationId, kept.id);
      const before = await stateOf(a.organizationId);
      const keys = [...store.objects.keys()].sort();

      const report = await reconcile(store, [a.organizationId], 'report');
      expect(report.mode).toBe('report');
      expect(report.ledger).toMatchObject({
        entries: 2,
        tombstonesAdded: 1,
        artifactsRemoved: 1,
        bytesRemoved: 0,
        unconfirmed: 1,
      });
      expect(report.needsAttention).toBeGreaterThan(0);
      expect(await stateOf(a.organizationId)).toEqual(before);
      expect([...store.objects.keys()].sort()).toEqual(keys);

      // Confirming in report mode shows what it would do, and still does none of it.
      const previewed = await reconcile(store, [a.organizationId], 'report', {
        confirmed: new Set([whole]),
      });
      expect(previewed.ledger).toMatchObject({
        unconfirmed: 0,
        artifactsRemoved: 2,
        bytesRemoved: 1,
      });
      expect(await stateOf(a.organizationId)).toEqual(before);
      expect([...store.objects.keys()].sort()).toEqual(keys);
    });

    it('changes nothing the second time', async () => {
      const { a, store, doomed } = await restored();
      inLedger(store, a.organizationId, doomed.id);
      store.objects.delete(objectKey(a.organizationId, doomed.id));
      await reconcile(store, [a.organizationId], 'apply');
      const after = await stateOf(a.organizationId);
      const keys = [...store.objects.keys()].sort();

      const second = await reconcile(store, [a.organizationId], 'apply');
      expect(second.ledger).toMatchObject({
        tombstonesAdded: 0,
        artifactsRemoved: 0,
        bytesRemoved: 0,
      });
      expect(await stateOf(a.organizationId)).toEqual(after);
      expect([...store.objects.keys()].sort()).toEqual(keys);
    });

    it('never lets one tenant’s ledger entry reach another tenant’s file', async () => {
      const { a, b, store, workB, other } = await restored();
      // Filed under A, and naming a file of B's. Row-level security finds no such file for A.
      inLedger(store, a.organizationId, other.id);
      await reconcile(store, [a.organizationId, b.organizationId], 'apply');
      expect(
        (await readArtifact(db(), store, b, { workUnitId: workB.id, artifactId: other.id })).name,
      ).toBe('same-name.txt');
      expect(store.objects.has(objectKey(b.organizationId, other.id))).toBe(true);
    });
  });

  describe('runs', () => {
    async function heldRun(context: TenantContext, store: MemoryStore) {
      // A run is only asked for on planned work that a person has marked ready, as in the product.
      const work = await createWorkUnit(db(), context, { title: 'Run', executionPlan: 'checklist' });
      await transitionWorkUnit(db(), context, {
        id: work.id,
        expectedVersion: work.version,
        to: 'ready',
      });
      await requestExecution(db(), context, work.id);
      const runId = randomUUID();
      await createActivities({ database: db(), store }).prepareWork({
        organizationId: context.organizationId,
        workUnitId: work.id,
        runId,
      });
      expect((await getWorkUnit(db(), context, work.id)).status).toBe('running');
      return { workUnitId: work.id, runId };
    }

    it('fails work whose run is closed, leaves open work, and reports unknown without touching it', async () => {
      const [a, b] = [await newOrg(), await newOrg()];
      const store = new MemoryStore();
      const open = await heldRun(a, store);
      const closed = await heldRun(a, store);
      const unknown = await heldRun(a, store);
      const outage = await heldRun(a, store);
      const otherTenant = await heldRun(b, store);
      const asked: string[] = [];
      const probeRun: RunProbe = async ({ organizationId, workUnitId }) => {
        expect(organizationId).toBe(a.organizationId);
        asked.push(workUnitId);
        if (workUnitId === closed.workUnitId) return 'closed';
        if (workUnitId === unknown.workUnitId) return 'unknown';
        if (workUnitId === outage.workUnitId) throw new Error('Temporal did not answer');
        return 'open';
      };

      const result = await reconcile(store, [a.organizationId], 'apply', { probeRun });
      expect(reportFor(result, a.organizationId)).toMatchObject({
        runsClosed: 1,
        runsOpen: 1,
        runsUnknown: 2,
      });
      expect(result.needsAttention).toBeGreaterThanOrEqual(2);
      expect(asked).not.toContain(otherTenant.workUnitId);

      const status = async (id: string, context = a) =>
        (await getWorkUnit(db(), context, id)).status;
      expect(await status(closed.workUnitId)).toBe('failed');
      expect(await status(open.workUnitId)).toBe('running');
      expect(await status(unknown.workUnitId)).toBe('running');
      expect(await status(outage.workUnitId)).toBe('running');
      expect(await status(otherTenant.workUnitId, b)).toBe('running');

      // Temporal saying closed again changes nothing, since that work no longer holds a run.
      const after = await stateOf(a.organizationId);
      const second = await reconcile(store, [a.organizationId], 'apply', { probeRun });
      expect(reportFor(second, a.organizationId).runsClosed).toBe(0);
      expect(await stateOf(a.organizationId)).toEqual(after);
    });

    it('only says what it would do in report mode', async () => {
      const a = await newOrg();
      const store = new MemoryStore();
      await heldRun(a, store);
      const before = await stateOf(a.organizationId);
      const result = await reconcile(store, [a.organizationId], 'report', {
        probeRun: async () => 'closed',
      });
      expect(reportFor(result, a.organizationId).runsClosed).toBe(1);
      expect(result.needsAttention).toBeGreaterThan(0);
      expect(await stateOf(a.organizationId)).toEqual(before);
    });
  });

  describe('intents', () => {
    const ALL: readonly ExternalActionStatus[] = [
      'awaiting_approval',
      'ready',
      'sending',
      'reconciling',
      'sent',
      'failed',
      'unknown',
      'cancelled',
    ];

    async function oneInEachStatus(context: TenantContext) {
      const connectionId = await seedConnection(db(), context);
      const seeded = new Map<ExternalActionStatus, string>();
      for (const status of ALL) {
        // One work unit each: a work unit holds at most one open approval
        // (approvals_one_open_per_work), and both awaiting_approval and cancelled leave theirs open.
        const work = await createWorkUnit(db(), context, { title: `Sends ${status}` });
        const { id } = await seedExternalAction(db(), context, {
          workUnitId: work.id,
          connectionId,
          approverMembershipId: context.membershipId,
          status,
        });
        seeded.set(status, id);
      }
      return { connectionId, seeded };
    }

    const statusOf = async (context: TenantContext, id: string) => {
      const [row] = await withTenantTx(db(), context, (tx) =>
        tx
          .select({ status: externalActions.status })
          .from(externalActions)
          .where(eq(externalActions.id, id)),
      );
      return row?.status;
    };

    it('moves only what the trigger allows, reports the rest, and sends and retries nothing', async () => {
      const a = await newOrg();
      const store = new MemoryStore();
      const { seeded } = await oneInEachStatus(a);
      const findings: RestoreFinding[] = [];
      const attemptsBefore = (await stateOf(a.organizationId)).attempts;

      const result = await reconcile(store, [a.organizationId], 'apply', { findings });
      const report = reportFor(result, a.organizationId);

      expect(await statusOf(a, seeded.get('reconciling') as string)).toBe('unknown');
      // An open attempt is not a finished one, and this does not write its outcome.
      expect(await statusOf(a, seeded.get('sending') as string)).toBe('sending');
      for (const status of [
        'awaiting_approval',
        'ready',
        'sent',
        'failed',
        'unknown',
        'cancelled',
      ]) {
        expect(await statusOf(a, seeded.get(status as ExternalActionStatus) as string)).toBe(
          status,
        );
      }

      expect(report.actionsMovedToUnknown).toBe(1);
      // Reconciling, now unknown, sending, and the one that was already unknown.
      expect(report.actionsNeedingReview).toBe(3);
      expect(report.actionsReadyUnattempted).toBe(1);
      expect(result.needsAttention).toBeGreaterThanOrEqual(3);

      const byCode = (code: RestoreFinding['code']) =>
        findings.filter((finding) => finding.code === code).map((finding) => finding.id);
      expect(byCode('ACTION_MOVED_TO_UNKNOWN')).toEqual([seeded.get('reconciling')]);
      expect(byCode('ACTION_READY_UNATTEMPTED')).toEqual([seeded.get('ready')]);
      expect(byCode('ACTION_NEEDS_REVIEW').sort()).toEqual(
        [seeded.get('sending'), seeded.get('unknown')].sort(),
      );

      // Not one attempt was written, or had its outcome changed.
      const after = await stateOf(a.organizationId);
      expect(after.attempts).toEqual(attemptsBefore);
      // Nothing that can start a send.
      const { rows } = await su.query(
        `select count(*)::int as n from platform.domain_events
          where organization_id = $1 and event_type = 'external_action.ready'`,
        [a.organizationId],
      );
      expect(rows[0].n).toBe(0);
    });

    it('takes sending with a finished indeterminate attempt through reconciling, as the trigger requires', async () => {
      const a = await newOrg();
      const store = new MemoryStore();
      const work = await createWorkUnit(db(), a, { title: 'Sends' });
      const { id, attemptId } = await seedExternalAction(db(), a, {
        workUnitId: work.id,
        connectionId: await seedConnection(db(), a),
        approverMembershipId: a.membershipId,
        status: 'sending',
      });
      await withTenantTx(db(), a, (tx) =>
        tx
          .update(externalActionAttempts)
          .set({ outcome: 'indeterminate', outcomeCode: 'WORKER_INTERRUPTED' })
          .where(eq(externalActionAttempts.id, attemptId as string)),
      );
      const result = await reconcile(store, [a.organizationId], 'apply');
      expect(await statusOf(a, id)).toBe('unknown');
      expect(reportFor(result, a.organizationId).actionsMovedToUnknown).toBe(1);
      const [receipts] = [
        (await stateOf(a.organizationId)).receipts.filter(
          (receipt) => receipt.outcome === 'unknown',
        ),
      ];
      // Its word rests on the system, since no provider was asked anything.
      expect(receipts).toEqual([expect.objectContaining({ basis: 'system' })]);
    });

    it('reports ready with an attempt behind it, and leaves it', async () => {
      const a = await newOrg();
      const store = new MemoryStore();
      const work = await createWorkUnit(db(), a, { title: 'Sends' });
      const { id, attemptId } = await seedExternalAction(db(), a, {
        workUnitId: work.id,
        connectionId: await seedConnection(db(), a),
        approverMembershipId: a.membershipId,
        status: 'sending',
      });
      await withTenantTx(db(), a, async (tx) => {
        await tx
          .update(externalActionAttempts)
          .set({ outcome: 'not_sent', outcomeCode: 'CONNECT_FAILED' })
          .where(eq(externalActionAttempts.id, attemptId as string));
        await tx.update(externalActions).set({ status: 'ready' }).where(eq(externalActions.id, id));
      });
      const result = await reconcile(store, [a.organizationId], 'apply');
      expect(await statusOf(a, id)).toBe('ready');
      expect(reportFor(result, a.organizationId).actionsNeedingReview).toBe(1);
      expect(result.needsAttention).toBeGreaterThan(0);
    });

    it('changes nothing in report mode, and nothing the second time', async () => {
      const a = await newOrg();
      const store = new MemoryStore();
      await oneInEachStatus(a);
      const before = await stateOf(a.organizationId);

      const report = await reconcile(store, [a.organizationId], 'report');
      expect(reportFor(report, a.organizationId).actionsMovedToUnknown).toBe(1);
      expect(await stateOf(a.organizationId)).toEqual(before);

      await reconcile(store, [a.organizationId], 'apply');
      const after = await stateOf(a.organizationId);
      expect(after).not.toEqual(before);

      const second = await reconcile(store, [a.organizationId], 'apply');
      expect(reportFor(second, a.organizationId).actionsMovedToUnknown).toBe(0);
      // Still in front of a person, so still counted, and not moved or recorded a second time.
      expect(second.needsAttention).toBeGreaterThan(0);
      expect(await stateOf(a.organizationId)).toEqual(after);
    });

    it('never touches another tenant’s intent', async () => {
      const [a, b] = [await newOrg(), await newOrg()];
      const store = new MemoryStore();
      await oneInEachStatus(a);
      const { seeded } = await oneInEachStatus(b);
      const beforeB = await stateOf(b.organizationId);
      await reconcile(store, [a.organizationId], 'apply');
      expect(await stateOf(b.organizationId)).toEqual(beforeB);
      expect(await statusOf(b, seeded.get('reconciling') as string)).toBe('reconciling');
      // Nor can A's context see it to begin with.
      expect(await statusOf(a, seeded.get('reconciling') as string)).toBeUndefined();
    });
  });

  describe('bytes', () => {
    async function withFile(context: TenantContext, store: MemoryStore, name = 'file.txt') {
      const work = await createWorkUnit(db(), context, { title: 'Files' });
      return file(context, store, work.id, name);
    }

    it('lists objects with no row, across pages, and deletes none of them', async () => {
      const a = await newOrg();
      const store = new MemoryStore();
      await withFile(a, store);
      const strays = [randomUUID(), randomUUID(), randomUUID()].map((id) =>
        objectKey(a.organizationId, id),
      );
      for (const key of strays) store.objects.set(key, Buffer.from('an upload after the backup'));
      const findings: RestoreFinding[] = [];

      const result = await reconcile(store, [a.organizationId], 'apply', { findings });
      expect(reportFor(result, a.organizationId).unreferencedObjects).toBe(3);
      expect(result.needsAttention).toBeGreaterThanOrEqual(3);
      for (const key of strays) expect(store.objects.has(key)).toBe(true);
      expect(
        findings
          .filter(({ code }) => code === 'OBJECT_UNREFERENCED')
          .map((f) => f.objectKey)
          .sort(),
      ).toEqual([...strays].sort());
    });

    it('does not show a key it did not make, and still counts it', async () => {
      const a = await newOrg();
      const store = new MemoryStore();
      store.objects.set(`${a.organizationId}/artifacts/Salary review 2026.pdf`, Buffer.from('x'));
      const findings: RestoreFinding[] = [];
      const result = await reconcile(store, [a.organizationId], 'apply', { findings });
      expect(reportFor(result, a.organizationId).unreferencedObjects).toBe(1);
      expect(JSON.stringify(findings)).not.toContain('Salary');
    });

    it('reports a row whose bytes are gone, and one whose bytes differ', async () => {
      const a = await newOrg();
      const store = new MemoryStore();
      const gone = await withFile(a, store, 'gone.txt');
      const changed = await withFile(a, store, 'changed.txt');
      const fine = await withFile(a, store, 'fine.txt');
      store.objects.delete(objectKey(a.organizationId, gone.id));
      store.objects.set(objectKey(a.organizationId, changed.id), Buffer.from('not what it was'));
      const before = await stateOf(a.organizationId);
      const findings: RestoreFinding[] = [];

      const result = await reconcile(store, [a.organizationId], 'apply', { findings });
      expect(reportFor(result, a.organizationId).artifactsMissingBytes).toBe(2);
      expect(findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'BYTES_MISSING', id: gone.id }),
          expect.objectContaining({ code: 'BYTES_DIFFER', id: changed.id }),
        ]),
      );
      expect(findings.some(({ id }) => id === fine.id)).toBe(false);
      // A person looks. The rows stay exactly as they were.
      expect(await stateOf(a.organizationId)).toEqual(before);
    });

    it('never reads another tenant’s bytes, whatever a restored row says', async () => {
      const [a, b] = [await newOrg(), await newOrg()];
      const store = new MemoryStore();
      const mine = await withFile(a, store);
      const theirs = await withFile(b, store);
      const theirKey = objectKey(b.organizationId, theirs.id);
      // A corrupt backup, not a caller: no role may rewrite an artifact's identity
      // (IMMUTABLE_ARTIFACT_IDENTITY), so the row is planted the way pg_restore --disable-triggers
      // would load it, with triggers off for this one statement only.
      await su.query('begin');
      try {
        await su.query('set local session_replication_role = replica');
        await su.query('update work.artifacts set object_key = $1 where id = $2', [
          theirKey,
          mine.id,
        ]);
        await su.query('commit');
      } catch (error) {
        await su.query('rollback');
        throw error;
      }
      store.read.length = 0;
      const result = await reconcile(store, [a.organizationId], 'report');
      expect(store.read).not.toContain(theirKey);
      expect(reportFor(result, a.organizationId).artifactsMissingBytes).toBe(1);
    });

    it('says when it could not check, and does not call that fine', async () => {
      const a = await newOrg();
      const store = new MemoryStore();
      const unreadable = await withFile(a, store);
      store.failOn = (key) => key === objectKey(a.organizationId, unreadable.id);
      const result = await reconcile(store, [a.organizationId], 'apply');
      expect(reportFor(result, a.organizationId).bytesUnchecked).toBe(1);
      expect(result.needsAttention).toBeGreaterThan(0);
    });

    it('lists an archive whose row the restore lost, and leaves one the database still knows', async () => {
      const a = await newOrg();
      const store = new MemoryStore();
      const recipient = testRecipient();
      const known = await seedExportRow(db(), a, recipient);
      const lost = randomUUID();
      const knownKey = exportObjectKey(a.organizationId, known, 'manifest.json.sealed');
      const lostKey = exportObjectKey(a.organizationId, lost, 'manifest.json.sealed');
      store.objects.set(knownKey, Buffer.from('sealed'));
      store.objects.set(lostKey, Buffer.from('sealed'));
      const findings: RestoreFinding[] = [];

      const result = await reconcile(store, [a.organizationId], 'apply', { findings });
      expect(reportFor(result, a.organizationId).unreferencedObjects).toBe(1);
      expect(findings.find(({ code }) => code === 'OBJECT_UNREFERENCED')).toMatchObject({
        id: lost,
        objectKey: lostKey,
      });
      expect(store.objects.has(lostKey)).toBe(true);
      expect(store.objects.has(knownKey)).toBe(true);
    });

    it('lists bytes of an organization the backup predates, and deletes none', async () => {
      const a = await newOrg();
      const store = new MemoryStore();
      const stranger = randomUUID();
      const key = objectKey(stranger, randomUUID());
      store.objects.set(key, Buffer.from('from a tenant this database never heard of'));
      const findings: RestoreFinding[] = [];
      const result = await reconcile(store, [a.organizationId], 'apply', { findings });
      expect(result.objectsWithoutTenant).toBe(1);
      expect(result.needsAttention).toBeGreaterThan(0);
      expect(findings).toContainEqual({
        code: 'OBJECT_WITHOUT_TENANT',
        organizationId: stranger,
        objectKey: key,
      });
      expect(store.objects.has(key)).toBe(true);
    });

    it('matches its hash against what the row says, with no side channel in the name', async () => {
      const a = await newOrg();
      const store = new MemoryStore();
      const fine = await withFile(a, store);
      const body = store.objects.get(objectKey(a.organizationId, fine.id)) as Buffer;
      const { rows } = await su.query('select sha256 from work.artifacts where id = $1', [fine.id]);
      expect(rows[0].sha256).toBe(createHash('sha256').update(body).digest('hex'));
      const result = await reconcile(store, [a.organizationId], 'apply');
      expect(reportFor(result, a.organizationId).artifactsMissingBytes).toBe(0);
    });
  });

  describe('contributors', () => {
    const counting = (name: RequiredContributor, answer: Partial<ContributorReport> = {}) => {
      const calls: string[] = [];
      const contributor: RestoreContributor = {
        name,
        async reconcile(_database, context) {
          calls.push(context.organizationId);
          return { name, checked: 1, changed: 0, needsAttention: 0, ...answer };
        },
      };
      return { contributor, calls };
    };

    it('runs each once per tenant when applying, and counts what they need', async () => {
      const [a, b] = [await newOrg(), await newOrg()];
      const { contributor, calls } = counting('m5-derived-artifacts', { needsAttention: 2 });
      const result = await reconcile(
        new MemoryStore(),
        [a.organizationId, b.organizationId],
        'apply',
        { contributors: inventory({ 'm5-derived-artifacts': contributor }) },
      );
      expect(calls.sort()).toEqual([a.organizationId, b.organizationId].sort());
      expect(result.needsAttention).toBe(4);
      expect(result.contributorsNotRun).toEqual([]);
    });

    it('runs none in report mode, because the port has no way to ask one to change nothing, and says so', async () => {
      const a = await newOrg();
      const { contributor, calls } = counting('m5-derived-artifacts');
      const result = await reconcile(new MemoryStore(), [a.organizationId], 'report', {
        contributors: inventory({ 'm5-derived-artifacts': contributor }),
      });
      expect(calls).toEqual([]);
      expect(result.contributorsNotRun).toEqual([...REQUIRED_RESTORE_CONTRIBUTORS]);
    });

    it('counts one that throws, and carries on', async () => {
      const a = await newOrg();
      const { contributor, calls } = counting('m6-archive-quarantine');
      const broken: RestoreContributor = {
        name: 'm4-runs-and-budgets',
        async reconcile() {
          throw new Error('Could not rebuild');
        },
      };
      const result = await reconcile(new MemoryStore(), [a.organizationId], 'apply', {
        contributors: inventory({
          'm4-runs-and-budgets': broken,
          'm6-archive-quarantine': contributor,
        }),
      });
      expect(calls).toHaveLength(1);
      expect(result.needsAttention).toBe(1);
    });

    it('refuses to start without the whole registered inventory', async () => {
      const a = await newOrg();
      const store = new MemoryStore();
      const before = await stateOf(a.organizationId);
      for (const contributors of [
        [],
        inventory().slice(1),
        [...inventory(), counting('m4-runs-and-budgets').contributor],
      ])
        await expect(
          reconcile(store, [a.organizationId], 'apply', { contributors }),
        ).rejects.toThrow('RESTORE_CONTRIBUTOR_INVENTORY_INCOMPLETE');
      expect(await stateOf(a.organizationId)).toEqual(before);
    });
  });

  describe('the command', () => {
    it('reports, then applies, with the exit status and output the runbook relies on', async () => {
      const a = await newOrg();
      const store = new MemoryStore();
      const work = await createWorkUnit(db(), a, { title: 'W' });
      const doomed = await file(a, store, work.id, 'Canary-file-name.txt');
      inLedger(store, a.organizationId, doomed.id);
      store.objects.delete(objectKey(a.organizationId, doomed.id));
      const before = await stateOf(a.organizationId);

      const run = async (...args: string[]) => {
        const lines: string[] = [];
        const code = await restoreReconcileCommand(args, {
          database: db(),
          store,
          // The dispatcher's real listing, narrowed to this test's tenant: the suite shares one
          // database, and every other file's tenants would otherwise be reconciled here too.
          listOrganizations: async () => {
            const all = await listOrganizationIds(dispatcher.db);
            expect(all).toContain(a.organizationId);
            return all.filter((id) => id === a.organizationId);
          },
          probeRun: async () => 'open',
          // The registered inventory the worker passes, with no recovery ports bound.
          contributors: createRestoreContributors(),
          write: (line) => lines.push(line),
        });
        return { code, output: lines.join('') };
      };

      const report = await run();
      expect(report.code).toBe(1);
      expect(await stateOf(a.organizationId)).toEqual(before);

      const applied = await run('--apply');
      expect(await stateOf(a.organizationId)).not.toEqual(before);
      expect(applied.output).not.toContain('Canary');
      expect(report.output).not.toContain('Canary');
      await expect(
        readArtifact(db(), store, a, { workUnitId: work.id, artifactId: doomed.id }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      expect((await run('--nonsense')).code).toBe(2);
    });
  });
});
