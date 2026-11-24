// Test seeds for ADR-035, shared by every M11C slice. They walk a grant to a status through the real triggers,
// as the application role, so a seed can never reach a state the rules forbid. Generated values only.
//
// The bridge role is made here with a throwaway password, because it exists only where an operator created
// it, and the test stack does not provision it (ADR-035 D2). Profile changes are global to the database, so
// whoever sets one clears it in afterAll, and the integration project runs files one at a time.
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  federationGrants,
  federationOrgSettings,
  federationOutboundItems,
  organizations,
  withGrantInvitationTx,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
} from '@ensemus/database';
import {
  buildGrantTerms,
  grantTermsHash,
  hashFederationToken,
  itemContentHash,
  newFederationToken,
  type FederationClassification,
  type FederationGrantStatus,
  type FederationItemKind,
  type FederationPurpose,
} from '@ensemus/domain/federation';
import { eq } from 'drizzle-orm';
import { urls } from './stack';

export const client = async (url: string) => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  return c;
};

/** Creates the role if it is missing, gives it a new password, applies its grants, and says how to log in. */
export async function ensureBridgeRole(): Promise<string> {
  const password = randomBytes(24).toString('hex');
  const su = await client(urls.superuser());
  const migrator = await client(urls.migrator());
  try {
    const { rows } = await su.query(`select 1 from pg_roles where rolname = 'ensemus_federation'`);
    const verb = rows.length === 0 ? 'CREATE' : 'ALTER';
    const extras = rows.length === 0 ? ' LOGIN NOSUPERUSER NOCREATEROLE NOBYPASSRLS' : '';
    await su.query(`${verb} ROLE ensemus_federation${extras} NOINHERIT PASSWORD '${password}'`);
    await migrator.query('select federation.apply_bridge_grants()');
  } finally {
    await su.end();
    await migrator.end();
  }
  const url = new URL(urls.app());
  url.username = 'ensemus_federation';
  url.password = password;
  return url.toString();
}

export type ProfileInput = {
  tier?: 'shared' | 'dedicated';
  pinnedOrganizationId?: string | null;
  homeRegion?: string | null;
  crossOrgEnabled?: boolean;
};

/** As the deploy job does it, by the migrator. Replaces what was there. */
export async function setDeploymentProfile(input: ProfileInput): Promise<void> {
  const migrator = await client(urls.migrator());
  try {
    await migrator.query('delete from tenancy.deployment_profile');
    await migrator.query(
      `insert into tenancy.deployment_profile
         (tier, pinned_organization_id, home_region, cross_org_enabled, profile_sha256)
       values ($1, $2, $3, $4, $5)`,
      [
        input.tier ?? 'shared',
        input.pinnedOrganizationId ?? null,
        input.homeRegion ?? null,
        input.crossOrgEnabled ?? false,
        '0'.repeat(64),
      ],
    );
  } finally {
    await migrator.end();
  }
}

export async function clearDeploymentProfile(): Promise<void> {
  const migrator = await client(urls.migrator());
  try {
    await migrator.query('delete from tenancy.deployment_profile');
  } finally {
    await migrator.end();
  }
}

/** Turns a tenant's own switch on, as its owner. */
export async function enableFederation(database: AppDatabase, owner: TenantContext) {
  await withTenantTx(database, owner, async (tx) => {
    await tx
      .insert(federationOrgSettings)
      .values({
        organizationId: owner.organizationId,
        enabled: true,
        version: 1,
        changedByMembershipId: owner.membershipId,
      })
      .onConflictDoNothing();
  });
}

export type SeededGrant = {
  id: string;
  token: string;
  termsHash: string;
  version: number;
  status: FederationGrantStatus;
};

/**
 * Walks a grant to `status` through the real triggers. Both owners must have their switch on, unless a test
 * wants to prove what happens otherwise, in which case it stops at the step it is testing.
 */
export async function seedGrant(
  database: AppDatabase,
  sharing: TenantContext,
  receiving: TenantContext,
  options: {
    status?: Exclude<FederationGrantStatus, 'ended'>;
    purpose?: FederationPurpose;
    maxClassification?: FederationClassification;
    expiresAt?: Date;
  } = {},
): Promise<SeededGrant> {
  const status = options.status ?? 'active';
  const purpose = options.purpose ?? 'delegated_work';
  const maxClassification = options.maxClassification ?? 'internal';
  const expiresAt = options.expiresAt ?? new Date(Date.now() + 86_400_000);
  const token = newFederationToken();
  const id = randomUUID();
  const [{ name }] = (await withTenantTx(database, sharing, (tx) =>
    tx
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, sharing.organizationId)),
  )) as [{ name: string }];
  const terms = buildGrantTerms({
    purpose,
    maxClassification,
    sharingOrganizationId: sharing.organizationId,
    sharingDisplayName: name,
    expiresAt,
    note: null,
  });
  const termsHash = grantTermsHash(terms);
  await withTenantTx(database, sharing, (tx) =>
    tx.insert(federationGrants).values({
      id,
      sharingOrganizationId: sharing.organizationId,
      purpose,
      maxClassification,
      terms,
      termsHash,
      tokenHash: hashFederationToken(token),
      invitationExpiresAt: new Date(Math.min(Date.now() + 3_600_000, expiresAt.getTime())),
      expiresAt,
      sharingDisplayName: name,
      proposedByMembershipId: sharing.membershipId,
    }),
  );
  if (status === 'proposed') return { id, token, termsHash, version: 1, status };

  const [{ name: receivingName }] = (await withTenantTx(database, receiving, (tx) =>
    tx
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, receiving.organizationId)),
  )) as [{ name: string }];
  await withGrantInvitationTx(database, receiving, hashFederationToken(token), (tx) =>
    tx
      .update(federationGrants)
      .set({
        status: 'accepted',
        receivingOrganizationId: receiving.organizationId,
        receivingDisplayName: receivingName,
        acceptedByMembershipId: receiving.membershipId,
        acceptedTermsHash: termsHash,
        acceptedAt: new Date(),
        version: 2,
      })
      .where(eq(federationGrants.id, id)),
  );
  if (status === 'accepted') return { id, token, termsHash, version: 2, status };

  await withTenantTx(database, sharing, (tx) =>
    tx
      .update(federationGrants)
      .set({
        status: 'active',
        confirmedByMembershipId: sharing.membershipId,
        confirmedTermsHash: termsHash,
        confirmedAt: new Date(),
        version: 3,
      })
      .where(eq(federationGrants.id, id)),
  );
  return { id, token, termsHash, version: 3, status };
}

/** Queues one item, as the sender, with a body that needs no file. */
export async function seedOutboundItem(
  database: AppDatabase,
  sender: TenantContext,
  grantId: string,
  options: {
    kind?: Exclude<FederationItemKind, 'artifact'>;
    classification?: string;
    title?: string;
    body?: Record<string, unknown>;
  } = {},
) {
  const id = randomUUID();
  const kind = options.kind ?? 'work_summary';
  const classification = options.classification ?? 'internal';
  const title = options.title ?? 'A shared summary';
  const body = options.body ?? {};
  const contentSha256 = itemContentHash({ kind, classification, title, body, fileSha256: null });
  await withTenantTx(database, sender, (tx) =>
    tx.insert(federationOutboundItems).values({
      organizationId: sender.organizationId,
      id,
      grantId,
      kind,
      classification,
      title,
      body,
      contentSha256,
      createdByMembershipId: sender.membershipId,
    }),
  );
  return { id, kind, classification, title, body, contentSha256 };
}
