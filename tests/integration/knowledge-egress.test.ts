import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError, createWorkUnit } from '@ensemus/application';
import {
  listEgressLedger,
  simulateProvider,
  createKnowledgeReadPorts,
} from '@ensemus/application/knowledge/egress';
import { createEgressLog } from '@ensemus/application/ai-egress-log';
import {
  openAgentTestDatabase,
  prepareRunInputContext,
  seedAgentVersion,
  seedAiTenant,
  seedQueuedRun,
} from '../helpers/ai/fixtures';
import { recordModelCall } from '@ensemus/application/knowledge/embeddings';
import type { EgressLedgerRow, RunEgressDecisions } from '@ensemus/application/knowledge/ports';
import {
  createOrganization,
  memberships,
  openAppDatabase,
  resolveTenantContext,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { eq, sql } from 'drizzle-orm';
import { knowledgeCanary, seedMember, seedSearchableSource, sha256 } from '../helpers/knowledge';
import { urls } from '../helpers/stack';

describe('egress ledger and no-transmission simulator', () => {
  let database: ReturnType<typeof openAppDatabase>,
    auth: pg.Client,
    owner: TenantContext,
    reader: TenantContext,
    foreign: TenantContext;
  const noRuns: RunEgressDecisions = { list: async () => [] };
  beforeAll(async () => {
    database = openAppDatabase(urls.app());
    auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
    const createOwner = async () => {
      const userId = randomUUID();
      await auth.query('insert into identity.users(id,name,email) values($1,$2,$3)', [
        userId,
        'Generated',
        `${userId}@example.invalid`,
      ]);
      const org = await createOrganization(database.db, {
        userId,
        name: 'Same company',
        commercialMode: 'sovereign',
      });
      return resolveTenantContext(database.db, userId, org.organizationId);
    };
    owner = await createOwner();
    foreign = await createOwner();
    const person = await seedMember(database.db, owner, auth);
    reader = await resolveTenantContext(database.db, person.userId, owner.organizationId);
  });
  afterAll(async () => {
    await auth.end();
    await database.close();
  });
  it('refuses ordinary members, service contexts and a stale privileged role before invoking sibling readers', async () => {
    let calls = 0;
    const runDecisions: RunEgressDecisions = {
      list: async () => {
        calls++;
        return [];
      },
    };
    for (const context of [reader, createServiceContext(owner.organizationId)])
      await expect(listEgressLedger(database.db, context, { runDecisions }, {})).rejects.toEqual(
        new AppError('FORBIDDEN'),
      );
    const person = await seedMember(database.db, owner, auth, 'admin'),
      stale = await resolveTenantContext(database.db, person.userId, owner.organizationId);
    await withTenantTx(database.db, owner, (tx) =>
      tx.update(memberships).set({ role: 'member' }).where(eq(memberships.id, person.membershipId)),
    );
    await expect(listEgressLedger(database.db, stale, { runDecisions }, {})).rejects.toEqual(
      new AppError('FORBIDDEN'),
    );
    expect(calls).toBe(0);
  });
  it('keeps a generated passage out of every row and another tenant’s ledger', async () => {
    const word = knowledgeCanary();
    await withTenantTx(database.db, owner, (tx) =>
      recordModelCall(tx, owner, {
        purpose: 'embed',
        dataClass: 'restricted',
        decision: 'deny',
        reasonCode: 'EGRESS_DENIED',
        policyVersion: 'v1',
        requestSha256: sha256(word),
        inputCount: 1,
      }),
    );
    const own = await listEgressLedger(database.db, owner, { runDecisions: noRuns }, {}),
      other = await listEgressLedger(database.db, foreign, { runDecisions: noRuns }, {});
    expect(own.items.some((row) => row.requestSha256 === sha256(word))).toBe(true);
    expect(JSON.stringify(own)).not.toContain(word);
    expect(other.items).toEqual([]);
  });
  it('reads real agent decisions with stable pagination and actual live-version workloads, scoped to their tenant', async () => {
    const tenant = await seedAiTenant(database.db);
    const version = await seedAgentVersion(database.db, tenant.owner);
    await seedAgentVersion(database.db, tenant.owner); // An unpublished, unused version is not a live workload.
    const work = await createWorkUnit(database.db, tenant.owner, {
      title: 'Synthetic ledger work',
    });
    const runId = await seedQueuedRun(database.db, tenant.owner, { workUnitId: work.id, version });
    const agent = openAgentTestDatabase();
    try {
      const context = await prepareRunInputContext(agent.db, tenant.organizationId, runId);
      const hash = sha256(knowledgeCanary());
      for (let index = 0; index < 3; index++)
        await createEgressLog(agent.db).record(context, {
          runId,
          stepId: null,
          profileId: null,
          dataClass: 'internal',
          purpose: 'reason',
          destinationHost: null,
          decision: 'deny',
          reasonCode: 'NO_CANDIDATE',
          policyVersion: 'synthetic',
          requestHash: hash,
          expiresAt: null,
        });
      const ports = await createKnowledgeReadPorts(database.db, tenant.owner);
      expect(ports.coverage).toBe('complete');
      const seen: string[] = [];
      let after: string | undefined;
      for (let index = 0; index < 3; index++) {
        const page = await listEgressLedger(database.db, tenant.owner, ports, {
          limit: 1,
          ...(after ? { after } : {}),
        });
        expect(page.items).toMatchObject([
          {
            source: 'agent_run',
            runId,
            purpose: 'reason',
            requestSha256: hash,
            providerKind: null,
          },
        ]);
        seen.push(page.items[0]!.id);
        after = page.next ?? undefined;
      }
      expect(new Set(seen).size).toBe(3);
      expect(after).toBeUndefined();
      const workloads = await withTenantTx(database.db, tenant.owner, (tx) =>
        ports.agentWorkloads.list(tx),
      );
      expect(workloads).toMatchObject([
        {
          kind: 'agent',
          purpose: 'reason',
          classes: ['public', 'internal', 'confidential', 'restricted'],
        },
      ]);
      expect(workloads).toHaveLength(1);
      const foreignPorts = await createKnowledgeReadPorts(database.db, foreign);
      const foreignPage = await listEgressLedger(database.db, foreign, foreignPorts, {
        limit: 100,
      });
      expect(foreignPage.items.some((row) => row.runId === runId || seen.includes(row.id))).toBe(
        false,
      );
      expect(
        await withTenantTx(database.db, foreign, (tx) => foreignPorts.agentWorkloads.list(tx)),
      ).toEqual([]);
    } finally {
      await agent.close();
    }
  });
  it('paginates same-millisecond records from both sources without dropping microsecond rows', async () => {
    const ids: string[] = Array.from({ length: 7 }, () => randomUUID())
        .sort()
        .reverse(),
      at = new Date('2099-01-01T00:00:00.123Z');
    await withTenantTx(database.db, owner, async (tx) => {
      for (const [offset, id] of ids.slice(0, 4).entries())
        await tx.execute(sql`insert into knowledge.model_calls(organization_id,id,purpose,data_class,decision,reason_code,policy_version,request_sha256,occurred_at)
    values(${owner.organizationId}::uuid,${id}::uuid,'embed','internal','deny','EGRESS_DENIED','v1',${'0'.repeat(64)},${at}::timestamptz+${offset + 1}*interval '1 microsecond')`);
    });
    const agentRows: EgressLedgerRow[] = ids.slice(4).map((id) => ({
      id,
      occurredAt: at,
      source: 'agent_run',
      purpose: 'answer',
      dataClass: 'internal',
      modelProfileRef: null,
      providerKind: null,
      destinationHost: null,
      decision: 'deny',
      reasonCode: 'EGRESS_DENIED',
      policyVersion: 'v1',
      requestSha256: null,
      runId: randomUUID(),
    }));
    const runDecisions: RunEgressDecisions = {
      list: async (_tx, { before, limit }) =>
        agentRows
          .filter(
            (row) =>
              !before ||
              row.occurredAt.getTime() < before.occurredAt.getTime() ||
              (row.occurredAt.getTime() === before.occurredAt.getTime() && row.id < before.id),
          )
          .slice(0, limit),
    };
    const seen: string[] = [];
    let after: string | undefined;
    for (let page = 0; page < 4; page++) {
      const result = await listEgressLedger(
        database.db,
        owner,
        { runDecisions },
        { limit: 2, ...(after ? { after } : {}) },
      );
      seen.push(...result.items.map((row) => row.id).filter((id) => ids.includes(id)));
      after = result.next ?? undefined;
    }
    expect(seen).toEqual(ids);
    expect(new Set(seen).size).toBe(7);
  });
  it('shows actual source classes and sibling workloads with no model, secret or socket port', async () => {
    await seedSearchableSource(database.db, owner, {
      passages: [knowledgeCanary()],
      classification: 'restricted',
      grants: [],
    });
    let evaluated = 0,
      listed = 0;
    const proposal = {
      destination: 'customer_byom_public_api' as const,
      destinationHost: 'generated.example.invalid',
      billingOwner: 'customer' as const,
      retentionBasis: 'unreviewed' as const,
      region: null,
      contractRef: null,
      allowedClasses: ['internal' as const],
      purposes: ['embed' as const],
    };
    const rows = await simulateProvider(
      database.db,
      owner,
      {
        policy: {
          evaluate: () => {
            evaluated++;
            return { allow: false, reasonCode: 'EGRESS_DENIED', policyVersion: 'v1' };
          },
        },
        agentWorkloads: {
          list: async () => {
            listed++;
            return [
              { key: 'generated-agent', kind: 'agent', purpose: 'answer', classes: ['restricted'] },
            ];
          },
        },
      },
      { proposal },
    );
    expect(listed).toBe(1);
    expect(evaluated).toBe(4);
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => !row.wouldTransmit)).toBe(true);
    await expect(
      simulateProvider(
        database.db,
        reader,
        {
          policy: {
            evaluate: () => {
              throw new Error('UNEXPECTED');
            },
          },
          agentWorkloads: {
            list: async () => {
              throw new Error('UNEXPECTED');
            },
          },
        },
        { proposal },
      ),
    ).rejects.toEqual(new AppError('FORBIDDEN'));
  });
});
