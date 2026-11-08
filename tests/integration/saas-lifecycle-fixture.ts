import { nativeSovereignContext } from '../helpers/sovereign';
import { createHash, randomUUID } from 'node:crypto';
import {
  artifacts,
  createOrganization,
  workArtifacts,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
} from '@ensemus/database';
import { addArtifact, createWorkUnit, objectKey, type ObjectStore } from '@ensemus/application';
import type pg from 'pg';

export class LifecycleMemoryStore implements ObjectStore {
  readonly objects = new Map<string, Buffer>();
  async put(key: string, body: Buffer) {
    this.objects.set(key, Buffer.from(body));
  }
  async get(key: string) {
    const body = this.objects.get(key);
    if (!body) throw new Error('TEST_MISSING_BYTES');
    return Buffer.from(body);
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async exists(key: string) {
    return this.objects.has(key);
  }
  // Explicit test-only unversioned map model. This proves orchestration/SQL, never S3 capability.
  async deleteForPurge(key:string):Promise<{transport:'deleted'|'unknown';capabilityVerified:boolean}> {
    try { await this.delete(key); }
    catch { return {transport:'unknown',capabilityVerified:false}; }
    return {transport:'deleted',capabilityVerified:true};
  }
  async isPhysicallyAbsent(key:string) {
    return !this.objects.has(key);
  }
  async *listPages(prefix:string) {
    yield [...this.objects.keys()].filter((key)=>key.startsWith(prefix));
  }
}
export async function lifecycleTenant(database: AppDatabase, auth: pg.Client) {
  const userId = randomUUID();
  await auth.query('insert into identity.users(id,name,email) values($1,$2,$3)', [
    userId,
    'Same lifecycle name',
    `${userId}@example.invalid`,
  ]);
  const org = await createOrganization(database, {
    userId,
    name: 'Same lifecycle name',
    commercialMode: 'byom',
  });
  return nativeSovereignContext(database, userId, org.organizationId);
}
export async function lifecycleArtifact(
  database: AppDatabase,
  owner: TenantContext,
  store: LifecycleMemoryStore,
  projectId?: string,
  createdAt?: Date,
) {
  const work = await createWorkUnit(database, owner, {
    title: 'Same retained work',
    ...(projectId ? { projectId } : {}),
  });
  const body = Buffer.from(`test-${randomUUID()}`);
  if (createdAt) {
    const id = randomUUID(),
      key = objectKey(owner.organizationId, id);
    await store.put(key, body);
    await withTenantTx(database, owner, async (tx) => {
      await tx.insert(artifacts).values({
        organizationId: owner.organizationId,
        id,
        name: 'test-file.txt',
        objectKey: key,
        sha256: createHash('sha256').update(body).digest('hex'),
        mimeType: 'text/plain',
        sizeBytes: body.length,
        classification: 'internal',
        createdByMembershipId: owner.membershipId,
        createdAt,
      });
      await tx
        .insert(workArtifacts)
        .values({ organizationId: owner.organizationId, workUnitId: work.id, artifactId: id });
    });
    return { workUnitId: work.id, artifactId: id };
  }
  const file = await addArtifact(database, store, owner, {
    workUnitId: work.id,
    name: 'test-file.txt',
    mimeType: 'text/plain',
    body,
  });
  return { workUnitId: work.id, artifactId: file.id };
}
export const lifecycleExpiredArtifact = (
  database: AppDatabase,
  owner: TenantContext,
  store: LifecycleMemoryStore,
) => lifecycleArtifact(database, owner, store, undefined, new Date(Date.now() - 10 * 86400000));
