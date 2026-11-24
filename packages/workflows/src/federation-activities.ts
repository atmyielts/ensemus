// IDs only cross Temporal. Bytes and their verification stay inside an Activity.
import { createHash } from 'node:crypto';
import {
  crossItem,
  isInboundCopyRemoved,
  purgeInboundCopies,
  readItemToCross,
  refuseItem,
} from '@ensemus/database/federation';
import { createServiceContext } from '@ensemus/database/service';
import {
  FEDERATION_MAX_FILE_BYTES,
  inboundObjectKey,
  outboundObjectKey,
  type FederationRefuseCode,
} from '@ensemus/domain/federation';
import type { FederationActivityDeps } from './federation-deps';
import type {
  FederationDeliveryOutcome,
  FederationGrantEndedInput,
  FederationItemInput,
  FederationPurgePass,
} from './schemas';

const inboundPurgeSize = 50;
const proofOf = (bytes: Buffer) => ({
  sha256: createHash('sha256').update(bytes).digest('hex'),
  sizeBytes: bytes.length,
});
function sourceRefusal(error: unknown): FederationRefuseCode | undefined {
  if (error instanceof Error && error.message === 'OBJECT_TOO_LARGE') return 'FILE_TOO_LARGE';
  if (error instanceof Error && error.name === 'NoSuchKey') return 'FILE_MISSING';
  return undefined;
}

export function createFederationActivities({ bridge, followUp, store }: FederationActivityDeps) {
  return {
    async deliverFederationItem(input: FederationItemInput): Promise<FederationDeliveryOutcome> {
      const sender = createServiceContext(input.organizationId);
      const queued = await followUp.loadItemGrant(sender, input.itemId);
      if (!queued) return 'closed';
      const reference = {
        grantId: queued.grantId,
        senderOrganizationId: sender.organizationId,
        itemId: input.itemId,
      };
      const item = await readItemToCross(bridge, reference);
      // This also handles closed grants and delivery retries after a committed crossing.
      if (!item?.fileObjectKey) return crossItem(bridge, reference);

      const target = {
        grantId: reference.grantId,
        itemId: item.itemId,
        receiverOrganizationId: item.receiverOrganizationId,
      };
      const source = outboundObjectKey(sender.organizationId, item.itemId);
      const destination = inboundObjectKey(target.receiverOrganizationId, item.itemId);
      const refuse = async (code: FederationRefuseCode) => {
        await refuseItem(bridge, { ...reference, code });
        return crossItem(bridge, reference);
      };
      if (
        item.fileObjectKey !== source ||
        !item.fileSha256 ||
        !item.fileMimeType ||
        item.fileSizeBytes === null ||
        item.fileSizeBytes < 0
      ) {
        throw new Error('FEDERATION_FILE_METADATA_INVALID');
      }
      if (item.fileSizeBytes > FEDERATION_MAX_FILE_BYTES) return refuse('FILE_TOO_LARGE');
      let marker = await followUp.loadFileCopy(sender, target);
      if (marker === 'closed') return 'closed';
      if (marker === 'unclaimed') {
        let bytes: Buffer;
        try {
          bytes = await store.get(source, FEDERATION_MAX_FILE_BYTES);
        } catch (error) {
          const cause = sourceRefusal(error);
          if (cause) return refuse(cause);
          // eslint-disable-next-line preserve-caught-error -- Provider errors can contain request details.
          throw new Error('FEDERATION_SOURCE_UNAVAILABLE');
        }
        if (bytes.length > FEDERATION_MAX_FILE_BYTES) return refuse('FILE_TOO_LARGE');
        const before = proofOf(bytes);
        if (before.sha256 !== item.fileSha256 || before.sizeBytes !== item.fileSizeBytes)
          return refuse('FILE_HASH_MISMATCH');
        if (
          !store.putSingleAttempt ||
          !store.isPhysicallyAbsent ||
          !store.deleteForPurge ||
          !store.assertPurgeCapability
        )
          throw new Error('FEDERATION_FILE_STORE_CAPABILITY_REQUIRED');
        if (await store.isPhysicallyAbsent(destination)) {
          const claim = await followUp.claimFileCopy(sender, target);
          if (claim === 'closed') return 'closed';
          if (claim === 'admitted') {
            try {
              await store.putSingleAttempt(destination, bytes, item.fileMimeType);
            } catch {
              // The request might have reached storage. After the claim only a read is safe.
            }
          }
        } else {
          // Another worker might have won the claim between this Activity's first lookup and HEAD.
          marker = await followUp.loadFileCopy(sender, target);
          if (marker === 'closed') return 'closed';
          if (marker === 'unclaimed') throw new Error('FEDERATION_COPY_DESTINATION_IN_USE');
        }
      }

      let copied: Buffer;
      try {
        copied = await store.get(destination, FEDERATION_MAX_FILE_BYTES);
      } catch {
        throw new Error('FEDERATION_COPY_UNCONFIRMED');
      }
      const proof = proofOf(copied);
      if (proof.sha256 !== item.fileSha256 || proof.sizeBytes !== item.fileSizeBytes)
        throw new Error('FEDERATION_COPY_UNCONFIRMED');
      await followUp.observeFileCopy(sender, target, proof);
      return crossItem(bridge, { ...reference, verifiedFile: proof });
    },

    async recordFederationItemReceived(input: FederationItemInput): Promise<void> {
      const sender = createServiceContext(input.organizationId);
      const item = await followUp.loadItemGrant(sender, input.itemId);
      if (item?.state !== 'delivered') return;
      const grant = await followUp.loadGrantParties(sender, item.grantId);
      if (!grant) return;
      const receiver =
        grant.sharingOrganizationId === sender.organizationId
          ? grant.receivingOrganizationId
          : grant.sharingOrganizationId;
      if (receiver && receiver !== sender.organizationId)
        await followUp.recordItemReceived(createServiceContext(receiver), input.itemId);
    },

    async purgeFederationGrantPass(input: FederationGrantEndedInput): Promise<FederationPurgePass> {
      const context = createServiceContext(input.organizationId);
      if (!(await followUp.loadGrantParties(context, input.grantId)))
        return { purged: 0, more: false };
      const copies = await purgeInboundCopies(bridge, {
        grantId: input.grantId,
        limit: inboundPurgeSize,
      });
      // This commits logical removal first. The outbound records pin file keys across retries.
      return { purged: copies.length, more: copies.length === inboundPurgeSize };
    },

    async purgeFederationItem(input: FederationItemInput): Promise<FederationPurgePass> {
      const sender = createServiceContext(input.organizationId);
      const item = await followUp.loadItemGrant(sender, input.itemId);
      if (item?.state !== 'withdrawn') return { purged: 0, more: false };
      const reference = {
        grantId: item.grantId,
        senderOrganizationId: sender.organizationId,
        itemId: input.itemId,
      };
      const copies = await purgeInboundCopies(bridge, { ...reference, limit: 1 });
      if (!(await isInboundCopyRemoved(bridge, reference)))
        throw new Error('FEDERATION_INBOUND_COPY_REMAINS');
      await followUp.removeWithdrawnItem(sender, input.itemId);
      return { purged: copies.length, more: false };
    },

    async settleFederationGrantEnd(input: FederationGrantEndedInput): Promise<boolean> {
      const context = createServiceContext(input.organizationId);
      const { grantId } = input;
      const parties = await followUp.loadGrantParties(context, grantId);
      if (!parties?.receivingOrganizationId) return false;
      const sharing = createServiceContext(parties.sharingOrganizationId);
      const receiving = createServiceContext(parties.receivingOrganizationId);
      const sharingHasMore = await followUp.settleGrantEnd(sharing, {
        grantId,
        counterpartyOrganizationId: receiving.organizationId,
      });
      const receivingHasMore = await followUp.settleGrantEnd(receiving, {
        grantId,
        counterpartyOrganizationId: sharing.organizationId,
      });
      return sharingHasMore || receivingHasMore;
    },
  };
}
export type FederationActivities = ReturnType<typeof createFederationActivities>;
