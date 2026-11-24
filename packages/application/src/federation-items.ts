// Owned by the items slice (EXP-07). See docs/06-delivery/m11c-slices.md and ADR-035 D3 and D4. What is sent,
// from a tenant's own rows, and what arrived, as that tenant sees it. Nothing here crosses anything: the
// bridge worker carries a queued item later. Sending takes federation.share, and reading takes federation.view.
import { createHash, randomUUID } from 'node:crypto';
import {
  federationDispositionSchema,
  publishItemSchema,
  type PublishItemBody,
} from '@ensemus/contracts/federation';
import { canonicalJson } from '@ensemus/domain/approval';
import {
  artifacts,
  domainEvents,
  federationCrossings,
  federationGrants,
  federationInboundItems,
  federationOutboundItems,
  memberships,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import {
  AGGREGATE_FEDERATION_ITEM,
  AUDIT_FEDERATION_FILE_READ,
  AUDIT_FEDERATION_ITEM_RECEIVED,
  AUDIT_FEDERATION_ITEM_SENT,
  AUDIT_FEDERATION_ITEM_WITHDRAWN,
  FEDERATION_ITEM_DISPOSED,
  FEDERATION_ITEM_PUBLISHED,
  FEDERATION_ITEM_WITHDRAWN,
  FEDERATION_ITEM_RECEIVED,
  federationItemTargetRef,
  NOTIFY_FEDERATION_ITEM_RECEIVED,
} from '@ensemus/domain/federation-events';
import { and, asc, desc, eq, inArray, lte, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { AppError } from './errors';
import { emit } from './events';
import { idSchema } from './ids';
import { auditAction, loadReadable, notify } from './work';
import { federationAvailableIn, requireFederationCapability } from './federation';
import { requestHash, runIdempotent } from './idempotency';
import {
  classificationAllowed,
  directionOf,
  FEDERATION_CLASSIFICATIONS,
  FEDERATION_MAX_BODY_BYTES,
  FEDERATION_MAX_FILE_BYTES,
  inboundObjectKey,
  itemContentHash,
  kindAllowed,
  organizationFingerprint,
  outboundObjectKey,
  type FederationClassification,
  type FederationCrossingOutcome,
  type FederationDisposition,
  type FederationItemKind,
  type FederationItemState,
  type FederationPurpose,
} from '@ensemus/domain/federation';
import { objectKey, type ObjectStore } from './artifacts';
import { lockFederationFileSource } from './federation-source-files';

export type OutboundItemView = {
  id: string;
  grantId: string;
  kind: FederationItemKind;
  title: string;
  body: unknown;
  classification: string;
  state: FederationItemState;
  refuseCode: string | null;
  hasFile: boolean;
  sourceType: string | null;
  sourceId: string | null;
  createdAt: Date;
  deliveredAt: Date | null;
  withdrawnAt: Date | null;
  version: number;
};

export type InboundItemView = {
  id: string;
  grantId: string;
  kind: FederationItemKind;
  title: string;
  body: unknown;
  classification: string;
  senderName: string;
  senderFingerprint: string;
  hasFile: boolean;
  fileSizeBytes: number | null;
  fileMimeType: string | null;
  disposition: FederationDisposition;
  linkedWorkUnitId: string | null;
  receivedAt: Date;
  version: number;
};

export type CrossingView = {
  id: string;
  grantId: string;
  itemId: string | null;
  direction: 'sent' | 'received';
  kind: FederationItemKind | null;
  outcome: FederationCrossingOutcome;
  code: string | null;
  contentSha256: string | null;
  crossedAt: Date;
};

type OutboundRow = typeof federationOutboundItems.$inferSelect;
type InboundRow = typeof federationInboundItems.$inferSelect;
type GrantSender = Pick<
  typeof federationGrants.$inferSelect,
  'sharingOrganizationId' | 'sharingDisplayName' | 'receivingDisplayName'
>;

function outboundView(row: OutboundRow): OutboundItemView {
  return {
    id: row.id,
    grantId: row.grantId,
    kind: row.kind as FederationItemKind,
    title: row.title,
    body: row.body,
    classification: row.classification,
    state: row.state as FederationItemState,
    refuseCode: row.refuseCode,
    hasFile: row.fileObjectKey !== null,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    createdAt: row.createdAt,
    deliveredAt: row.deliveredAt,
    withdrawnAt: row.withdrawnAt,
    version: row.version,
  };
}

function inboundView(row: InboundRow, grant: GrantSender): InboundItemView {
  const fromSharing = row.senderOrganizationId === grant.sharingOrganizationId;
  const senderName = fromSharing ? grant.sharingDisplayName : grant.receivingDisplayName;
  return {
    id: row.id,
    grantId: row.grantId,
    kind: row.kind as FederationItemKind,
    title: row.title,
    body: row.body,
    classification: row.classification,
    senderName: senderName ?? 'Organization',
    senderFingerprint: organizationFingerprint(row.senderOrganizationId),
    hasFile: row.fileObjectKey !== null,
    fileSizeBytes: row.fileSizeBytes,
    fileMimeType: row.fileMimeType,
    disposition: row.disposition as FederationDisposition,
    linkedWorkUnitId: row.linkedWorkUnitId,
    receivedAt: row.receivedAt,
    version: row.version,
  };
}

function itemId(value: string) {
  const result = idSchema.safeParse(value);
  if (!result.success) throw new AppError('INVALID_INPUT');
  return result.data;
}

function checkVersion(version: number) {
  if (!Number.isSafeInteger(version) || version < 1) throw new AppError('INVALID_INPUT');
}

async function authorizeItems(
  tx: Tx,
  context: TenantContext,
  capability: 'federation.view' | 'federation.share',
) {
  await requireFederationCapability(tx, context, capability);
  if (!(await federationAvailableIn(tx))) throw new AppError('NOT_FOUND');
}

function outboundScope(context: TenantContext, id: string) {
  return and(
    eq(federationOutboundItems.organizationId, context.organizationId),
    eq(federationOutboundItems.id, id),
  );
}

async function selectGrant(tx: Tx, context: TenantContext, grantId: string) {
  const [grant] = await tx
    .select({
      row: {
        sharingOrganizationId: federationGrants.sharingOrganizationId,
        receivingOrganizationId: federationGrants.receivingOrganizationId,
        purpose: federationGrants.purpose,
        maxClassification: federationGrants.maxClassification,
      },
      open: sql<boolean>`federation.grant_is_open(${federationGrants.id})
      and ${federationGrants.expiresAt} > clock_timestamp()`,
    })
    .from(federationGrants)
    .where(
      and(
        eq(federationGrants.id, grantId),
        or(
          eq(federationGrants.sharingOrganizationId, context.organizationId),
          eq(federationGrants.receivingOrganizationId, context.organizationId),
        ),
      ),
    );
  if (!grant) throw new AppError('NOT_FOUND');
  return grant;
}

async function lockGrant(tx: Tx, grantId: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock_shared(federation.grant_lock_key(${grantId}::uuid))`,
  );
}

/** Publishes a contract-shaped snapshot. The receipt retains only its reference. */
export async function publishItem(
  database: AppDatabase,
  _store: ObjectStore,
  context: TenantContext,
  input: { grantId: string; item: PublishItemBody; requestKey: string },
): Promise<OutboundItemView> {
  const grantId = itemId(input.grantId);
  const parsed = publishItemSchema.safeParse(input.item);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  const item = parsed.data;
  let created: OutboundItemView | undefined;
  const outcome = await runIdempotent(
    database,
    context,
    {
      key: input.requestKey,
      requestHash: requestHash(['federation.publish', grantId, canonicalJson(item)]),
    },
    (db) =>
      withTenantTx(db, context, async (tx) => {
        await authorizeItems(tx, context, 'federation.share');
        // Discover only our grant before locking. Load the work before the grant lock so source
        // deletion can finish and publishing then sees the authoritative Work Unit.
        await selectGrant(tx, context, grantId);
        const work =
          item.kind === 'work_summary'
            ? await loadReadable(tx, context, itemId(item.work_unit_id), true)
            : null;
        const file =
          item.kind === 'artifact'
            ? await sourceArtifact(tx, context, itemId(item.artifact_id))
            : null;
        await lockGrant(tx, grantId);
        const grant = await selectGrant(tx, context, grantId);
        if (!grant.open) throw new AppError('FEDERATION_GRANT_NOT_OPEN');
        const direction = directionOf(grant.row, context.organizationId);
        if (
          !direction ||
          !kindAllowed(grant.row.purpose as FederationPurpose, direction, item.kind)
        )
          throw new AppError('FEDERATION_KIND_NOT_ALLOWED');
        const classification =
          file?.classification ??
          work?.classification ??
          (item.kind === 'status_update' ? item.classification : '');
        if (
          !classificationAllowed(
            grant.row.maxClassification as FederationClassification,
            classification,
          )
        )
          throw new AppError('FEDERATION_CLASSIFICATION_TOO_HIGH');
        const body = item.kind === 'artifact' ? {} : item.body;
        if (
          item.title.includes('\0') ||
          Object.values(body).some((value) => typeof value === 'string' && value.includes('\0'))
        )
          throw new AppError('INVALID_INPUT');
        const size = await tx.execute<{ size: number }>(
          sql`select pg_column_size(${JSON.stringify(body)}::jsonb) as size`,
        );
        if ((size.rows[0]?.size ?? Infinity) > FEDERATION_MAX_BODY_BYTES)
          throw new AppError('INVALID_INPUT');

        const id = randomUUID();
        const [row] = await tx
          .insert(federationOutboundItems)
          .values({
            organizationId: context.organizationId,
            grantId,
            kind: item.kind,
            id,
            title: item.title,
            body,
            classification,
            sourceType: file ? 'artifact' : work ? 'work_unit' : null,
            sourceId: file?.id ?? work?.id ?? null,
            contentSha256: itemContentHash({
              ...item,
              body,
              classification,
              fileSha256: file?.sha256 ?? null,
            }),
            ...(file
              ? {
                  fileObjectKey: outboundObjectKey(context.organizationId, id),
                  fileSha256: file.sha256,
                  fileSizeBytes: file.sizeBytes,
                  fileMimeType: file.mimeType,
                  sourceUploadState: 'pending' as const,
                }
              : {}),
            createdByMembershipId: context.membershipId,
          })
          .returning();
        if (!row) throw new Error('Federation item insert returned no row');
        await recordItemChange(tx, context, row, FEDERATION_ITEM_PUBLISHED);
        await auditAction(tx, context, AUDIT_FEDERATION_ITEM_SENT, federationItemTargetRef(row.id));
        created = outboundView(row);
        return created;
      }),
    (row) => ({ status: 201, body: { id: row.id } }),
  );
  if (outcome.kind === 'conflict') throw new AppError('IDEMPOTENCY_KEY_REUSED');
  if (created && outcome.kind === 'fresh') return created;
  const receipt = z.strictObject({ id: idSchema }).parse(outcome.body);
  return withTenantTx(database, context, async (tx) => {
    await authorizeItems(tx, context, 'federation.share');
    const [row] = await tx
      .select()
      .from(federationOutboundItems)
      .where(and(outboundScope(context, receipt.id), eq(federationOutboundItems.grantId, grantId)));
    if (!row) throw new AppError('NOT_FOUND');
    return outboundView(row);
  });
}

async function sourceArtifact(tx: Tx, context: TenantContext, id: string) {
  await lockFederationFileSource(tx, context.organizationId, id);
  // The ordinary artifact RLS checks the requesting member, work link, provenance and tombstones.
  const [file] = await tx
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.organizationId, context.organizationId), eq(artifacts.id, id)));
  if (!file || file.objectKey !== objectKey(context.organizationId, id))
    throw new AppError('NOT_FOUND');
  if (file.sizeBytes > FEDERATION_MAX_FILE_BYTES) throw new AppError('FILE_TOO_LARGE');
  return file;
}

/** Lists recent visible files that this grant accepts without exposing object keys or hashes. */
export function listFederationSourceFiles(
  database: AppDatabase,
  context: TenantContext,
  grantId: string,
) {
  return withTenantTx(database, context, async (tx) => {
    await authorizeItems(tx, context, 'federation.share');
    const grant = await selectGrant(tx, context, itemId(grantId));
    const direction = directionOf(grant.row, context.organizationId);
    if (
      !grant.open ||
      !direction ||
      !kindAllowed(grant.row.purpose as FederationPurpose, direction, 'artifact')
    )
      return [];
    const classes = FEDERATION_CLASSIFICATIONS.filter((classification) =>
      classificationAllowed(
        grant.row.maxClassification as FederationClassification,
        classification,
      ),
    );
    return tx
      .select({ id: artifacts.id, name: artifacts.name, classification: artifacts.classification })
      .from(artifacts)
      .where(
        and(
          eq(artifacts.organizationId, context.organizationId),
          inArray(artifacts.classification, classes),
          lte(artifacts.sizeBytes, FEDERATION_MAX_FILE_BYTES),
        ),
      )
      .orderBy(desc(artifacts.createdAt), desc(artifacts.id))
      .limit(50);
  });
}

type ItemEvent =
  | typeof FEDERATION_ITEM_PUBLISHED
  | typeof FEDERATION_ITEM_WITHDRAWN
  | typeof FEDERATION_ITEM_DISPOSED;
function recordItemChange(
  tx: Tx,
  context: TenantContext,
  row: OutboundRow | InboundRow,
  eventType: ItemEvent,
) {
  return emit(tx, context, {
    eventType,
    aggregateType: AGGREGATE_FEDERATION_ITEM,
    aggregateId: row.id,
    aggregateVersion: row.version,
    classification: row.classification,
    payload: {},
  });
}

async function withdrawInTx(tx: Tx, context: TenantContext, row: OutboundRow) {
  const [withdrawn] = await tx
    .update(federationOutboundItems)
    .set({ state: 'withdrawn', withdrawnAt: new Date(), version: row.version + 1 })
    .where(outboundScope(context, row.id))
    .returning();
  if (!withdrawn) throw new AppError('NOT_FOUND');
  await recordItemChange(tx, context, withdrawn, FEDERATION_ITEM_WITHDRAWN);
  await auditAction(tx, context, AUDIT_FEDERATION_ITEM_WITHDRAWN, federationItemTargetRef(row.id));
  return withdrawn;
}

export function withdrawItem(
  database: AppDatabase,
  context: TenantContext,
  input: { itemId: string; expectedVersion: number },
): Promise<OutboundItemView> {
  const id = itemId(input.itemId);
  checkVersion(input.expectedVersion);
  return withTenantTx(database, context, async (tx) => {
    await authorizeItems(tx, context, 'federation.share');
    const [row] = await tx
      .select()
      .from(federationOutboundItems)
      .where(outboundScope(context, id))
      .for('no key update');
    if (!row) throw new AppError('NOT_FOUND');
    if (row.state === 'withdrawn' && row.version === input.expectedVersion + 1)
      return outboundView(row);
    if (row.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT');
    if (row.state !== 'queued' && row.state !== 'delivered')
      throw new AppError('FEDERATION_ITEM_NOT_WITHDRAWABLE');
    return outboundView(await withdrawInTx(tx, context, row));
  });
}

/** Called inside the source's existing tombstone transaction. */
export async function withdrawItemsForSourceInTx(
  tx: Tx,
  context: TenantContext,
  source: { sourceType: 'work_unit' | 'artifact'; sourceId: string },
): Promise<number> {
  const rows = await tx
    .select()
    .from(federationOutboundItems)
    .where(
      and(
        eq(federationOutboundItems.organizationId, context.organizationId),
        eq(federationOutboundItems.sourceType, source.sourceType),
        eq(federationOutboundItems.sourceId, itemId(source.sourceId)),
        inArray(federationOutboundItems.state, ['queued', 'delivered', 'refused']),
      ),
    )
    .orderBy(asc(federationOutboundItems.id))
    .for('no key update');
  for (const row of rows) {
    if (row.state !== 'refused') {
      await withdrawInTx(tx, context, row);
      continue;
    }
    // Refused is terminal. Source removal still owes cleanup of its metadata and any sender bytes.
    const [alreadyQueued] = await tx
      .select({ id: domainEvents.id })
      .from(domainEvents)
      .where(
        and(
          eq(domainEvents.organizationId, context.organizationId),
          eq(domainEvents.aggregateType, AGGREGATE_FEDERATION_ITEM),
          eq(domainEvents.aggregateId, row.id),
          eq(domainEvents.eventType, FEDERATION_ITEM_WITHDRAWN),
        ),
      )
      .limit(1);
    if (!alreadyQueued) await recordItemChange(tx, context, row, FEDERATION_ITEM_WITHDRAWN);
  }
  return rows.length;
}

export function listOutboundItems(
  database: AppDatabase,
  context: TenantContext,
  input: { grantId: string },
): Promise<readonly OutboundItemView[]> {
  const grantId = itemId(input.grantId);
  return withTenantTx(database, context, async (tx) => {
    await authorizeItems(tx, context, 'federation.view');
    await selectGrant(tx, context, grantId);
    const rows = await tx
      .select()
      .from(federationOutboundItems)
      .where(
        and(
          eq(federationOutboundItems.organizationId, context.organizationId),
          eq(federationOutboundItems.grantId, grantId),
        ),
      )
      .orderBy(desc(federationOutboundItems.createdAt), desc(federationOutboundItems.id));
    return rows.map(outboundView);
  });
}

function inboundQuery(tx: Tx, context: TenantContext, filter?: SQL) {
  return tx
    .select({
      item: federationInboundItems,
      grant: {
        sharingOrganizationId: federationGrants.sharingOrganizationId,
        sharingDisplayName: federationGrants.sharingDisplayName,
        receivingDisplayName: federationGrants.receivingDisplayName,
      },
    })
    .from(federationInboundItems)
    .innerJoin(federationGrants, eq(federationGrants.id, federationInboundItems.grantId))
    .where(
      and(
        eq(federationInboundItems.organizationId, context.organizationId),
        sql`${federationGrants.expiresAt} > clock_timestamp()`,
        filter,
      ),
    );
}

async function selectInbound(tx: Tx, context: TenantContext, id: string) {
  const [row] = await inboundQuery(tx, context, eq(federationInboundItems.id, id));
  if (!row) throw new AppError('NOT_FOUND');
  return row;
}

/** Grant and tenant visibility are also enforced by the inbound table's RLS. */
export function listInboundItems(
  database: AppDatabase,
  context: TenantContext,
  input: { disposition?: FederationDisposition; grantId?: string },
): Promise<readonly InboundItemView[]> {
  return withTenantTx(database, context, async (tx) => {
    await authorizeItems(tx, context, 'federation.view');
    const disposition =
      input.disposition === undefined
        ? undefined
        : federationDispositionSchema.safeParse(input.disposition);
    if (disposition && !disposition.success) throw new AppError('INVALID_INPUT');
    const grantId = input.grantId === undefined ? undefined : itemId(input.grantId);
    const rows = await inboundQuery(
      tx,
      context,
      and(
        disposition ? eq(federationInboundItems.disposition, disposition.data) : undefined,
        grantId ? eq(federationInboundItems.grantId, grantId) : undefined,
      ),
    ).orderBy(desc(federationInboundItems.receivedAt), desc(federationInboundItems.id));
    return rows.map(({ item, grant }) => inboundView(item, grant));
  });
}

export function getInboundItem(
  database: AppDatabase,
  context: TenantContext,
  id: string,
): Promise<InboundItemView> {
  return withTenantTx(database, context, async (tx) => {
    await authorizeItems(tx, context, 'federation.view');
    const { item, grant } = await selectInbound(tx, context, itemId(id));
    return inboundView(item, grant);
  });
}

/** Both the received bytes and the current grant are checked before a download is released. */
export async function readInboundFile(
  database: AppDatabase,
  store: ObjectStore,
  context: TenantContext,
  rawId: string,
): Promise<{ body: Buffer; mimeType: string; title: string }> {
  const id = itemId(rawId);
  const { item } = await withTenantTx(database, context, async (tx) => {
    await authorizeItems(tx, context, 'federation.view');
    return selectInbound(tx, context, id);
  });
  const key = inboundObjectKey(context.organizationId, id);
  if (
    item.fileObjectKey !== key ||
    !item.fileSha256 ||
    !item.fileMimeType ||
    item.fileSizeBytes === null ||
    item.fileSizeBytes < 0 ||
    item.fileSizeBytes > FEDERATION_MAX_FILE_BYTES
  )
    throw new AppError('NOT_FOUND');
  let body: Buffer;
  try {
    body = await store.get(key, FEDERATION_MAX_FILE_BYTES);
  } catch {
    throw new AppError('NOT_FOUND');
  }
  if (
    body.length !== item.fileSizeBytes ||
    createHash('sha256').update(body).digest('hex') !== item.fileSha256
  )
    throw new AppError('NOT_FOUND');

  await withTenantTx(database, context, async (tx) => {
    await authorizeItems(tx, context, 'federation.view');
    await lockGrant(tx, item.grantId);
    const { item: current } = await selectInbound(tx, context, id);
    if (
      current.grantId !== item.grantId ||
      current.fileObjectKey !== key ||
      current.fileSha256 !== item.fileSha256 ||
      current.contentSha256 !== item.contentSha256
    )
      throw new AppError('NOT_FOUND');
    await auditAction(tx, context, AUDIT_FEDERATION_FILE_READ, federationItemTargetRef(id));
  });
  return { body, mimeType: item.fileMimeType, title: item.title };
}

export function disposeInboundItem(
  database: AppDatabase,
  context: TenantContext,
  input: {
    itemId: string;
    disposition: 'accepted' | 'rejected';
    linkedWorkUnitId: string | null;
    expectedVersion: number;
  },
): Promise<InboundItemView> {
  const id = itemId(input.itemId);
  const linked = input.linkedWorkUnitId === null ? null : itemId(input.linkedWorkUnitId);
  checkVersion(input.expectedVersion);
  if (
    !['accepted', 'rejected'].includes(input.disposition) ||
    (input.disposition === 'rejected' && linked)
  )
    throw new AppError('INVALID_INPUT');
  return withTenantTx(database, context, async (tx) => {
    await authorizeItems(tx, context, 'federation.share');
    const first = await selectInbound(tx, context, id);
    await lockGrant(tx, first.item.grantId);
    const { item, grant } = await selectInbound(tx, context, id);
    if (item.grantId !== first.item.grantId) throw new AppError('NOT_FOUND');
    if (item.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT');
    if (
      item.disposition !== 'pending' &&
      !(
        item.disposition === 'accepted' &&
        input.disposition === 'accepted' &&
        item.linkedWorkUnitId === null &&
        linked
      )
    )
      throw new AppError('INVALID_STATE');
    if (linked) {
      const work = await loadReadable(tx, context, linked, true);
      if (work.createdByMembershipId !== context.membershipId) throw new AppError('NOT_FOUND');
    }
    const [updated] = await tx
      .update(federationInboundItems)
      .set({
        disposition: input.disposition,
        linkedWorkUnitId: linked,
        disposedByMembershipId: context.membershipId,
        disposedAt: new Date(),
        version: item.version + 1,
      })
      .where(
        and(
          eq(federationInboundItems.organizationId, context.organizationId),
          eq(federationInboundItems.id, id),
          eq(federationInboundItems.version, item.version),
        ),
      )
      .returning();
    if (!updated) {
      await selectInbound(tx, context, id);
      throw new AppError('VERSION_CONFLICT');
    }
    await recordItemChange(tx, context, updated, FEDERATION_ITEM_DISPOSED);
    await auditAction(tx, context, FEDERATION_ITEM_DISPOSED, federationItemTargetRef(id));
    return inboundView(updated, grant);
  });
}

function crossingCursor(raw: string) {
  if (raw.length > 160 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new AppError('INVALID_INPUT');
  try {
    return z
      .tuple([z.iso.datetime(), idSchema])
      .parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
  } catch {
    throw new AppError('INVALID_INPUT');
  }
}

/** A receipt log with opaque keyset pagination at the database's timestamp precision. */
export function listCrossings(
  database: AppDatabase,
  context: TenantContext,
  input: { grantId?: string; cursor?: string; limit: number },
): Promise<{ items: readonly CrossingView[]; nextCursor: string | null }> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)
    throw new AppError('INVALID_INPUT');
  const grantId = input.grantId === undefined ? undefined : itemId(input.grantId);
  const cursor = input.cursor === undefined ? null : crossingCursor(input.cursor);
  return withTenantTx(database, context, async (tx) => {
    await authorizeItems(tx, context, 'federation.view');
    if (grantId) await selectGrant(tx, context, grantId);
    const c = federationCrossings;
    const rows = await tx
      .select({
        crossing: c,
        at: sql<string>`to_char(${c.crossedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(c)
      .where(
        and(
          or(
            eq(c.senderOrganizationId, context.organizationId),
            eq(c.receiverOrganizationId, context.organizationId),
          ),
          grantId ? eq(c.grantId, grantId) : undefined,
          cursor
            ? sql`(${c.crossedAt}, ${c.id}) < (${cursor[0]}::timestamptz, ${cursor[1]}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(c.crossedAt), desc(c.id))
      .limit(input.limit + 1);
    const last = rows[input.limit - 1];
    const items = rows.slice(0, input.limit).map(({ crossing }): CrossingView => ({
      id: crossing.id,
      grantId: crossing.grantId,
      itemId: crossing.itemId,
      direction: crossing.senderOrganizationId === context.organizationId ? 'sent' : 'received',
      kind: crossing.kind as FederationItemKind | null,
      outcome: crossing.outcome as FederationCrossingOutcome,
      code: crossing.code,
      contentSha256: crossing.contentSha256,
      crossedAt: crossing.crossedAt,
    }));
    return {
      items,
      nextCursor:
        rows.length > input.limit && last
          ? Buffer.from(JSON.stringify([last.at, last.crossing.id])).toString('base64url')
          : null,
    };
  });
}

export { removeWithdrawnItem, settleGrantEndForTenant } from './federation-file-lifecycle';

function workerReferenceId(context: TenantContext, id: string): string {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  return parsed.data;
}

/** The receiving tenant records a reference to the still-readable item once. */
export async function recordItemReceived(
  database: AppDatabase,
  context: TenantContext,
  input: { itemId: string },
): Promise<void> {
  const itemId = workerReferenceId(context, input.itemId);
  await withTenantTx(database, context, async (tx) => {
    const itemScope = and(
      eq(federationInboundItems.organizationId, context.organizationId),
      eq(federationInboundItems.id, itemId),
    );
    const [arrived] = await tx
      .select({ grantId: federationInboundItems.grantId })
      .from(federationInboundItems)
      .where(itemScope);
    if (!arrived) return;

    // Recheck visibility after the lock used by revocation, then serialize notice retries on the item.
    await tx.execute(
      sql`select pg_advisory_xact_lock_shared(federation.grant_lock_key(${arrived.grantId}::uuid))`,
    );
    const [item] = await tx
      .select({
        id: federationInboundItems.id,
        classification: federationInboundItems.classification,
      })
      .from(federationInboundItems)
      .where(and(itemScope, eq(federationInboundItems.grantId, arrived.grantId)))
      .for('no key update');
    if (!item) return;

    const [recorded] = await tx
      .select({ id: domainEvents.id })
      .from(domainEvents)
      .where(
        and(
          eq(domainEvents.organizationId, context.organizationId),
          eq(domainEvents.aggregateType, AGGREGATE_FEDERATION_ITEM),
          eq(domainEvents.aggregateId, item.id),
          eq(domainEvents.eventType, FEDERATION_ITEM_RECEIVED),
        ),
      )
      .limit(1);
    if (recorded) return;

    const targetRef = federationItemTargetRef(item.id);
    const recipients = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.status, 'active'),
          inArray(memberships.role, ['owner', 'admin']),
        ),
      );
    await emit(tx, context, {
      eventType: FEDERATION_ITEM_RECEIVED,
      aggregateType: AGGREGATE_FEDERATION_ITEM,
      aggregateId: item.id,
      aggregateVersion: 1,
      classification: item.classification,
      payload: {},
    });
    await notify(
      tx,
      context,
      recipients.map(({ id }) => id),
      NOTIFY_FEDERATION_ITEM_RECEIVED,
      targetRef,
    );
    await auditAction(tx, context, AUDIT_FEDERATION_ITEM_RECEIVED, targetRef);
  });
}

/** The worker resolves the parties only while bound to one of them. */
export async function loadGrantPartiesForWorker(
  database: AppDatabase,
  context: TenantContext,
  grantId: string,
): Promise<{ sharingOrganizationId: string; receivingOrganizationId: string | null } | null> {
  const id = workerReferenceId(context, grantId);
  return withTenantTx(database, context, async (tx) => {
    const [grant] = await tx
      .select({
        sharingOrganizationId: federationGrants.sharingOrganizationId,
        receivingOrganizationId: federationGrants.receivingOrganizationId,
      })
      .from(federationGrants)
      .where(
        and(
          eq(federationGrants.id, id),
          or(
            eq(federationGrants.sharingOrganizationId, context.organizationId),
            eq(federationGrants.receivingOrganizationId, context.organizationId),
          ),
        ),
      );
    return grant ?? null;
  });
}

export async function loadItemGrantForWorker(
  database: AppDatabase,
  context: TenantContext,
  itemId: string,
): Promise<{ grantId: string; state: FederationItemState } | null> {
  const id = workerReferenceId(context, itemId);
  return withTenantTx(database, context, async (tx) => {
    const [item] = await tx
      .select({
        grantId: federationOutboundItems.grantId,
        state: federationOutboundItems.state,
      })
      .from(federationOutboundItems)
      .where(
        and(
          eq(federationOutboundItems.organizationId, context.organizationId),
          eq(federationOutboundItems.id, id),
        ),
      );
    return item ? { grantId: item.grantId, state: item.state as FederationItemState } : null;
  });
}
