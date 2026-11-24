import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPackService } from '@ensemus/application/packs';
import { createRuntimeProductPorts } from '@ensemus/application/product-runtime';
import {
  createObjectRecord,
  getObjectRecord,
  listObjectRecords,
} from '@ensemus/application/custom-objects';
import { openAppDatabase, withTenantTx } from '@ensemus/database';
import { openAgentDatabase } from '@ensemus/database/agent';
import { agentDrafts, processDrafts, objectRecords, objectTypes } from '@ensemus/database/product';
import { and, eq, sql } from 'drizzle-orm';
import { urls } from '../helpers/stack';
import { makeTwoTenants, proveSecondFactor } from '../helpers/product';

describe('HR pack on native roles', () => {
  let database: ReturnType<typeof openAppDatabase>,
    agent: ReturnType<typeof openAgentDatabase>,
    people: Awaited<ReturnType<typeof makeTwoTenants>>;
  let service: ReturnType<typeof createPackService>;
  beforeAll(async () => {
    database = openAppDatabase(urls.app());
    agent = openAgentDatabase(urls.agent());
    people = await makeTwoTenants(database.db);
    await proveSecondFactor(people.a.owner);
    await proveSecondFactor(people.b.owner);
    service = createPackService({
      toolCatalog: createRuntimeProductPorts(database.db).toolCatalog,
    });
  });
  afterAll(async () => {
    await database?.close();
    await agent?.close();
  });
  const error = (code: string) => expect.objectContaining({ code });
  async function install(
    person: typeof people.a.owner,
    version: string,
    declineRestricted = false,
  ) {
    let review = await service.requestPackInstall(database.db, person.context, {
      packKey: 'hr_operations',
      version,
    });
    await expect(
      service.getPackInstallation(
        database.db,
        person === people.a.owner ? people.b.owner.context : people.a.owner.context,
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
    for (const cap of review.capabilities)
      review = await service.decidePackCapability(database.db, person.context, {
        installationId: review.id,
        capabilityKey: cap.key,
        decision: declineRestricted && cap.subject === 'restricted' ? 'declined' : 'accepted',
      });
    return service.activatePack(
      database.db,
      person.context,
      { sessionId: person.sessionId },
      { installationId: review.id, expectedVersion: review.version },
    );
  }
  it('offers both versions through the actual catalog and refuses a member', async () => {
    expect(
      (await service.listPackCatalog(database.db, people.a.owner.context))
        .filter((pack) => pack.key === 'hr_operations')
        .map((pack) => pack.version),
    ).toEqual(['1.0.0', '1.1.0']);
    await expect(
      service.requestPackInstall(database.db, people.a.member.context, {
        packKey: 'hr_operations',
        version: '1.0.0',
      }),
    ).rejects.toMatchObject(error('FORBIDDEN'));
  });
  it('enforces restricted records on direct SQL, indexed queries, native agents and another company through upgrade and rollback', async () => {
    const person = people.a.owner;
    const first = await install(person, '1.0.0');
    expect(first.items).toHaveLength(5);
    const upgraded = await install(person, '1.1.0');
    const type = upgraded.items.find(
      (item) => item.kind === 'object_type' && item.key === 'employment_record',
    )!;
    expect(type).toBeDefined();
    const record = await createObjectRecord(database.db, person.context, {
      typeId: type.id,
      displayName: 'Generated employment reference',
      attributes: { reference: 'GENERATED-HR', custody_note: 'Generated private note' },
    });
    expect(record.classification).toBe('restricted');
    for (const other of [people.a.admin, people.a.member, people.b.owner]) {
      await expect(getObjectRecord(database.db, other.context, record.id)).rejects.toMatchObject(
        error('NOT_FOUND'),
      );
      const page = () =>
        listObjectRecords(database.db, other.context, {
          typeId: type.id,
          filter: { fieldKey: 'reference', equals: 'GENERATED-HR' },
          limit: 1,
        });
      if (other.context.organizationId === person.context.organizationId)
        expect((await page()).items).toEqual([]);
      else await expect(page()).rejects.toMatchObject(error('NOT_FOUND'));
      expect(
        await withTenantTx(database.db, other.context, (tx) =>
          tx.select().from(objectRecords).where(eq(objectRecords.id, record.id)),
        ),
      ).toEqual([]);
    }
    // The native agent cannot become a person even with the owner's user-shaped context and SET ROLE.
    expect(
      await withTenantTx(agent.db, person.context, async (tx) => {
        await tx.execute(sql`set local role ensemus_app`);
        return tx.select().from(objectRecords).where(eq(objectRecords.id, record.id));
      }),
    ).toEqual([]);
    await expect(
      createObjectRecord(database.db, person.context, {
        typeId: type.id,
        displayName: 'Too low',
        classification: 'internal',
        attributes: { reference: 'GENERATED-LOW' },
      }),
    ).rejects.toMatchObject(error('OBJECT_RECORD_INVALID'));
    const rollback = await service.rollbackPack(
      database.db,
      person.context,
      { sessionId: person.sessionId },
      { installationId: upgraded.id, expectedVersion: upgraded.version },
    );
    expect(rollback.packVersion).toBe('1.0.0');
    expect(
      (await getObjectRecord(database.db, person.context, record.id)).attributes,
    ).toMatchObject({ reference: 'GENERATED-HR', custody_note: 'Generated private note' });
    await expect(
      getObjectRecord(database.db, people.a.admin.context, record.id),
    ).rejects.toMatchObject(error('NOT_FOUND'));
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
    for (const draft of [...drafts.agents, ...drafts.processes])
      expect(['editing', 'archived']).toContain(draft.status);
  });
  it('leaves every personal type out when restricted review is declined and grants no assistant access', async () => {
    const person = people.b.owner,
      installed = await install(person, '1.0.0', true);
    expect(installed.items.filter((item) => item.kind === 'object_type')).toEqual([]);
    expect(installed.items.filter((item) => item.kind === 'agent_draft')).toHaveLength(1);
    expect(installed.items.filter((item) => item.kind === 'process_draft')).toHaveLength(1);
    expect(
      await withTenantTx(database.db, person.context, (tx) =>
        tx
          .select()
          .from(objectTypes)
          .where(
            and(
              eq(objectTypes.organizationId, person.context.organizationId),
              eq(objectTypes.state, 'active'),
            ),
          ),
      ),
    ).toEqual([]);
    const drafts = await withTenantTx(database.db, person.context, (tx) =>
      tx
        .select()
        .from(agentDrafts)
        .where(eq(agentDrafts.organizationId, person.context.organizationId)),
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.status).toBe('editing');
  });
});
