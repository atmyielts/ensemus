// The bridge role reads just one grant at a time (ADR-035 D2). These transactions never access
// object storage. Migration 0703 checks the exact copy, the parties and the allowed state changes.
import { FEDERATION_REFUSE_CODES, inboundObjectKey } from '@ensemus/domain/federation';
import { and, asc, eq, or, sql } from 'drizzle-orm';
import type { BridgeDatabase } from './federation';
import {
  federationCrossings,
  federationGrants,
  federationInboundItems,
  federationOutboundItems,
} from './schema-federation';
import type { Tx } from './tenant';

export type CrossingOutcome = 'delivered' | 'closed' | 'refused' | 'withdrawn';

export type ItemToCross = {
  itemId: string;
  kind: string;
  senderOrganizationId: string;
  receiverOrganizationId: string;
  fileObjectKey: string | null;
  fileSha256: string | null;
  fileSizeBytes: number | null;
  fileMimeType: string | null;
};

type ItemReference = { grantId: string; senderOrganizationId: string; itemId: string };
type VerifiedFile = { sha256: string; sizeBytes: number };
export type PurgedItem = {
  itemId: string;
  receiverOrganizationId: string;
  fileObjectKey: string | null;
};
type PurgeRequest = { grantId: string; limit: number } & (
  { itemId?: never; senderOrganizationId?: never } | Omit<ItemReference, 'grantId'>
);

type Parties = { sharing: string; receiving: string | null };
function counterparty(grant: Parties, organizationId: string): string | null {
  if (grant.sharing === organizationId) return grant.receiving;
  if (grant.receiving === organizationId) return grant.sharing;
  return null;
}

async function readBoundGrant(tx: Tx, grantId: string) {
  const [row] = await tx
    .select({
      sharing: federationGrants.sharingOrganizationId,
      receiving: federationGrants.receivingOrganizationId,
      status: federationGrants.status,
      open: sql<boolean>`federation.grant_is_open(${federationGrants.id})
        and ${federationGrants.expiresAt} > clock_timestamp()`,
    })
    .from(federationGrants)
    .where(eq(federationGrants.id, grantId));
  return row;
}

const outbound = (input: ItemReference) =>
  and(
    eq(federationOutboundItems.grantId, input.grantId),
    eq(federationOutboundItems.organizationId, input.senderOrganizationId),
    eq(federationOutboundItems.id, input.itemId),
  );

/** Record revocation and final delivery in one order. Always take this before any row lock here. */
function lockGrantForDelivery(tx: Tx, grantId: string) {
  return tx.execute(
    sql`select pg_advisory_xact_lock_shared(federation.grant_lock_key(${grantId}::uuid))`,
  );
}

export function readItemToCross(
  database: BridgeDatabase,
  input: ItemReference,
): Promise<ItemToCross | null> {
  return database.withGrant(input.grantId, async (tx) => {
    const grant = await readBoundGrant(tx, input.grantId);
    if (!grant?.open) return null;
    const senderOrganizationId = input.senderOrganizationId.toLowerCase();
    const receiverOrganizationId = counterparty(grant, senderOrganizationId);
    if (!receiverOrganizationId) return null;
    const [item] = await tx
      .select({
        itemId: federationOutboundItems.id,
        kind: federationOutboundItems.kind,
        fileObjectKey: federationOutboundItems.fileObjectKey,
        fileSha256: federationOutboundItems.fileSha256,
        fileSizeBytes: federationOutboundItems.fileSizeBytes,
        fileMimeType: federationOutboundItems.fileMimeType,
      })
      .from(federationOutboundItems)
      .where(and(outbound(input), eq(federationOutboundItems.state, 'queued')));
    return item ? { ...item, senderOrganizationId, receiverOrganizationId } : null;
  });
}

class GrantClosedDuringDelivery extends Error {}

function isGrantClosedDuringDelivery(error: unknown): boolean {
  if (error instanceof GrantClosedDuringDelivery) return true;
  const cause = error instanceof Error ? error.cause : null;
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'EN722';
}

export async function crossItem(
  database: BridgeDatabase,
  input: ItemReference & { verifiedFile?: VerifiedFile },
): Promise<CrossingOutcome> {
  try {
    return await database.withGrant(input.grantId, async (tx) => {
      await lockGrantForDelivery(tx, input.grantId);
      const grant = await readBoundGrant(tx, input.grantId);
      if (!grant?.open) return 'closed';
      const senderOrganizationId = input.senderOrganizationId.toLowerCase();
      const receiverOrganizationId = counterparty(grant, senderOrganizationId);
      if (!receiverOrganizationId) return 'closed';
      const [item] = await tx
        .select()
        .from(federationOutboundItems)
        .where(outbound(input))
        .for('no key update');
      if (!item) return 'closed';
      if (item.state !== 'queued') {
        if (item.state === 'delivered' || item.state === 'refused' || item.state === 'withdrawn')
          return item.state;
        throw new Error('FEDERATION_INVALID_ITEM_STATE');
      }
      if (
        item.fileObjectKey &&
        (!input.verifiedFile ||
          input.verifiedFile.sha256 !== item.fileSha256 ||
          input.verifiedFile.sizeBytes !== item.fileSizeBytes)
      )
        throw new Error('FEDERATION_FILE_PROOF_REQUIRED');

      // The grant could have expired while we waited for the row. Retest against the database clock.
      if (!(await readBoundGrant(tx, input.grantId))?.open) return 'closed';
      await tx.insert(federationInboundItems).values({
        organizationId: receiverOrganizationId,
        senderOrganizationId,
        id: item.id,
        grantId: item.grantId,
        kind: item.kind,
        classification: item.classification,
        title: item.title,
        body: item.body,
        contentSha256: item.contentSha256,
        fileObjectKey: item.fileObjectKey
          ? inboundObjectKey(receiverOrganizationId, item.id)
          : null,
        fileSha256: item.fileSha256,
        fileSizeBytes: item.fileSizeBytes,
        fileMimeType: item.fileMimeType,
      });
      const [changed] = await tx
        .update(federationOutboundItems)
        .set({
          state: 'delivered',
          deliveredAt: sql`clock_timestamp()`,
          version: item.version + 1,
        })
        .where(outbound(input))
        .returning({ id: federationOutboundItems.id });
      if (!changed) throw new GrantClosedDuringDelivery('FEDERATION_GRANT_NOT_OPEN');
      await tx.insert(federationCrossings).values({
        grantId: item.grantId,
        itemId: item.id,
        senderOrganizationId,
        receiverOrganizationId,
        kind: item.kind,
        outcome: 'delivered',
        contentSha256: item.contentSha256,
      });
      return 'delivered';
    });
  } catch (error) {
    if (isGrantClosedDuringDelivery(error)) return 'closed';
    throw error;
  }
}

export async function refuseItem(
  database: BridgeDatabase,
  input: ItemReference & { code: string },
): Promise<void> {
  if (!FEDERATION_REFUSE_CODES.some((code) => code === input.code))
    throw new Error('FEDERATION_INVALID_REFUSE_CODE');
  await database.withGrant(input.grantId, async (tx) => {
    await lockGrantForDelivery(tx, input.grantId);
    const grant = await readBoundGrant(tx, input.grantId);
    if (!grant?.open) return;
    const senderOrganizationId = input.senderOrganizationId.toLowerCase();
    const receiverOrganizationId = counterparty(grant, senderOrganizationId);
    if (!receiverOrganizationId) return;
    const [item] = await tx
      .update(federationOutboundItems)
      .set({
        state: 'refused',
        refuseCode: input.code,
        version: sql`${federationOutboundItems.version} + 1`,
      })
      .where(
        and(
          outbound(input),
          eq(federationOutboundItems.state, 'queued'),
          sql`federation.grant_is_open(${federationOutboundItems.grantId})
          and exists (
            select 1 from federation.grants g
             where g.id = ${federationOutboundItems.grantId} and g.expires_at > clock_timestamp()
          )`,
        ),
      )
      .returning({
        id: federationOutboundItems.id,
        grantId: federationOutboundItems.grantId,
        kind: federationOutboundItems.kind,
        contentSha256: federationOutboundItems.contentSha256,
      });
    if (!item) return;
    await tx.insert(federationCrossings).values({
      grantId: item.grantId,
      itemId: item.id,
      senderOrganizationId,
      receiverOrganizationId,
      kind: item.kind,
      outcome: 'refused',
      code: input.code,
      contentSha256: item.contentSha256,
    });
  });
}

/**
 * A grant purge requires a permanent ending. An item purge on an open grant requires a recorded
 * withdrawal by the sender. Removing inbound rows keeps the outbound references for storage cleanup.
 */
export async function purgeInboundCopies(
  database: BridgeDatabase,
  input: PurgeRequest,
): Promise<readonly PurgedItem[]> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
    throw new Error('FEDERATION_INVALID_PURGE_LIMIT');

  return database.withGrant(input.grantId, async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(federation.grant_lock_key(${input.grantId}::uuid))`,
    );
    const grant = await readBoundGrant(tx, input.grantId);
    if (!grant) return [];
    const receiver =
      input.itemId === undefined
        ? undefined
        : counterparty(grant, input.senderOrganizationId.toLowerCase());
    if (receiver === null) return [];
    if (grant.status !== 'ended') {
      if (input.itemId === undefined || !grant.open) return [];
      const [withdrawn] = await tx
        .select({ id: federationOutboundItems.id })
        .from(federationOutboundItems)
        .where(and(outbound(input), eq(federationOutboundItems.state, 'withdrawn')));
      if (!withdrawn) return [];
    }

    const scope = eq(federationInboundItems.grantId, input.grantId);
    const targets = await tx
      .select({
        id: federationInboundItems.id,
        organizationId: federationInboundItems.organizationId,
      })
      .from(federationInboundItems)
      .where(
        and(
          scope,
          input.itemId === undefined ? undefined : eq(federationInboundItems.id, input.itemId),
          receiver === undefined ? undefined : eq(federationInboundItems.organizationId, receiver),
        ),
      )
      .orderBy(asc(federationInboundItems.organizationId), asc(federationInboundItems.id))
      .limit(input.limit);
    if (!targets.length) return [];
    const removed = await tx
      .delete(federationInboundItems)
      .where(
        and(
          scope,
          or(
            ...targets.map((target) =>
              and(
                eq(federationInboundItems.id, target.id),
                eq(federationInboundItems.organizationId, target.organizationId),
              ),
            ),
          ),
        ),
      )
      .returning({
        itemId: federationInboundItems.id,
        receiverOrganizationId: federationInboundItems.organizationId,
        fileObjectKey: federationInboundItems.fileObjectKey,
        kind: federationInboundItems.kind,
        contentSha256: federationInboundItems.contentSha256,
      });
    if (!removed.length) return [];
    await tx.insert(federationCrossings).values(
      removed.map((item) => {
        const senderOrganizationId = counterparty(grant, item.receiverOrganizationId);
        if (!senderOrganizationId) throw new Error('FEDERATION_INVALID_PURGE_PARTY');
        return {
          grantId: input.grantId,
          itemId: item.itemId,
          senderOrganizationId,
          receiverOrganizationId: item.receiverOrganizationId,
          kind: item.kind,
          outcome: 'purged',
          contentSha256: item.contentSha256,
        };
      }),
    );
    return removed.map(({ itemId, receiverOrganizationId, fileObjectKey }) => ({
      itemId,
      receiverOrganizationId,
      fileObjectKey,
    }));
  });
}
