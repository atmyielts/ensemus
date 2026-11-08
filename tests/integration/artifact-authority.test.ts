// 0419 source-only actual-role cases. The real M2 kernel/template writes bytes to an in-memory
// store. A synthetic claimed inventory appears only in explicit SQL-denial tests, never positives.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  createWorkUnit,
  currentReviewAction,
  decideApproval,
  getApproval,
  getWorkUnit,
  readArtifact,
  requestExecution,
  transitionWorkUnit,
  type ObjectStore,
} from '@ensemus/application';
import {
  addGeneratedArtifact,
  type ArtifactInputInventory,
} from '@ensemus/application/knowledge/artifact-provenance';
import {
  CHECKLIST_TEMPLATE,
  completionChecklist,
  createChecklistInputInventory,
} from '@ensemus/application/knowledge/checklist-template';
import {
  artifactAuthorityReceipts,
  artifactAuthorityRefs,
  artifactLineage,
  memberships,
  openAppDatabase,
  withTenantTx,
  workUnits,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { createActivities } from '@ensemus/workflows/activities';
import { canonicalJson } from '@ensemus/domain/approval';
import type { CompletionCriterion } from '@ensemus/domain/work-unit';
import { verificationHash } from '../../packages/application/src/knowledge/verification-proof';
import { pgCode } from '../../packages/application/src/errors';
import { seedAiTenant, type AiTenant } from '../helpers/ai/fixtures';
import { urls } from '../helpers/stack';
import { makePerson, nativePersonContext, proveSecondFactor } from '../helpers/product';

class ActualMemoryStore implements ObjectStore {
  readonly objects = new Map<string, Buffer>();
  putCount = 0;
  getCount = 0;
  beforePut?: () => Promise<void>;
  afterPut?: () => Promise<void>;
  async put(key: string, bytes: Buffer) {
    await this.beforePut?.();
    this.putCount++;
    this.objects.set(key, bytes);
    await this.afterPut?.();
  }
  async get(key: string) {
    this.getCount++;
    const found = this.objects.get(key);
    if (!found) throw new Error('TEST_BYTES_MISSING');
    return found;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async exists(key: string) {
    return this.objects.has(key);
  }
}

describe('actual pre-put artifact authority (0419)', () => {
  const app = openAppDatabase(urls.app(), { max: 4 });
  let a: AiTenant, b: AiTenant;
  beforeAll(async () => {
    a = await seedAiTenant(app.db, { commercialMode: 'sovereign' });
    b = await seedAiTenant(app.db, { commercialMode: 'sovereign' });
  });
  afterAll(async () => {
    await app.close();
  });

  async function fixture(withCriterion = true, withReview = false) {
    const completionCriteria: CompletionCriterion[] = withCriterion
      ? [{ kind: 'artifact_exists' }]
      : [];
    let reviewer: Awaited<ReturnType<typeof nativePersonContext>> | null = null;
    if (withReview) {
      completionCriteria.push({ kind: 'reviewer_approved' });
      const person = await makePerson('artifact-authority-reviewer');
      await withTenantTx(app.db, a.owner, (tx) =>
        tx.insert(memberships).values({
          organizationId: a.organizationId,
          userId: person.userId,
          role: 'member',
          status: 'active',
        }),
      );
      await proveSecondFactor(person);
      reviewer = await nativePersonContext(app.db, person, a.organizationId);
    }
    const work = await createWorkUnit(app.db, a.owner, {
      title: 'Actual known template work',
      executionPlan: 'checklist',
      completionCriteria,
    });
    await transitionWorkUnit(app.db, a.owner, {
      id: work.id,
      expectedVersion: work.version,
      to: 'ready',
    });
    await requestExecution(
      app.db,
      a.owner,
      work.id,
      reviewer ? { reviewerMembershipId: reviewer.membershipId } : {},
    );
    const input = { organizationId: a.organizationId, workUnitId: work.id, runId: randomUUID() };
    const store = new ActualMemoryStore(),
      activities = createActivities({ database: app.db, store });
    expect(await activities.prepareWork(input)).toMatchObject({ status: 'running' });
    return {
      work,
      completionCriteria,
      input,
      store,
      activities,
      reviewer,
      service: createServiceContext(a.organizationId),
    };
  }

  it.each([false, true])(
    'captures only actual template inputs before put, criterion=%s',
    async (withCriterion) => {
      const f = await fixture(withCriterion),
        result = await f.activities.produceChecklistArtifact(f.input);
      expect(f.store.putCount).toBe(1);
      const [receipt] = await withTenantTx(app.db, a.owner, (tx) =>
        tx
          .select()
          .from(artifactAuthorityReceipts)
          .where(eq(artifactAuthorityReceipts.artifactId, result.artifactId)),
      );
      expect(receipt).toMatchObject({
        workUnitId: f.work.id,
        runId: null,
        viewerMembershipId: null,
        protocolVersion: 'system-template-v1',
        artifactSha256: verificationHash(
          completionChecklist({ id: f.work.id, completionCriteria: f.completionCriteria }),
        ),
      });
      expect(receipt?.inputInventory).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'work_unit',
            id: f.work.id,
            sha256: verificationHash(
              canonicalJson({ id: f.work.id, completionCriteria: f.completionCriteria }),
            ),
          }),
          expect.objectContaining({
            kind: 'read_authority',
            id: f.work.id,
            inputKind: 'work_unit',
          }),
        ]),
      );
      expect(
        await withTenantTx(
          app.db,
          a.owner,
          async (tx) =>
            (
              await tx.execute<{ complete: boolean }>(
                sql`select knowledge.artifact_authority_complete(${result.artifactId}::uuid) complete`,
              )
            ).rows[0]?.complete,
        ),
      ).toBe(true);
      expect(
        await withTenantTx(app.db, b.owner, (tx) =>
          tx
            .select()
            .from(artifactAuthorityReceipts)
            .where(eq(artifactAuthorityReceipts.artifactId, result.artifactId)),
        ),
      ).toEqual([]);
      expect(await f.activities.produceChecklistArtifact(f.input)).toEqual(result);
      expect(f.store.putCount).toBe(1);
    },
  );

  it('does not let an explicit claimed executor inventory authorize another template or different bytes', async () => {
    const f = await fixture();
    const actual = createChecklistInputInventory();
    // Deliberately hostile inventory adapter: the SQL boundary must independently verify the exact
    // known template/output rather than treating this claimed known:true as durable authority.
    const claimed: ArtifactInputInventory = {
      async inspectInTx(tx, context, input) {
        const proof = await actual.inspectInTx(tx, context, {
          ...input,
          execution: { kind: 'system', id: f.input.runId, template: CHECKLIST_TEMPLATE },
          artifactSha256: verificationHash(
            completionChecklist({ id: f.work.id, completionCriteria: f.completionCriteria }),
          ),
        });
        return proof.known ? { ...proof, execution: input.execution } : proof;
      },
    };
    for (const variation of [
      {
        template: 'unreviewed/template/v1',
        body: completionChecklist({ id: f.work.id, completionCriteria: f.completionCriteria }),
      },
      {
        template: CHECKLIST_TEMPLATE,
        body: 'Synthetic unapproved body under a known template label.',
      },
    ]) {
      await expect(
        addGeneratedArtifact(
          app.db,
          f.store,
          f.service,
          {
            workUnitId: f.work.id,
            name: 'candidate.md',
            mimeType: 'text/markdown',
            body: Buffer.from(variation.body),
            execution: { kind: 'system', id: f.input.runId, template: variation.template },
            requestKey: randomUUID(),
          },
          { inventory: claimed },
        ),
      ).rejects.toSatisfy((error: unknown) => pgCode(error) === 'EN119');
    }
    expect(f.store.putCount).toBe(0);
    expect(
      await withTenantTx(app.db, a.owner, (tx) =>
        tx
          .select()
          .from(artifactAuthorityReceipts)
          .where(eq(artifactAuthorityReceipts.workUnitId, f.work.id)),
      ),
    ).toEqual([]);
  });

  it('refuses app-created authority receipts and any deletion that could manufacture missing proof', async () => {
    const f = await fixture(),
      result = await f.activities.produceChecklistArtifact(f.input);
    const [receipt] = await withTenantTx(app.db, a.owner, (tx) =>
      tx
        .select()
        .from(artifactAuthorityReceipts)
        .where(eq(artifactAuthorityReceipts.artifactId, result.artifactId)),
    );
    if (!receipt) throw new Error('TEST_AUTHORITY_RECEIPT_MISSING');
    await expect(
      withTenantTx(app.db, a.owner, (tx) =>
        tx.insert(artifactAuthorityReceipts).values({ ...receipt, artifactId: randomUUID() }),
      ),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
    await expect(
      withTenantTx(app.db, a.owner, (tx) =>
        tx
          .delete(artifactAuthorityRefs)
          .where(eq(artifactAuthorityRefs.artifactId, result.artifactId)),
      ),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
  });

  it('commits exact captured historical bindings before invoking the actual object writer', async () => {
    const f = await fixture();
    let checked = false;
    f.store.beforePut = async () => {
      const [receipt] = await withTenantTx(app.db, a.owner, (tx) => tx.select()
        .from(artifactAuthorityReceipts).where(eq(artifactAuthorityReceipts.workUnitId, f.work.id)));
      if (!receipt) throw new Error('TEST_PREPUT_RECEIPT_MISSING');
      const result = await withTenantTx(app.db, a.owner, (tx) => tx.execute<{ valid: boolean }>(
        sql`select knowledge.artifact_authority_bindings_complete(${receipt.artifactId}::uuid) valid`));
      expect(result.rows[0]?.valid).toBe(true);
      checked = true;
    };
    await f.activities.produceChecklistArtifact(f.input);
    expect(checked).toBe(true);
    expect(f.store.putCount).toBe(1);
  });

  it('refuses a guessed structured hash before put instead of borrowing the actual template receipt', async () => {
    const f = await fixture(), actual = createChecklistInputInventory();
    const corrupted: ArtifactInputInventory = { async inspectInTx(tx, context, input) {
      const proof = await actual.inspectInTx(tx, context, input);
      return proof.known ? { ...proof, recordInputs: proof.recordInputs.map((record) => ({ ...record, sha256: 'a'.repeat(64) })) } : proof;
    } };
    await expect(addGeneratedArtifact(app.db, f.store, f.service, { workUnitId: f.work.id, name: 'candidate.md', mimeType: 'text/markdown',
      body: Buffer.from(completionChecklist({ id: f.work.id, completionCriteria: f.completionCriteria })),
      execution: { kind: 'system', id: f.input.runId, template: CHECKLIST_TEMPLATE }, requestKey: randomUUID() },
    { inventory: corrupted })).rejects.toSatisfy((error: unknown) => pgCode(error) === 'EN119');
    expect(f.store.putCount).toBe(0);
    expect(await withTenantTx(app.db, a.owner, (tx) => tx.select().from(artifactAuthorityReceipts)
      .where(eq(artifactAuthorityReceipts.workUnitId, f.work.id)))).toEqual([]);
  });

  it('retains an unknown put and refuses a second writer after a lost acknowledgement', async () => {
    const f = await fixture();
    f.store.afterPut = async () => { throw new Error('TEST_PUT_ACK_UNKNOWN'); };
    await expect(f.activities.produceChecklistArtifact(f.input)).rejects.toThrow('TEST_PUT_ACK_UNKNOWN');
    const [header] = await withTenantTx(app.db, a.owner, (tx) => tx.select().from(artifactLineage)
      .where(eq(artifactLineage.workUnitId, f.work.id)));
    expect(header).toMatchObject({ state: 'pending', writeState: 'active', physicalPurgedAt: null });
    expect(f.store.objects.size).toBe(1);
    await expect(f.activities.produceChecklistArtifact(f.input)).rejects.toThrow();
    expect(f.store.putCount).toBe(1);
    expect(await withTenantTx(app.db, a.owner, (tx) => tx.select().from(artifactLineage)
      .where(eq(artifactLineage.workUnitId, f.work.id)))).toEqual([header]);
  });

  it('blocks publication after a fulfilled put when current protection rises, preserving bytes for hold-aware disposition', async () => {
    const f = await fixture();
    f.store.afterPut = async () => {
      await withTenantTx(app.db, a.owner, (tx) => tx.update(workUnits).set({ classification: 'confidential' })
        .where(eq(workUnits.id, f.work.id)));
    };
    await expect(f.activities.produceChecklistArtifact(f.input)).rejects.toThrow();
    const [header] = await withTenantTx(app.db, a.owner, (tx) => tx.select().from(artifactLineage)
      .where(eq(artifactLineage.workUnitId, f.work.id)));
    expect(header).toMatchObject({ state: 'blocked', writeState: 'settled', physicalPurgedAt: null });
    expect(f.store.putCount).toBe(1);
    expect(f.store.objects.size).toBe(1);
    const [receipt] = await withTenantTx(app.db, a.owner, (tx) => tx.select().from(artifactAuthorityReceipts)
      .where(eq(artifactAuthorityReceipts.workUnitId, f.work.id)));
    expect(receipt?.classification).toBe('internal');
  });

  it('keeps actual M2 human/service review hashes equal while generated bytes require a named viewer', async () => {
    const f = await fixture(true, true);
    if (!f.reviewer) throw new Error('TEST_NATIVE_REVIEWER_MISSING');
    const file = await f.activities.produceChecklistArtifact(f.input);
    const work = await getWorkUnit(app.db, a.owner, f.work.id);
    const requesterAction = await withTenantTx(app.db, a.owner, (tx) =>
      currentReviewAction(tx, work),
    );
    const reviewerAction = await withTenantTx(app.db, f.reviewer, (tx) =>
      currentReviewAction(tx, work),
    );
    const controlAction = await withTenantTx(app.db, f.service, (tx) =>
      currentReviewAction(tx, work),
    );
    expect(controlAction).toEqual(requesterAction);
    expect(reviewerAction).toEqual(requesterAction);
    expect(controlAction.payload).toMatchObject({ artifact_ids: [file.artifactId] });
    await expect(
      readArtifact(app.db, f.store, f.service, {
        workUnitId: f.work.id,
        artifactId: file.artifactId,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(f.store.getCount).toBe(0);
    const served = await readArtifact(app.db, f.store, a.owner, {
      workUnitId: f.work.id,
      artifactId: file.artifactId,
    });
    expect(served.body.toString('utf8')).toBe(
      completionChecklist({ id: f.work.id, completionCriteria: f.completionCriteria }),
    );
    const requested = await f.activities.requestReview(f.input);
    const { approval } = await getApproval(app.db, f.reviewer, requested.approvalId);
    await decideApproval(app.db, f.reviewer, {
      approvalId: approval.id,
      decision: 'approve',
      shownHash: approval.actionHash,
    });
    expect(await f.activities.verifyAndComplete(f.input)).toBe('verifying');
    const released = await getWorkUnit(app.db, a.owner, f.work.id);
    expect(released.runId).toBeNull();
    expect(
      await withTenantTx(app.db, f.service, (tx) => currentReviewAction(tx, released)),
    ).toEqual(await withTenantTx(app.db, a.owner, (tx) => currentReviewAction(tx, released)));
    expect((await getApproval(app.db, f.reviewer, requested.approvalId)).approval.status).toBe(
      'approved',
    );
  });

  it('denies arbitrary review projection targets and restores private selectors on success/error', async () => {
    const f = await fixture(),
      file = await f.activities.produceChecklistArtifact(f.input);
    const work = await getWorkUnit(app.db, a.owner, f.work.id);
    const call = (
      tx: Parameters<typeof currentReviewAction>[0],
      version = work.version,
      run = f.input.runId,
      requester = a.owner.membershipId,
    ) =>
      tx.execute<{ id: string }>(
        sql`select id from work.held_review_artifact_ids(${work.id}::uuid,${version}::bigint,${run},${requester}::uuid)`,
      );
    await expect(withTenantTx(app.db, a.owner, (tx) => call(tx))).rejects.toSatisfy(
      (error: unknown) => pgCode(error) === '42501',
    );
    await expect(
      withTenantTx(app.db, createServiceContext(b.organizationId), (tx) => call(tx)),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
    await expect(
      withTenantTx(app.db, f.service, (tx) => call(tx, work.version + 1)),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
    await expect(
      withTenantTx(app.db, f.service, (tx) => call(tx, work.version, randomUUID())),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
    await expect(
      withTenantTx(app.db, f.service, (tx) =>
        call(tx, work.version, f.input.runId, a.member.membershipId),
      ),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
    await withTenantTx(app.db, f.service, async (tx) => {
      const prior = { org: b.organizationId, work: randomUUID() };
      await tx.execute(
        sql`select set_config('work.review_control_org',${prior.org},true),set_config('work.review_control_work',${prior.work},true)`,
      );
      expect((await call(tx)).rows).toEqual([{ id: file.artifactId }]);
      const selectors = () =>
        tx.execute<{ org: string; work: string }>(
          sql`select current_setting('work.review_control_org',true) org,current_setting('work.review_control_work',true) work`,
        );
      expect((await selectors()).rows).toEqual([prior]);
      await expect(
        tx.transaction((savepoint) => call(savepoint, work.version + 1)),
      ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
      expect((await selectors()).rows).toEqual([prior]);
    });
    const agent = new pg.Client({ connectionString: urls.agent() });
    await agent.connect();
    try {
      await agent.query('set role ensemus_app');
      await agent.query(
        "select set_config('app.organization_id',$1,false),set_config('app.actor_type','service',false)",
        [a.organizationId],
      );
      await expect(
        agent.query('select id from work.held_review_artifact_ids($1,$2,$3,$4)', [
          work.id,
          work.version,
          f.input.runId,
          a.owner.membershipId,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await agent.end();
    }
  });
});
