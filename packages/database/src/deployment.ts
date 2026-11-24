// For one-shot deploy jobs only, which connect as the migrator (ADR-035 D5). Lint keeps this out of the web tier
// and out of Activities. No request can reach it, so no tenant can change what tier or region it is in.
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { deploymentProfile, isolationEvidence } from './schema-tenancy';

export type DeploymentProfileRow = typeof deploymentProfile.$inferSelect;
export type IsolationEvidenceInsert = typeof isolationEvidence.$inferInsert;

/** A pin is who this deployment belongs to. Changing it would hand one tenant's deployment to another. */
export class PinChangeRefused extends Error {
  override name = 'PinChangeRefused';
}

async function withMigrator<T>(
  url: string,
  fn: (db: NodePgDatabase<Record<string, unknown>>) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: url, application_name: 'ensemus-deploy' });
  await client.connect();
  try {
    return await fn(drizzle(client, { casing: 'snake_case' }));
  } finally {
    await client.end();
  }
}

/** Writes the one row, replacing what was there. It refuses to change a pin once it is set. */
export function applyDeploymentProfile(
  migratorUrl: string,
  profile: {
    tier: 'shared' | 'dedicated';
    pinnedOrganizationId: string | null;
    homeRegion: string | null;
    crossOrgEnabled: boolean;
    profileSha256: string;
  },
): Promise<void> {
  return withMigrator(migratorUrl, async (db) => {
    const values = { ...profile, appliedAt: new Date() };
    const [written] = await db
      .insert(deploymentProfile)
      .values({ singleton: true, ...values })
      .onConflictDoUpdate({
        target: deploymentProfile.singleton,
        set: values,
        // Check the winning row when two setup jobs arrive together on an empty database.
        setWhere: sql`${deploymentProfile.pinnedOrganizationId} is null
          or ${deploymentProfile.pinnedOrganizationId} = excluded.pinned_organization_id`,
      })
      .returning({ singleton: deploymentProfile.singleton });
    if (!written) {
      throw new PinChangeRefused('This deployment is already dedicated to one organization.');
    }
  });
}

export function readAppliedDeploymentProfile(migratorUrl: string) {
  return withMigrator(migratorUrl, async (db) => {
    const [profile] = await db.select().from(deploymentProfile).limit(1);
    return profile;
  });
}

/** Adds what one run of the isolation report found. These are never changed afterwards. */
export async function recordIsolationEvidence(
  migratorUrl: string,
  rows: readonly IsolationEvidenceInsert[],
): Promise<void> {
  if (rows.length === 0) return;
  await withMigrator(migratorUrl, (db) => db.insert(isolationEvidence).values([...rows]));
}
