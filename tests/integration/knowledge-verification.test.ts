// AGENT-07: real application/auth/service roles, current hashes and ACLs. The in-memory object store
// is an explicit byte boundary; its gates perform real concurrent SQL to detect a transaction over I/O.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  addArtifact,
  AppError,
  createWorkUnit,
  deleteArtifact,
  updateWorkUnit,
  type ObjectStore,
} from '@ensemus/application';
import {
  checkArtifactGrounding,
  decideArtifact,
  getArtifactVerification,
  recordArtifactCitations,
} from '@ensemus/application/knowledge/verification';
import {
  createOrganization,
  knowledgeArtifactCitations,
  knowledgeArtifactVerifications,
  knowledgeDocuments,
  knowledgeSourceGrants,
  knowledgeSources,
  memberships,
  openAppDatabase,
  resolveTenantContext,
  tombstones,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { createDelegatedContext, createServiceContext } from '@ensemus/database/service';
import { pgCode } from '../../packages/application/src/errors';
import {
  artifactCoverage,
  citationProofHash,
} from '../../packages/application/src/knowledge/verification-proof';
import { seedMember, seedSearchableSource, sha256 } from '../helpers/knowledge';
import { urls } from '../helpers/stack';

function memoryObjects() {
  const bodies = new Map<string, Buffer>();
  const control: { beforeGet: (() => Promise<void>) | null; reads: number } = {
    beforeGet: null,
    reads: 0,
  };
  const store: ObjectStore = {
    put: async (key, body) => {
      bodies.set(key, Buffer.from(body));
    },
    get: async (key) => {
      control.reads += 1;
      await control.beforeGet?.();
      const value = bodies.get(key);
      if (!value) throw new Error('TEST_OBJECT_UNAVAILABLE');
      return Buffer.from(value);
    },
    delete: async (key) => {
      bodies.delete(key);
    },
    exists: async (key) => bodies.has(key),
  };
  return { store, bodies, control };
}
async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('SQL_LOCK_HELD_DURING_OBJECT_READ')), 3000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe('artifact grounding and fresh human acceptance on real roles (0206)', () => {
  let database: ReturnType<typeof openAppDatabase>, auth: pg.Client, su: pg.Client;
  let owner: TenantContext, reviewer: TenantContext, member: TenantContext, other: TenantContext;
  const text = 'A generated claim attributed to a generated source.';
  const objective = 'Review this generated claim against its source.';
  const service = () => createServiceContext(owner.organizationId);
  beforeAll(async () => {
    database = openAppDatabase(urls.app(), { max: 5 });
    auth = new pg.Client({ connectionString: urls.auth() });
    su = new pg.Client({ connectionString: urls.superuser() });
    await auth.connect();
    await su.connect();
    const company = async () => {
      const userId = randomUUID();
      await auth.query('insert into identity.users(id,name,email) values($1,$2,$3)', [
        userId,
        'Generated verifier',
        `${userId}@example.invalid`,
      ]);
      const organization = await createOrganization(database.db, {
        userId,
        name: 'Generated verification tenant',
        commercialMode: 'sovereign',
      });
      return resolveTenantContext(database.db, userId, organization.organizationId);
    };
    owner = await company();
    other = await company();
    const admin = await seedMember(database.db, owner, auth, 'admin');
    reviewer = await resolveTenantContext(database.db, admin.userId, owner.organizationId);
    const reader = await seedMember(database.db, owner, auth);
    member = await resolveTenantContext(database.db, reader.userId, owner.organizationId);
  });
  afterAll(async () => {
    await Promise.all([auth?.end(), su?.end(), database?.close()]);
  });

  async function draft(
    options: { context?: TenantContext; text?: string; cite?: boolean; private?: boolean } = {},
  ) {
    const context = options.context ?? owner,
      body = options.text ?? text;
    const objects = memoryObjects();
    const work = await createWorkUnit(database.db, context, {
      title: 'Generated verification work',
      objective,
    });
    const source = await seedSearchableSource(database.db, context, {
      passages: [body, 'A second generated passage.'],
      grants: options.private
        ? [{ kind: 'membership', membershipId: context.membershipId }]
        : [{ kind: 'organization' }],
    });
    const artifact = await addArtifact(database.db, objects.store, context, {
      workUnitId: work.id,
      name: 'brief.txt',
      mimeType: 'text/plain',
      body: Buffer.from(body),
    });
    const input = { artifactId: artifact.id, workUnitId: work.id };
    const citationInput = {
      ...input,
      citations: [{ chunkId: source.chunkIds[0]!, artifactStart: 0, artifactEnd: body.length }],
    };
    if (options.cite !== false) await recordArtifactCitations(database.db, context, citationInput);
    const review = await getArtifactVerification(database.db, context, input);
    return {
      ...objects,
      work,
      source,
      input,
      citationInput,
      context,
      key: `${context.organizationId}/artifacts/${artifact.id}`,
      accept: {
        ...input,
        artifactSha256: sha256(body),
        objectiveSha256: sha256(objective),
        citationsSha256: review.citationsSha256,
        verdict: 'accepted' as const,
      },
      ground: () =>
        checkArtifactGrounding(
          database.db,
          objects.store,
          createServiceContext(context.organizationId),
          input,
        ),
    };
  }
  type Draft = Awaited<ReturnType<typeof draft>>;
  async function proofRow(
    value: Draft,
    overrides: Partial<typeof knowledgeArtifactVerifications.$inferInsert> = {},
  ) {
    return {
      organizationId: value.context.organizationId,
      id: randomUUID(),
      artifactId: value.input.artifactId,
      workUnitId: value.input.workUnitId,
      artifactSha256: value.accept.artifactSha256,
      objectiveSha256: value.accept.objectiveSha256,
      citationsSha256: value.accept.citationsSha256,
      kind: 'human',
      verdict: 'accepted',
      reasonCode: null,
      decidedByMembershipId: value.context.membershipId,
      ...overrides,
    };
  }
  async function refused(operation: Promise<unknown>, code: string) {
    let failure: unknown;
    try {
      await operation;
    } catch (error) {
      failure = error;
    }
    expect(pgCode(failure)).toBe(code);
  }

  it('checks actual bytes and citations, then accepts idempotently as a fresh authorized person', async () => {
    const value = await draft();
    expect(await value.ground()).toEqual({ verdict: 'passed', reasonCode: null, citations: 1 });
    await value.ground();
    const decisions = await Promise.all([
      decideArtifact(database.db, reviewer, value.accept, { store: value.store }),
      decideArtifact(database.db, reviewer, value.accept, { store: value.store }),
    ]);
    expect(decisions[0]).toEqual(decisions[1]);
    expect(await getArtifactVerification(database.db, reviewer, value.input)).toMatchObject({
      artifactSha256: value.accept.artifactSha256,
      objectiveSha256: value.accept.objectiveSha256,
      grounding: { verdict: 'passed' },
      human: { verdict: 'accepted', by: reviewer.membershipId },
      citations: [{ available: true, excerpt: text }],
    });
    const stored = await withTenantTx(database.db, service(), (tx) =>
      tx
        .select()
        .from(knowledgeArtifactVerifications)
        .where(eq(knowledgeArtifactVerifications.artifactId, value.input.artifactId)),
    );
    expect(stored.filter((row) => row.kind === 'grounding')).toHaveLength(1);
    expect(stored.filter((row) => row.kind === 'human')).toHaveLength(1);
  });

  it('fails closed without expected objective, real store, passed proof, or current file hash', async () => {
    const value = await draft();
    await expect(decideArtifact(database.db, owner, value.accept)).rejects.toEqual(
      new AppError('KNOWLEDGE_ARTIFACT_NOT_GROUNDED'),
    );
    const { objectiveSha256: _missing, ...withoutObjective } = value.accept;
    await expect(
      decideArtifact(database.db, owner, withoutObjective, { store: value.store }),
    ).rejects.toEqual(new AppError('KNOWLEDGE_ARTIFACT_NOT_GROUNDED'));
    const { citationsSha256: _missingCitations, ...withoutCitations } = value.accept;
    await expect(
      decideArtifact(database.db, owner, withoutCitations, { store: value.store }),
    ).rejects.toEqual(new AppError('KNOWLEDGE_ARTIFACT_NOT_GROUNDED'));
    await expect(
      decideArtifact(
        database.db,
        owner,
        { ...value.accept, citationsSha256: '0'.repeat(64) },
        { store: value.store },
      ),
    ).rejects.toEqual(new AppError('VERSION_CONFLICT'));
    await expect(
      decideArtifact(database.db, owner, value.accept, { store: value.store }),
    ).rejects.toEqual(new AppError('KNOWLEDGE_ARTIFACT_NOT_GROUNDED'));
    await value.ground();
    await expect(
      decideArtifact(
        database.db,
        owner,
        { ...value.accept, artifactSha256: '0'.repeat(64) },
        { store: value.store },
      ),
    ).rejects.toEqual(new AppError('VERSION_CONFLICT'));
  });

  it('refuses stale objectives even when the artifact did not change', async () => {
    const value = await draft();
    await value.ground();
    await updateWorkUnit(database.db, owner, value.work.id, value.work.version, {
      objective: 'A different generated objective.',
    });
    await expect(
      decideArtifact(database.db, owner, value.accept, { store: value.store }),
    ).rejects.toEqual(new AppError('VERSION_CONFLICT'));
    await expect(
      decideArtifact(
        database.db,
        owner,
        { ...value.accept, objectiveSha256: sha256('A different generated objective.') },
        { store: value.store },
      ),
    ).rejects.toEqual(new AppError('KNOWLEDGE_ARTIFACT_NOT_GROUNDED'));
  });

  it.each(['grounding', 'acceptance'] as const)(
    'holds no SQL transaction over the %s object read and refuses a changed objective',
    async (phase) => {
      const value = await draft();
      if (phase === 'acceptance') await value.ground();
      let committed = false;
      value.control.beforeGet = async () => {
        await bounded(
          updateWorkUnit(database.db, owner, value.work.id, value.work.version, {
            objective: 'Changed while bytes were read.',
          }),
        );
        committed = true;
      };
      const operation =
        phase === 'grounding'
          ? value.ground()
          : decideArtifact(database.db, owner, value.accept, { store: value.store });
      await expect(operation).rejects.toEqual(new AppError('VERSION_CONFLICT'));
      expect(committed).toBe(true);
    },
  );

  it('does not accept altered storage bytes, and a newer failed check defeats an older passed check', async () => {
    const value = await draft();
    await value.ground();
    value.bodies.set(value.key, Buffer.from('Altered generated bytes.'));
    await expect(
      decideArtifact(database.db, owner, value.accept, { store: value.store }),
    ).rejects.toEqual(new AppError('KNOWLEDGE_ARTIFACT_NOT_GROUNDED'));
    expect(await value.ground()).toMatchObject({
      verdict: 'failed',
      reasonCode: 'CITATION_INVALID',
    });
    value.bodies.set(value.key, Buffer.from(text));
    await expect(
      decideArtifact(database.db, owner, value.accept, { store: value.store }),
    ).rejects.toEqual(new AppError('KNOWLEDGE_ARTIFACT_NOT_GROUNDED'));
    await refused(
      withTenantTx(database.db, owner, async (tx) =>
        tx.insert(knowledgeArtifactVerifications).values(await proofRow(value)),
      ),
      'EN114',
    );
    expect(await value.ground()).toMatchObject({ verdict: 'passed' });
    await decideArtifact(database.db, owner, value.accept, { store: value.store });
    const stored = await withTenantTx(database.db, service(), (tx) =>
      tx
        .select()
        .from(knowledgeArtifactVerifications)
        .where(
          and(
            eq(knowledgeArtifactVerifications.artifactId, value.input.artifactId),
            eq(knowledgeArtifactVerifications.kind, 'grounding'),
          ),
        ),
    );
    expect(stored).toHaveLength(3);
  });

  it('does not turn a store outage into a passed or semantic failed grounding record', async () => {
    const value = await draft();
    value.control.beforeGet = async () => {
      throw new Error('TEST_OBJECT_UNAVAILABLE');
    };
    await expect(value.ground()).rejects.toThrow('TEST_OBJECT_UNAVAILABLE');
    const rows = await withTenantTx(database.db, service(), (tx) =>
      tx
        .select()
        .from(knowledgeArtifactVerifications)
        .where(eq(knowledgeArtifactVerifications.artifactId, value.input.artifactId)),
    );
    expect(rows).toEqual([]);
  });

  it('orders proofs by publication under the artifact lock, including an older-started failed transaction', async () => {
    const value = await draft();
    const writer = new pg.Client({ connectionString: urls.app() });
    await writer.connect();
    try {
      await writer.query('begin');
      await writer.query(
        "select set_config('app.organization_id',$1,true),set_config('app.actor_type','service',true),set_config('app.membership_id','',true)",
        [owner.organizationId],
      );
      const { rows: began } = await writer.query<{ began: Date }>('select now() as began');
      await value.ground();
      const view = await getArtifactVerification(database.db, owner, value.input);
      const { rows: published } = await writer.query<{ proofOrder: number; createdAt: Date }>(
        `insert into knowledge.artifact_verifications
          (organization_id,artifact_id,work_unit_id,artifact_sha256,objective_sha256,citations_sha256,kind,verdict,reason_code)
         values($1,$2,$3,$4,$5,$6,'grounding','failed','CITATION_INVALID')
         returning proof_order::int as "proofOrder",created_at as "createdAt"`,
        [
          owner.organizationId,
          value.input.artifactId,
          value.work.id,
          view.artifactSha256,
          view.objectiveSha256,
          view.citationsSha256,
        ],
      );
      await writer.query('commit');
      expect(published[0]!.proofOrder).toBe(2);
      expect(published[0]!.createdAt.getTime()).toBeGreaterThan(began[0]!.began.getTime());
      expect(
        (await getArtifactVerification(database.db, owner, value.input)).grounding?.verdict,
      ).toBe('failed');
      await expect(
        decideArtifact(database.db, owner, value.accept, { store: value.store }),
      ).rejects.toEqual(new AppError('KNOWLEDGE_ARTIFACT_NOT_GROUNDED'));
      const forged = await proofRow(value, {
        kind: 'grounding',
        verdict: 'failed',
        reasonCode: 'CITATION_INVALID',
        decidedByMembershipId: null,
        proofOrder: 999,
      });
      await refused(
        withTenantTx(database.db, service(), (tx) =>
          tx.insert(knowledgeArtifactVerifications).values(forged),
        ),
        'EN113',
      );
    } finally {
      await writer.query('rollback');
      await writer.end();
    }
  });

  it('chains human decisions across people and does not return an old acceptance after a rejection', async () => {
    const value = await draft();
    await value.ground();
    const first = await decideArtifact(database.db, owner, value.accept, { store: value.store });
    const rejected = await decideArtifact(database.db, reviewer, {
      ...value.accept,
      verdict: 'rejected',
      reason: 'Generated rejection.',
    });
    const accepted = await decideArtifact(database.db, owner, value.accept, { store: value.store });
    expect(accepted.verificationId).not.toBe(first.verificationId);
    expect(accepted.verificationId).not.toBe(rejected.verificationId);
    expect(await decideArtifact(database.db, owner, value.accept, { store: value.store })).toEqual(
      accepted,
    );
    expect((await getArtifactVerification(database.db, owner, value.input)).human).toMatchObject({
      verdict: 'accepted',
      by: owner.membershipId,
    });
    const rows = await withTenantTx(database.db, service(), (tx) =>
      tx
        .select()
        .from(knowledgeArtifactVerifications)
        .where(
          and(
            eq(knowledgeArtifactVerifications.artifactId, value.input.artifactId),
            eq(knowledgeArtifactVerifications.kind, 'human'),
          ),
        ),
    );
    expect(rows).toHaveLength(3);
  });

  it('rejects a source-class raise above the artifact even when the work permits the stronger class', async () => {
    const value = await draft({ private: true });
    await value.ground();
    await su.query(
      "update work.work_units set classification='restricted' where organization_id=$1 and id=$2",
      [owner.organizationId, value.work.id],
    );
    await withTenantTx(database.db, owner, (tx) =>
      tx
        .update(knowledgeSources)
        .set({ classification: 'confidential' })
        .where(eq(knowledgeSources.id, value.source.sourceId)),
    );
    expect(await value.ground()).toMatchObject({
      verdict: 'failed',
      reasonCode: 'SOURCE_CLOSED',
    });
    const forged = await proofRow(value, {
      kind: 'grounding',
      verdict: 'passed',
      decidedByMembershipId: null,
    });
    await refused(
      withTenantTx(database.db, service(), (tx) =>
        tx.insert(knowledgeArtifactVerifications).values(forged),
      ),
      'EN114',
    );
    await expect(
      decideArtifact(database.db, owner, value.accept, { store: value.store }),
    ).rejects.toEqual(new AppError('NOT_FOUND'));
  });

  it('does not grant a work manager access to private citation text or acceptance', async () => {
    const value = await draft({ private: true });
    await value.ground();
    await expect(getArtifactVerification(database.db, reviewer, value.input)).rejects.toEqual(
      new AppError('NOT_FOUND'),
    );
    await expect(
      decideArtifact(database.db, reviewer, value.accept, { store: value.store }),
    ).rejects.toEqual(new AppError('NOT_FOUND'));
    await decideArtifact(database.db, owner, value.accept, { store: value.store });
  });

  it('rejects missing, fabricated, foreign and out-of-bounds citations and inadequate coverage', async () => {
    const empty = await draft({ cite: false });
    expect(await empty.ground()).toMatchObject({ verdict: 'failed', reasonCode: 'NOT_GROUNDED' });
    const value = await draft({ cite: false });
    const foreign = await draft({ context: other });
    for (const chunkId of [randomUUID(), foreign.source.chunkIds[0]!])
      await expect(
        recordArtifactCitations(database.db, owner, {
          ...value.input,
          citations: [{ chunkId, artifactStart: 0, artifactEnd: text.length }],
        }),
      ).rejects.toEqual(new AppError('KNOWLEDGE_ARTIFACT_NOT_GROUNDED'));
    await expect(
      recordArtifactCitations(database.db, owner, {
        ...value.citationInput,
        citations: [{ ...value.citationInput.citations[0]!, artifactEnd: 1_000_000 }],
      }),
    ).rejects.toEqual(new AppError('KNOWLEDGE_ARTIFACT_NOT_GROUNDED'));
    await recordArtifactCitations(database.db, owner, {
      ...value.citationInput,
      citations: [{ ...value.citationInput.citations[0]!, artifactEnd: 2 }],
    });
    expect(await value.ground()).toMatchObject({ verdict: 'failed', reasonCode: 'NOT_GROUNDED' });
  });

  it('records only one viewer, preserves exact retries and freezes citation changes after proof', async () => {
    const value = await draft();
    await recordArtifactCitations(database.db, owner, value.citationInput);
    await value.ground();
    await recordArtifactCitations(database.db, owner, value.citationInput);
    await expect(
      recordArtifactCitations(database.db, reviewer, value.citationInput),
    ).rejects.toEqual(new AppError('INVALID_STATE'));
    await refused(
      withTenantTx(database.db, owner, (tx) =>
        tx
          .delete(knowledgeArtifactCitations)
          .where(eq(knowledgeArtifactCitations.artifactId, value.input.artifactId)),
      ),
      'EN114',
    );
    await refused(
      withTenantTx(database.db, owner, (tx) =>
        tx.insert(knowledgeArtifactCitations).values({
          organizationId: owner.organizationId,
          artifactId: value.input.artifactId,
          ordinal: 2,
          chunkId: value.source.chunkIds[1]!,
          documentId: value.source.documentId,
          sourceId: value.source.sourceId,
          contentSha256: sha256('A second generated passage.'),
          artifactStart: 0,
          artifactEnd: text.length,
          recordedByMembershipId: owner.membershipId,
        }),
      ),
      'EN114',
    );
  });

  it('refuses a recording viewer impersonation and forged citation hashes in SQL', async () => {
    const value = await draft({ cite: false });
    const row = {
      organizationId: owner.organizationId,
      artifactId: value.input.artifactId,
      ordinal: 1,
      chunkId: value.source.chunkIds[0]!,
      documentId: value.source.documentId,
      sourceId: value.source.sourceId,
      contentSha256: sha256(text),
      artifactStart: 0,
      artifactEnd: text.length,
      recordedByMembershipId: owner.membershipId,
    };
    await refused(
      withTenantTx(database.db, owner, (tx) =>
        tx
          .insert(knowledgeArtifactCitations)
          .values({ ...row, recordedByMembershipId: reviewer.membershipId }),
      ),
      'EN113',
    );
    await refused(
      withTenantTx(database.db, owner, (tx) =>
        tx.insert(knowledgeArtifactCitations).values({ ...row, contentSha256: '0'.repeat(64) }),
      ),
      'EN114',
    );
  });

  it('rechecks a source closing during the object read and hides its words afterward', async () => {
    const value = await draft();
    value.control.beforeGet = async () => {
      await bounded(
        withTenantTx(database.db, service(), (tx) =>
          tx
            .update(knowledgeSources)
            .set({ state: 'revoked' })
            .where(eq(knowledgeSources.id, value.source.sourceId)),
        ),
      );
    };
    expect(await value.ground()).toMatchObject({ verdict: 'failed', reasonCode: 'SOURCE_CLOSED' });
    await expect(getArtifactVerification(database.db, owner, value.input)).rejects.toEqual(
      new AppError('NOT_FOUND'),
    );
    await expect(
      decideArtifact(database.db, owner, value.accept, { store: value.store }),
    ).rejects.toEqual(new AppError('NOT_FOUND'));
  });

  it('rechecks source grants and superseded documents after a passed check', async () => {
    const value = await draft();
    await value.ground();
    await withTenantTx(database.db, owner, (tx) =>
      tx
        .delete(knowledgeSourceGrants)
        .where(eq(knowledgeSourceGrants.sourceId, value.source.sourceId)),
    );
    await expect(
      decideArtifact(database.db, owner, value.accept, { store: value.store }),
    ).rejects.toEqual(new AppError('NOT_FOUND'));
    const stale = await draft();
    await stale.ground();
    await withTenantTx(database.db, service(), (tx) =>
      tx
        .update(knowledgeDocuments)
        .set({ supersededAt: new Date() })
        .where(eq(knowledgeDocuments.id, stale.source.documentId)),
    );
    expect(await stale.ground()).toMatchObject({
      verdict: 'failed',
      reasonCode: 'CITATION_INVALID',
    });
  });

  it('never lets another tenant, ordinary member, delegated context or service accept as a person', async () => {
    const value = await draft();
    await value.ground();
    const delegated = await createDelegatedContext(
      database.db,
      owner.organizationId,
      owner.membershipId,
    );
    for (const context of [delegated, service()]) {
      await expect(
        decideArtifact(database.db, context, value.accept, { store: value.store }),
      ).rejects.toEqual(new AppError('FORBIDDEN'));
      await refused(
        withTenantTx(database.db, context, async (tx) =>
          tx.insert(knowledgeArtifactVerifications).values(await proofRow(value)),
        ),
        'EN113',
      );
    }
    await expect(
      decideArtifact(database.db, member, value.accept, { store: value.store }),
    ).rejects.toEqual(new AppError('FORBIDDEN'));
    await expect(
      decideArtifact(database.db, other, value.accept, { store: value.store }),
    ).rejects.toEqual(new AppError('NOT_FOUND'));
    await expect(getArtifactVerification(database.db, other, value.input)).rejects.toEqual(
      new AppError('NOT_FOUND'),
    );
    await refused(
      withTenantTx(database.db, owner, async (tx) => {
        await tx.execute(sql`select set_config('app.actor_type','agent',true)`);
        return tx.insert(knowledgeArtifactVerifications).values(await proofRow(value));
      }),
      'EN113',
    );
    await refused(
      withTenantTx(database.db, member, async (tx) =>
        tx
          .insert(knowledgeArtifactVerifications)
          .values({ ...(await proofRow(value)), decidedByMembershipId: member.membershipId }),
      ),
      'EN113',
    );
  });

  it('rechecks the current reviewer role after I/O rather than trusting a stale context', async () => {
    const value = await draft();
    await value.ground();
    const admin = await seedMember(database.db, owner, auth, 'admin');
    const stale = await resolveTenantContext(database.db, admin.userId, owner.organizationId);
    value.control.beforeGet = async () => {
      await bounded(
        withTenantTx(database.db, owner, (tx) =>
          tx
            .update(memberships)
            .set({ role: 'member' })
            .where(eq(memberships.id, stale.membershipId)),
        ),
      );
    };
    await expect(
      decideArtifact(database.db, stale, value.accept, { store: value.store }),
    ).rejects.toEqual(new AppError('FORBIDDEN'));
  });

  it('binds SQL acceptance to the work, current objective, exact file and nonlegacy citation proof', async () => {
    const value = await draft();
    await value.ground();
    const unrelated = await draft();
    for (const change of [
      { objectiveSha256: '0'.repeat(64) },
      { artifactSha256: '0'.repeat(64) },
      { citationsSha256: null },
      { citationsSha256: '0'.repeat(64) },
      { workUnitId: unrelated.work.id },
    ])
      await refused(
        withTenantTx(database.db, owner, async (tx) =>
          tx.insert(knowledgeArtifactVerifications).values(await proofRow(value, change)),
        ),
        'EN114',
      );
    await refused(
      withTenantTx(database.db, owner, async (tx) =>
        tx.insert(knowledgeArtifactVerifications).values(
          await proofRow(value, {
            kind: 'grounding',
            verdict: 'passed',
            decidedByMembershipId: null,
          }),
        ),
      ),
      'EN113',
    );
  });

  it('rejects artifact/source tombstones even if rows or object bytes remain', async () => {
    const value = await draft();
    await value.ground();
    await withTenantTx(database.db, service(), (tx) =>
      tx.insert(tombstones).values({
        organizationId: owner.organizationId,
        targetType: 'knowledge_source',
        targetId: value.source.sourceId,
        reasonCode: 'TEST_DELETION',
      }),
    );
    await expect(
      decideArtifact(database.db, owner, value.accept, { store: value.store }),
    ).rejects.toEqual(new AppError('NOT_FOUND'));
    const removed = await draft();
    await removed.ground();
    removed.control.beforeGet = async () => {
      await bounded(
        withTenantTx(database.db, owner, (tx) =>
          tx.insert(tombstones).values({
            organizationId: owner.organizationId,
            targetType: 'artifact',
            targetId: removed.input.artifactId,
            reasonCode: 'TEST_DELETION',
          }),
        ),
      );
    };
    await expect(
      decideArtifact(database.db, owner, removed.accept, { store: removed.store }),
    ).rejects.toEqual(new AppError('NOT_FOUND'));
  });

  it('retains append-only verification history after file deletion without serving its citations', async () => {
    const value = await draft();
    await value.ground();
    await decideArtifact(database.db, owner, value.accept, { store: value.store });
    await deleteArtifact(database.db, value.store, owner, value.input);
    await expect(getArtifactVerification(database.db, owner, value.input)).rejects.toEqual(
      new AppError('NOT_FOUND'),
    );
    const history = await withTenantTx(database.db, service(), (tx) =>
      tx
        .select()
        .from(knowledgeArtifactVerifications)
        .where(eq(knowledgeArtifactVerifications.artifactId, value.input.artifactId)),
    );
    expect(history).toHaveLength(2);
  });

  it('requires a meaningful rejection reason and keeps it out of audit plaintext', async () => {
    const value = await draft();
    const marker = `PRIVATE_REVIEW_REASON_${randomUUID()}`;
    const rejection = { ...value.accept, verdict: 'rejected' as const };
    await expect(decideArtifact(database.db, owner, rejection)).rejects.toEqual(
      new AppError('REASON_REQUIRED'),
    );
    const first = await decideArtifact(database.db, owner, { ...rejection, reason: marker });
    expect(await decideArtifact(database.db, owner, { ...rejection, reason: marker })).toEqual(
      first,
    );
    const { rows } = await su.query(
      'select row_to_json(a) as row from governance.audit_events a where organization_id=$1 and target_ref=$2',
      [owner.organizationId, `artifact:${value.input.artifactId}`],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain(marker);
    expect((await getArtifactVerification(database.db, owner, value.input)).human).toMatchObject({
      verdict: 'rejected',
      reason: marker,
    });
  });

  it('hashes viewer attribution and checks bounded structural coverage without claiming semantic truth', () => {
    const citation = {
      ordinal: 1,
      chunkId: randomUUID(),
      documentId: randomUUID(),
      sourceId: randomUUID(),
      contentSha256: sha256(text),
      artifactStart: 0,
      artifactEnd: text.length,
      recordedByMembershipId: randomUUID(),
    };
    expect(citationProofHash([citation])).not.toBe(
      citationProofHash([{ ...citation, recordedByMembershipId: randomUUID() }]),
    );
    expect(artifactCoverage(Buffer.from(text), [citation])).toBeNull();
    expect(
      artifactCoverage(Buffer.from(text), [{ ...citation, artifactEnd: text.length + 1 }]),
    ).toBe('CITATION_INVALID');
    expect(artifactCoverage(Buffer.from(text), [{ ...citation, artifactEnd: 1 }])).toBe(
      'NOT_GROUNDED',
    );
    expect(artifactCoverage(Buffer.from([255]), [citation])).toBe('CITATION_INVALID');
    expect(artifactCoverage(Buffer.from(text), [])).toBe('NOT_GROUNDED');
  });
});
