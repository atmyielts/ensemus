// Real install/upgrade/rollback on native roles, with the actual metadata catalog and no provider.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPackService } from '@ensemus/application/packs';
import { createRuntimeProductPorts } from '@ensemus/application/product-runtime';
import { createObjectRecord } from '@ensemus/application/custom-objects';
import { openAppDatabase, withTenantTx } from '@ensemus/database';
import {
  agentDrafts,
  objectTypes,
  processDrafts,
  objectRecords,
  objectTypeVersions,
} from '@ensemus/database/product';
import { and, eq } from 'drizzle-orm';
import { urls } from '../helpers/stack';
import { makeTwoTenants, proveSecondFactor } from '../helpers/product';

describe('Marketing pack on the actual installer', () => {
  let database: ReturnType<typeof openAppDatabase>,
    people: Awaited<ReturnType<typeof makeTwoTenants>>;
  let service: ReturnType<typeof createPackService>;
  beforeAll(async () => {
    database = openAppDatabase(urls.app());
    people = await makeTwoTenants(database.db);
    await proveSecondFactor(people.a.owner);
    await proveSecondFactor(people.b.owner);
    service = createPackService({
      toolCatalog: createRuntimeProductPorts(database.db).toolCatalog,
    });
  });
  afterAll(async () => {
    await database?.close();
  });
  const error = (code: string) => expect.objectContaining({ code });
  it('offers both actual versions and refuses an ordinary member', async () => {
    const catalog = await service.listPackCatalog(database.db, people.a.owner.context);
    expect(
      catalog.filter((entry) => entry.key === 'marketing_operations').map((entry) => entry.version),
    ).toEqual(['1.0.0', '1.1.0']);
    await expect(
      service.requestPackInstall(database.db, people.a.member.context, {
        packKey: 'marketing_operations',
        version: '1.0.0',
      }),
    ).rejects.toMatchObject(error('FORBIDDEN'));
  });
  async function install(person: typeof people.a.owner, version: string, declineEffect = false) {
    let review = await service.requestPackInstall(database.db, person.context, {
      packKey: 'marketing_operations',
      version,
    });
    expect(review.status).toBe('reviewing');
    expect(review.items).toEqual([]);
    await expect(
      service.getPackInstallation(
        database.db,
        people.a.organizationId === person.context.organizationId
          ? people.b.owner.context
          : people.a.owner.context,
        review.id,
      ),
    ).rejects.toMatchObject(error('NOT_FOUND'));
    await expect(
      service.activatePack(
        database.db,
        person.context,
        { sessionId: person.sessionId },
        { installationId: review.id, expectedVersion: review.version },
      ),
    ).rejects.toMatchObject(error('PACK_CAPABILITY_UNREVIEWED'));
    for (const capability of review.capabilities)
      review = await service.decidePackCapability(database.db, person.context, {
        installationId: review.id,
        capabilityKey: capability.key,
        decision: declineEffect && capability.kind === 'external_effect' ? 'declined' : 'accepted',
      });
    return service.activatePack(
      database.db,
      person.context,
      { sessionId: person.sessionId },
      { installationId: review.id, expectedVersion: review.version },
    );
  }
  it('creates inactive drafts and records, upgrades and retains entered data through rollback', async () => {
    const person = people.a.owner;
    const first = await install(person, '1.0.0');
    expect(first.items.map((item) => item.kind).sort()).toEqual([
      'agent_draft',
      'agent_draft',
      'object_type',
      'object_type',
      'process_draft',
    ]);
    const upgraded = await install(person, '1.1.0');
    const campaign = upgraded.items.find(
      (item) => item.kind === 'object_type' && item.key === 'campaign',
    )!;
    const record = await createObjectRecord(database.db, person.context, {
      typeId: campaign.id,
      displayName: 'Generated campaign',
      attributes: {
        name: 'Generated campaign',
        stage: 'draft',
        review_note: 'Generated review evidence',
      },
    });
    const rolledBack = await service.rollbackPack(
      database.db,
      person.context,
      { sessionId: person.sessionId },
      { installationId: upgraded.id, expectedVersion: upgraded.version },
    );
    expect(rolledBack.packVersion).toBe('1.0.0');
    const retained = await withTenantTx(database.db, person.context, (tx) =>
      tx
        .select()
        .from(objectRecords)
        .where(
          and(
            eq(objectRecords.organizationId, person.context.organizationId),
            eq(objectRecords.id, record.id),
          ),
        ),
    );
    expect(retained[0]?.attributes).toMatchObject({ review_note: 'Generated review evidence' });
    const versions = await withTenantTx(database.db, person.context, (tx) =>
      tx
        .select()
        .from(objectTypeVersions)
        .where(
          and(
            eq(objectTypeVersions.organizationId, person.context.organizationId),
            eq(objectTypeVersions.typeId, campaign.id),
          ),
        ),
    );
    expect(versions.length).toBeGreaterThanOrEqual(2);
    const drafts = await withTenantTx(database.db, person.context, async (tx) => ({
      agents: await tx
        .select()
        .from(agentDrafts)
        .where(eq(agentDrafts.organizationId, person.context.organizationId)),
      processes: await tx
        .select()
        .from(processDrafts)
        .where(eq(processDrafts.organizationId, person.context.organizationId)),
    }));
    expect(drafts.agents.length).toBeGreaterThan(0);
    for (const draft of drafts.agents) expect(['editing', 'archived']).toContain(draft.status);
    for (const draft of drafts.processes) expect(['editing', 'archived']).toContain(draft.status);
  });
  it('leaves the send process out when its external-effect capability is declined', async () => {
    const result = await install(people.b.owner, '1.0.0', true);
    expect(result.items.filter((item) => item.kind === 'process_draft')).toEqual([]);
    expect(result.items.filter((item) => item.kind === 'agent_draft')).toHaveLength(2);
    const types = await withTenantTx(database.db, people.b.owner.context, (tx) =>
      tx.select().from(objectTypes).where(eq(objectTypes.organizationId, people.b.organizationId)),
    );
    expect(types.map((type) => type.slug).sort()).toEqual(['campaign', 'claim_source']);
  });
});
