import {
  federationGrants,
  memberships,
  notifications,
  withTenantTx,
  type AppDatabase,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import {
  federationGrantTargetRef,
  NOTIFY_FEDERATION_GRANT_ACCEPTED,
} from '@ensemus/domain/federation-events';
import { and, eq, notExists, sql } from 'drizzle-orm';
import { notify } from './work';

/** Resolve the counterparty through the committed grant before entering its tenant. */
export async function notifyFederationGrantAccepted(
  database: AppDatabase,
  input: { organizationId: string; grantId: string },
): Promise<number> {
  const receiving = createServiceContext(input.organizationId);
  const pendingAcceptance = and(
    eq(federationGrants.id, input.grantId),
    eq(federationGrants.receivingOrganizationId, receiving.organizationId),
    eq(federationGrants.status, 'accepted'),
    sql`${federationGrants.expiresAt} > now()`,
  );

  const [source] = await withTenantTx(database, receiving, (tx) =>
    tx
      .select({ sharingOrganizationId: federationGrants.sharingOrganizationId })
      .from(federationGrants)
      .where(pendingAcceptance),
  );
  if (!source) return 0;

  const sharing = createServiceContext(source.sharingOrganizationId);
  return withTenantTx(database, sharing, async (tx) => {
    // Recheck after binding the sharing tenant. A confirmation, revocation, concurrent notice
    // delivery or retry all serialize on this row before the recipient list is read.
    const [grant] = await tx
      .select({ id: federationGrants.id })
      .from(federationGrants)
      .where(
        and(pendingAcceptance, eq(federationGrants.sharingOrganizationId, sharing.organizationId)),
      )
      .for('no key update');
    if (!grant) return 0;

    const targetRef = federationGrantTargetRef(grant.id);
    const kind = NOTIFY_FEDERATION_GRANT_ACCEPTED;
    const owners = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, sharing.organizationId),
          eq(memberships.status, 'active'),
          eq(memberships.role, 'owner'),
          notExists(
            tx
              .select({ id: notifications.id })
              .from(notifications)
              .where(
                and(
                  eq(notifications.organizationId, sharing.organizationId),
                  eq(notifications.recipientMembershipId, memberships.id),
                  eq(notifications.kind, kind),
                  eq(notifications.targetRef, targetRef),
                ),
              ),
          ),
        ),
      );
    await notify(
      tx,
      sharing,
      owners.map((owner) => owner.id),
      kind,
      targetRef,
    );
    return owners.length;
  });
}
