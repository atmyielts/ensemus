import { randomUUID } from 'node:crypto';
import {
  artifacts,
  clients,
  memberships,
  openAppDatabase,
  projects,
  resolveTenantContext,
  withTenantTx,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { deleteArtifact, objectKey, refusalFromDatabase } from '@ensemus/application';
import {
  isHeldInTx,
  listLegalHolds,
  placeLegalHold,
  releaseLegalHold,
} from '@ensemus/application/saas/legal-holds';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { urls } from '../helpers/stack';
import { lifecycleArtifact, lifecycleTenant, LifecycleMemoryStore } from './saas-lifecycle-fixture';

describe('legal holds survive every deletion path under actual roles', () => {
  const database = openAppDatabase(urls.app()),
    auth = new pg.Client({ connectionString: urls.auth() });
  beforeAll(async () => {
    await auth.connect();
  });
  afterAll(async () => {
    await auth.end();
    await database.close();
  });
  it('hides holds from admins and members, and rejects another tenant scope', async () => {
    const owner = await lifecycleTenant(database.db, auth),
      other = await lifecycleTenant(database.db, auth);
    for (const role of ['admin', 'member'] as const) {
      const person = await lifecycleTenant(database.db, auth);
      await withTenantTx(database.db, owner, (tx) =>
        tx
          .insert(memberships)
          .values({ organizationId: owner.organizationId, userId: person.userId, role }),
      );
      const context = await resolveTenantContext(database.db, person.userId, owner.organizationId);
      await expect(listLegalHolds(database.db, context)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(
        placeLegalHold(database.db, context, {
          matterRef: randomUUID(),
          scopes: [{ type: 'organization', id: null }],
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        releaseLegalHold(database.db, context, {
          holdId: randomUUID(),
          reasonCode: 'TEST_RELEASE',
          expectedVersion: 1,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    const foreign = await lifecycleArtifact(database.db, other, new LifecycleMemoryStore());
    await expect(
      placeLegalHold(database.db, owner, {
        matterRef: randomUUID(),
        scopes: [{ type: 'artifact', id: foreign.artifactId }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', auditAs: 'FOREIGN_REFERENCE' });
  });
  it('holds an artifact through its work unit, project, client and organization; release permits deletion', async () => {
    for (const type of ['artifact', 'work_unit', 'project', 'client', 'organization'] as const) {
      const owner = await lifecycleTenant(database.db, auth),
        service = createServiceContext(owner.organizationId),
        store = new LifecycleMemoryStore();
      const parent = await withTenantTx(database.db, owner, async (tx) => {
        const [client] = await tx
          .insert(clients)
          .values({ organizationId: owner.organizationId, displayName: 'Same held client' })
          .returning();
        const [project] = await tx
          .insert(projects)
          .values({
            organizationId: owner.organizationId,
            clientId: client!.id,
            name: 'Same held project',
          })
          .returning();
        return { clientId: client!.id, projectId: project!.id };
      });
      const file = await lifecycleArtifact(database.db, owner, store, parent.projectId);
      const target =
        type === 'artifact'
          ? file.artifactId
          : type === 'work_unit'
            ? file.workUnitId
            : type === 'project'
              ? parent.projectId
              : type === 'client'
                ? parent.clientId
                : null;
      const hold = await placeLegalHold(database.db, owner, {
        matterRef: randomUUID(),
        scopes: [{ type, id: target }],
      });
      expect(
        await withTenantTx(database.db, service, (tx) =>
          isHeldInTx(tx, service, { type: 'artifact', id: file.artifactId }),
        ),
      ).toBe(true);
      for (const attempt of [
        () =>
          deleteArtifact(database.db, store, owner, {
            workUnitId: file.workUnitId,
            artifactId: file.artifactId,
          }),
        () =>
          withTenantTx(database.db, owner, (tx) =>
            tx.delete(artifacts).where(eq(artifacts.id, file.artifactId)),
          ),
      ]) {
        let error: unknown;
        try {
          await attempt();
        } catch (caught) {
          error = caught;
        }
        expect(refusalFromDatabase(error)?.code).toBe('LEGAL_HOLD_ACTIVE');
      }
      expect(await store.exists(objectKey(owner.organizationId, file.artifactId))).toBe(true);
      await releaseLegalHold(database.db, owner, {
        holdId: hold.holdId,
        reasonCode: 'TEST_MATTER_CLOSED',
        expectedVersion: 1,
      });
      await expect(
        releaseLegalHold(database.db, owner, {
          holdId: hold.holdId,
          reasonCode: 'TEST_MATTER_CLOSED',
          expectedVersion: 2,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_STATE' });
      await deleteArtifact(database.db, store, owner, {
        workUnitId: file.workUnitId,
        artifactId: file.artifactId,
      });
      expect(await store.exists(objectKey(owner.organizationId, file.artifactId))).toBe(false);
    }
  });
  it('direct client and project deletion meet their hold before any foreign key effects', async () => {
    const owner = await lifecycleTenant(database.db, auth);
    const [client] = await withTenantTx(database.db, owner, (tx) =>
      tx
        .insert(clients)
        .values({ organizationId: owner.organizationId, displayName: 'Held client' })
        .returning(),
    );
    const [project] = await withTenantTx(database.db, owner, (tx) =>
      tx
        .insert(projects)
        .values({ organizationId: owner.organizationId, name: 'Held project' })
        .returning(),
    );
    await placeLegalHold(database.db, owner, {
      matterRef: randomUUID(),
      scopes: [
        { type: 'client', id: client!.id },
        { type: 'project', id: project!.id },
      ],
    });
    for (const table of [clients, projects]) {
      try {
        await withTenantTx(database.db, owner, (tx) =>
          tx.delete(table).where(eq(table.organizationId, owner.organizationId)),
        );
        throw new Error('TEST_DELETION_NOT_REFUSED');
      } catch (error) {
        expect(refusalFromDatabase(error)?.code).toBe('LEGAL_HOLD_ACTIVE');
      }
    }
  });
  it('a deletion recorded before a hold still reapplies to a restored row', async () => {
    const owner = await lifecycleTenant(database.db, auth),
      store = new LifecycleMemoryStore(),
      file = await lifecycleArtifact(database.db, owner, store);
    const [backup] = await withTenantTx(database.db, owner, (tx) =>
      tx.select().from(artifacts).where(eq(artifacts.id, file.artifactId)),
    );
    await deleteArtifact(database.db, store, owner, {
      workUnitId: file.workUnitId,
      artifactId: file.artifactId,
    });
    await placeLegalHold(database.db, owner, {
      matterRef: randomUUID(),
      scopes: [{ type: 'organization', id: null }],
    });
    await withTenantTx(database.db, owner, (tx) => tx.insert(artifacts).values(backup!));
    await withTenantTx(database.db, owner, (tx) =>
      tx.delete(artifacts).where(eq(artifacts.id, file.artifactId)),
    );
    expect(
      await withTenantTx(database.db, owner, (tx) => tx.select().from(artifacts)),
    ).toHaveLength(0);
  });
});
