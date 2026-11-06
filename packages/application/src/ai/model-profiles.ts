// Owned by the model-profiles slice (MODEL-01, COMM-02). See docs/06-delivery/m4-slices.md and ADR-028 FD-10,
// FD-21, FD-23. Needs `model.manage` or `model.activate`. A key arrives here sealed, as a reference, and
// nothing here can read one back: the role behind this file has no SELECT on sealed secrets.
import { randomUUID } from 'node:crypto';
import {
  createModelProfileSchema,
  createRateCardSchema,
  modelProfileViewSchema,
  updateModelProfileSchema,
  type CreateModelProfile,
  type ModelProfileView,
  type UpdateModelProfile,
} from '@ensemus/contracts/ai';
import {
  actorOf,
  appendAudit,
  modelProfiles,
  rateCards,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import type {
  AiClassification,
  BillingOwner,
  EgressDestination,
  ModelCapability,
  ModelProfileStatus,
  ModelPurpose,
  ProviderKind,
  RateCardSource,
  RetentionBasis,
} from '@ensemus/domain/ai';
import { modelKeyPurpose } from '@ensemus/domain/ai-binding';
import {
  AGGREGATE_MODEL_PROFILE,
  MODEL_PROFILE_DISABLED,
  MODEL_PROFILE_PROBE_REQUESTED,
} from '@ensemus/domain/ai-events';
import { can } from '@ensemus/domain/policy';
import { checkEndpoint, type EndpointSettings } from '@ensemus/policy/endpoint';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, foreignReference, pgCode, type ErrorCode } from '../errors';
import { emit } from '../events';
import { idSchema } from '../ids';
import type { ProfileStore, RateCardRef, RoutableProfile } from './ports';

const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
/** The code migration 0101's profile triggers raise, for a move the state machine does not have. */
const PROFILE_RULE_VIOLATION = 'EN006';

export type ModelProfileRow = typeof modelProfiles.$inferSelect;

/** An operator's list, read by the caller. Without one, no private address is allowed. */
export const NO_PRIVATE_ENDPOINTS: EndpointSettings = { privateEndpoints: [] };

// --- The rules, as pure functions.

const storedLimits = z.object({
  maxInputTokens: z.int().min(1),
  maxOutputTokens: z.int().min(1),
});

/**
 * What can be shown to anyone. The schema is strict, so a column added to the row later cannot reach a
 * response by accident, and `secret_ref` is not a field of it: only whether a key is on file.
 */
export function toModelProfileView(row: ModelProfileRow): ModelProfileView {
  const limits = storedLimits.parse(row.limits);
  return modelProfileViewSchema.parse({
    id: row.id,
    version: row.version,
    provider_kind: row.providerKind,
    model_id: row.modelId,
    alias: row.alias,
    endpoint_url: row.endpointUrl,
    has_credential: row.secretRef !== null,
    billing_owner: row.billingOwner,
    region: row.region,
    capabilities: row.capabilities,
    limits: { max_input_tokens: limits.maxInputTokens, max_output_tokens: limits.maxOutputTokens },
    allowed_classes: row.allowedClasses,
    allowed_purposes: row.allowedPurposes,
    retention_basis: row.retentionBasis,
    contract_ref: row.contractRef,
    fallback_profile_ids: row.fallbackProfileIds,
    status: row.status,
    qualified_at: row.qualifiedAt?.toISOString() ?? null,
  });
}

/** Which column of data-egress-matrix.csv a profile falls under. A local model never leaves the site. */
export function destinationFor(kind: ProviderKind, billingOwner: BillingOwner): EgressDestination {
  if (kind === 'local_openai_compatible') return 'customer_private_inference';
  return billingOwner === 'ensemus' ? 'ensemus_cloud_managed_model' : 'customer_byom_public_api';
}

/** What routing and the probe read. It says where a key is, and a broker is still needed to open it. */
export function toRoutableProfile(row: ModelProfileRow): RoutableProfile {
  const kind = row.providerKind as ProviderKind;
  const billingOwner = row.billingOwner as BillingOwner;
  return {
    id: row.id,
    version: row.version,
    providerKind: kind,
    modelId: row.modelId,
    alias: row.alias,
    endpointUrl: row.endpointUrl,
    secretRef: row.secretRef,
    billingOwner,
    destination: destinationFor(kind, billingOwner),
    region: row.region,
    capabilities: row.capabilities as ModelCapability[],
    limits: storedLimits.parse(row.limits),
    allowedClasses: row.allowedClasses as AiClassification[],
    allowedPurposes: row.allowedPurposes as ModelPurpose[],
    retentionBasis: row.retentionBasis as RetentionBasis,
    contractRef: row.contractRef,
    fallbackProfileIds: row.fallbackProfileIds,
    crossBillingApproved: row.crossBillingApprovedByMembershipId !== null,
    status: row.status as ModelProfileStatus,
  };
}

/**
 * Whether storing a key for this kind needs the operator's review reference (FD-21). Hosted kinds do, by
 * the ADR. So does `openai_compatible`, although `isHostedProviderKind` says no: it reaches a public
 * address, so without this a real key could be stored by pointing that kind at a provider's own API. Only
 * a local model, whose address the operator listed, is free of it.
 */
export const needsReviewInterlock = (kind: ProviderKind) => kind !== 'local_openai_compatible';

/** FD-21. It runs before anything is sealed, and again as the reference is attached. */
export function assertKeyMayBeStored(kind: ProviderKind, reviewInterlock: string | null) {
  if (needsReviewInterlock(kind) && !reviewInterlock?.trim()) {
    throw new AppError('MODEL_CREDENTIALS_NOT_REVIEWED');
  }
}

/**
 * Whatever `checkEndpoint` says, an address that carries a credential or a query is refused. A view shows
 * the address, so a key inside one would be shown to every admin, and the digest in a key's purpose does
 * not cover a query, so two different addresses could share one sealed key.
 */
export function endpointHoldsNoSecrets(endpointUrl: string): boolean {
  try {
    const url = new URL(endpointUrl);
    return !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

/** Refuses an address a tenant may not use. The worker checks again before it sends anything. */
export function assertEndpointAllowed(
  kind: ProviderKind,
  endpointUrl: string,
  settings: EndpointSettings,
) {
  if (!endpointHoldsNoSecrets(endpointUrl) || !checkEndpoint(kind, endpointUrl, settings).ok) {
    throw new AppError('MODEL_ENDPOINT_NOT_ALLOWED');
  }
}

/**
 * Retention is a claim the egress policy relies on, so one that cannot be true is refused here. A hosted
 * provider is not self-hosted, and a contract recorded with no reference to it records nothing.
 */
export function retentionHolds(profile: {
  providerKind: ProviderKind;
  retentionBasis: RetentionBasis;
  contractRef: string | null;
}): boolean {
  if (profile.retentionBasis === 'self_hosted') {
    return profile.providerKind === 'local_openai_compatible';
  }
  if (profile.retentionBasis === 'contract_recorded') return profile.contractRef !== null;
  return true;
}

/**
 * Whether a person can ask for a test now. A probe already running can be asked for again: if its worker
 * was away it ended without writing, and nothing else can move the profile on. A profile that needs a key
 * and has none has nothing to test. The answer is null when it can go ahead.
 */
export function probeRefusal(profile: {
  providerKind: ProviderKind;
  secretRef: string | null;
}): ErrorCode | null {
  return profile.providerKind !== 'local_openai_compatible' && profile.secretRef === null
    ? 'INVALID_STATE'
    : null;
}

const distinct = <T>(values: readonly T[]) => [...new Set(values)];

/** The columns a patch changes, and no others. `provider_kind` is not in the schema or in the grant. */
export function patchColumns(patch: UpdateModelProfile) {
  return {
    ...(patch.model_id !== undefined ? { modelId: patch.model_id } : {}),
    ...(patch.alias !== undefined ? { alias: patch.alias } : {}),
    ...(patch.endpoint_url !== undefined ? { endpointUrl: patch.endpoint_url } : {}),
    ...(patch.billing_owner !== undefined ? { billingOwner: patch.billing_owner } : {}),
    ...(patch.region !== undefined ? { region: patch.region } : {}),
    ...(patch.capabilities !== undefined ? { capabilities: distinct(patch.capabilities) } : {}),
    ...(patch.limits !== undefined
      ? {
          limits: {
            maxInputTokens: patch.limits.max_input_tokens,
            maxOutputTokens: patch.limits.max_output_tokens,
          },
        }
      : {}),
    ...(patch.allowed_classes !== undefined
      ? { allowedClasses: distinct(patch.allowed_classes) }
      : {}),
    ...(patch.allowed_purposes !== undefined
      ? { allowedPurposes: distinct(patch.allowed_purposes) }
      : {}),
    ...(patch.retention_basis !== undefined ? { retentionBasis: patch.retention_basis } : {}),
    ...(patch.contract_ref !== undefined ? { contractRef: patch.contract_ref } : {}),
    ...(patch.fallback_profile_ids !== undefined
      ? { fallbackProfileIds: distinct(patch.fallback_profile_ids) }
      : {}),
  };
}

function parseInput<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  // Field values never go into the error: one of them might be a key pasted into the wrong box.
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  return parsed.data;
}

/** An ID that cannot exist is the same as one that does not. */
function profileIdOf(profileId: string): string {
  const parsed = idSchema.safeParse(profileId);
  if (!parsed.success) throw new AppError('NOT_FOUND');
  return parsed.data;
}

function requireManage(context: TenantContext) {
  if (!can(context.role, 'model.manage')) throw new AppError('FORBIDDEN');
}

function requireActivate(context: TenantContext) {
  if (!can(context.role, 'model.activate')) throw new AppError('FORBIDDEN');
}

/** A profile says which address a key goes to, so reading one is for those who look after them. */
function requireRead(context: TenantContext) {
  if (!can(context.role, 'model.manage') && !can(context.role, 'model.activate')) {
    throw new AppError('FORBIDDEN');
  }
}

// --- Storage.

const profileIs = (context: TenantContext, profileId: string) =>
  and(eq(modelProfiles.organizationId, context.organizationId), eq(modelProfiles.id, profileId));

/** The row, held until the end of the transaction. RLS answers nothing for another tenant's ID. */
async function lockProfile(tx: Tx, context: TenantContext, profileId: string) {
  const [row] = await tx
    .select()
    .from(modelProfiles)
    .where(profileIs(context, profileId))
    .for('update');
  if (!row) throw new AppError('NOT_FOUND');
  return row;
}

async function lockAtVersion(
  tx: Tx,
  context: TenantContext,
  profileId: string,
  expectedVersion: number,
) {
  const row = await lockProfile(tx, context, profileId);
  if (row.version !== expectedVersion) throw new AppError('VERSION_CONFLICT');
  return row;
}

/** A fallback entry has to be another profile of this tenant. The array column has no foreign key. */
async function assertFallbacks(
  tx: Tx,
  context: TenantContext,
  profileId: string,
  fallbackIds: readonly string[],
) {
  const wanted = distinct(fallbackIds);
  if (wanted.length === 0) return;
  if (wanted.includes(profileId)) throw new AppError('INVALID_INPUT');
  const found = await tx
    .select({ id: modelProfiles.id })
    .from(modelProfiles)
    .where(
      and(
        eq(modelProfiles.organizationId, context.organizationId),
        inArray(modelProfiles.id, wanted),
      ),
    );
  if (found.length !== wanted.length) throw foreignReference();
}

const audit = (
  tx: Tx,
  context: TenantContext,
  action: string,
  targetRef: string,
  safeReason?: string,
) =>
  appendAudit(tx, {
    organizationId: context.organizationId,
    ...actorOf(context),
    action,
    targetRef,
    decision: 'allow',
    ...(safeReason ? { safeReason } : {}),
  });

/** Turns what the database refused into what a person can be told. */
function translated(error: unknown): unknown {
  const code = pgCode(error);
  if (code === UNIQUE_VIOLATION) return new AppError('INVALID_INPUT');
  if (code === FOREIGN_KEY_VIOLATION) return foreignReference();
  if (code === PROFILE_RULE_VIOLATION) return new AppError('INVALID_TRANSITION');
  return error;
}

/**
 * Registers a draft. `settings` is the operator's list of private addresses, which the caller reads,
 * because the web tier has its own settings loader. With none, a local kind is refused.
 */
export async function createModelProfile(
  database: AppDatabase,
  context: TenantContext,
  input: CreateModelProfile,
  settings: EndpointSettings = NO_PRIVATE_ENDPOINTS,
): Promise<ModelProfileView> {
  requireManage(context);
  const parsed = parseInput(createModelProfileSchema, input);
  assertEndpointAllowed(parsed.provider_kind, parsed.endpoint_url, settings);
  if (
    !retentionHolds({
      providerKind: parsed.provider_kind,
      retentionBasis: parsed.retention_basis,
      contractRef: parsed.contract_ref,
    })
  ) {
    throw new AppError('INVALID_INPUT');
  }
  const id = randomUUID();
  try {
    return await withTenantTx(database, context, async (tx) => {
      await assertFallbacks(tx, context, id, parsed.fallback_profile_ids);
      const [row] = await tx
        .insert(modelProfiles)
        .values({
          organizationId: context.organizationId,
          id,
          providerKind: parsed.provider_kind,
          modelId: parsed.model_id,
          alias: parsed.alias,
          endpointUrl: parsed.endpoint_url,
          billingOwner: parsed.billing_owner,
          region: parsed.region,
          capabilities: distinct(parsed.capabilities),
          limits: {
            maxInputTokens: parsed.limits.max_input_tokens,
            maxOutputTokens: parsed.limits.max_output_tokens,
          },
          allowedClasses: distinct(parsed.allowed_classes),
          allowedPurposes: distinct(parsed.allowed_purposes),
          retentionBasis: parsed.retention_basis,
          contractRef: parsed.contract_ref,
          fallbackProfileIds: distinct(parsed.fallback_profile_ids),
          createdByMembershipId: context.membershipId,
        })
        .returning();
      await audit(tx, context, 'model_profile.created', `model_profile:${id}`);
      return toModelProfileView(row!);
    });
  } catch (error) {
    throw translated(error);
  }
}

export async function listModelProfiles(
  database: AppDatabase,
  context: TenantContext,
): Promise<readonly ModelProfileView[]> {
  requireRead(context);
  const rows = await withTenantTx(database, context, (tx) =>
    tx
      .select()
      .from(modelProfiles)
      .where(eq(modelProfiles.organizationId, context.organizationId))
      .orderBy(asc(modelProfiles.alias)),
  );
  return rows.map(toModelProfileView);
}

export async function getModelProfile(
  database: AppDatabase,
  context: TenantContext,
  profileId: string,
): Promise<ModelProfileView> {
  requireRead(context);
  const id = profileIdOf(profileId);
  const [row] = await withTenantTx(database, context, (tx) =>
    tx.select().from(modelProfiles).where(profileIs(context, id)),
  );
  if (!row) throw new AppError('NOT_FOUND');
  return toModelProfileView(row);
}

/** An endpoint change voids the key and returns the profile to draft: the trigger does that part. */
export async function updateModelProfile(
  database: AppDatabase,
  context: TenantContext,
  input: { profileId: string; patch: UpdateModelProfile },
  settings: EndpointSettings = NO_PRIVATE_ENDPOINTS,
): Promise<ModelProfileView> {
  requireManage(context);
  const id = profileIdOf(input.profileId);
  const patch = parseInput(updateModelProfileSchema, input.patch);
  try {
    return await withTenantTx(database, context, async (tx) => {
      const row = await lockAtVersion(tx, context, id, patch.expected_version);
      const kind = row.providerKind as ProviderKind;
      const newEndpoint = patch.endpoint_url !== undefined && patch.endpoint_url !== row.endpointUrl;
      if (newEndpoint) assertEndpointAllowed(kind, patch.endpoint_url!, settings);
      if (
        !retentionHolds({
          providerKind: kind,
          retentionBasis: patch.retention_basis ?? (row.retentionBasis as RetentionBasis),
          contractRef: patch.contract_ref !== undefined ? patch.contract_ref : row.contractRef,
        })
      ) {
        throw new AppError('INVALID_INPUT');
      }
      if (patch.fallback_profile_ids !== undefined) {
        await assertFallbacks(tx, context, id, patch.fallback_profile_ids);
      }
      const [updated] = await tx
        .update(modelProfiles)
        .set({ ...patchColumns(patch), updatedAt: new Date() })
        .where(profileIs(context, id))
        .returning();
      await audit(tx, context, 'model_profile.updated', `model_profile:${id}`);
      if (newEndpoint && row.secretRef !== null) {
        await audit(
          tx,
          context,
          'model_profile.key_voided',
          `model_profile:${id}`,
          'ENDPOINT_CHANGED',
        );
      }
      return toModelProfileView(updated!);
    });
  } catch (error) {
    throw translated(error);
  }
}

/**
 * Everything that has to hold before a key is sealed at all, so a refused key leaves no sealed row. It
 * answers the purpose to seal under, which names this profile and its endpoint (FD-10). The caller then
 * uses `storeSecret`, then `attachModelKey`, which checks all of this again under a lock.
 */
export async function prepareModelKeyCapture(
  database: AppDatabase,
  context: TenantContext,
  input: { profileId: string; expectedVersion: number; reviewInterlock: string | null },
): Promise<{ purpose: string }> {
  requireManage(context);
  const id = profileIdOf(input.profileId);
  const [row] = await withTenantTx(database, context, (tx) =>
    tx.select().from(modelProfiles).where(profileIs(context, id)),
  );
  if (!row) throw new AppError('NOT_FOUND');
  if (row.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT');
  assertKeyMayBeStored(row.providerKind as ProviderKind, input.reviewInterlock);
  return { purpose: modelKeyPurpose(row.id, row.endpointUrl) };
}

/**
 * Points the profile at a key the caller already stored with `storeSecret` from @ensemus/secrets/seal,
 * using `modelKeyPurpose(profileId, endpointUrl)` as its purpose. That sends the profile back to draft.
 * Refuses a hosted kind unless the operator's interlock is set (FD-21). The caller passes the setting's
 * value, because the web tier has its own settings loader.
 */
export async function attachModelKey(
  database: AppDatabase,
  context: TenantContext,
  input: {
    profileId: string;
    expectedVersion: number;
    secretRef: string;
    reviewInterlock: string | null;
  },
): Promise<ModelProfileView> {
  requireManage(context);
  const id = profileIdOf(input.profileId);
  const secretRef = parseInput(idSchema, input.secretRef);
  try {
    return await withTenantTx(database, context, async (tx) => {
      const row = await lockAtVersion(tx, context, id, input.expectedVersion);
      assertKeyMayBeStored(row.providerKind as ProviderKind, input.reviewInterlock);
      const [updated] = await tx
        .update(modelProfiles)
        .set({ secretRef, updatedAt: new Date() })
        .where(profileIs(context, id))
        .returning();
      await audit(tx, context, 'model_profile.key_attached', `model_profile:${id}`);
      return toModelProfileView(updated!);
    });
  } catch (error) {
    throw translated(error);
  }
}

/** Moves to `probing` and emits model_profile.probe_requested, in one transaction. */
export async function requestModelProbe(
  database: AppDatabase,
  context: TenantContext,
  input: { profileId: string; expectedVersion: number },
): Promise<void> {
  requireActivate(context);
  const id = profileIdOf(input.profileId);
  try {
    await withTenantTx(database, context, async (tx) => {
      const row = await lockAtVersion(tx, context, id, input.expectedVersion);
      const refusal = probeRefusal({
        providerKind: row.providerKind as ProviderKind,
        secretRef: row.secretRef,
      });
      if (refusal) throw new AppError(refusal);
      await tx
        .update(modelProfiles)
        .set({
          status: 'probing',
          probeRequestedByMembershipId: context.membershipId,
          updatedAt: new Date(),
        })
        .where(profileIs(context, id));
      await emit(tx, context, {
        eventType: MODEL_PROFILE_PROBE_REQUESTED,
        aggregateType: AGGREGATE_MODEL_PROFILE,
        aggregateId: id,
        aggregateVersion: row.version,
        classification: 'internal',
        payload: {},
      });
      await audit(tx, context, 'model_profile.probe_requested', `model_profile:${id}`);
    });
  } catch (error) {
    throw translated(error);
  }
}

/** Stops routing to it now: the router reads the status at every turn. Disabling it twice is once. */
export async function disableModelProfile(
  database: AppDatabase,
  context: TenantContext,
  input: { profileId: string; expectedVersion: number },
): Promise<void> {
  requireManage(context);
  const id = profileIdOf(input.profileId);
  try {
    await withTenantTx(database, context, async (tx) => {
      const row = await lockAtVersion(tx, context, id, input.expectedVersion);
      if (row.status === 'disabled') return;
      await tx
        .update(modelProfiles)
        .set({ status: 'disabled', updatedAt: new Date() })
        .where(profileIs(context, id));
      await emit(tx, context, {
        eventType: MODEL_PROFILE_DISABLED,
        aggregateType: AGGREGATE_MODEL_PROFILE,
        aggregateId: id,
        aggregateVersion: row.version,
        classification: 'internal',
        payload: {},
      });
      await audit(tx, context, 'model_profile.disabled', `model_profile:${id}`);
    });
  } catch (error) {
    throw translated(error);
  }
}

/** A tenant's own estimate. A new price is a new row: the table refuses an update. */
export async function addRateCard(
  database: AppDatabase,
  context: TenantContext,
  input: { profileId: string; inputMicrosPerMtok: number; outputMicrosPerMtok: number },
): Promise<{ rateCardId: string; version: number }> {
  requireManage(context);
  const id = profileIdOf(input.profileId);
  const rates = parseInput(createRateCardSchema, {
    input_micros_per_mtok: input.inputMicrosPerMtok,
    output_micros_per_mtok: input.outputMicrosPerMtok,
  });
  const rateCardId = randomUUID();
  return withTenantTx(database, context, async (tx) => {
    // The profile's lock makes two cards added at once take turns for the next number.
    await lockProfile(tx, context, id);
    const [latest] = await tx
      .select({ version: rateCards.version })
      .from(rateCards)
      .where(and(eq(rateCards.organizationId, context.organizationId), eq(rateCards.profileId, id)))
      .orderBy(desc(rateCards.version))
      .limit(1);
    const version = (latest?.version ?? 0) + 1;
    await tx.insert(rateCards).values({
      organizationId: context.organizationId,
      id: rateCardId,
      profileId: id,
      version,
      inputMicrosPerMtok: rates.input_micros_per_mtok,
      outputMicrosPerMtok: rates.output_micros_per_mtok,
      source: 'tenant_estimate',
      createdByMembershipId: context.membershipId,
    });
    await audit(tx, context, 'model_profile.rate_card_added', `model_profile:${id}`);
    return { rateCardId, version };
  });
}

const rateCardRef = (row: typeof rateCards.$inferSelect): RateCardRef => ({
  id: row.id,
  version: row.version,
  inputMicrosPerMtok: row.inputMicrosPerMtok,
  outputMicrosPerMtok: row.outputMicrosPerMtok,
  source: row.source as RateCardSource,
});

/** The newest applies. For the settings page, which has no agent context to go through the store with. */
export async function latestRateCardFor(
  database: AppDatabase,
  context: TenantContext,
  profileId: string,
): Promise<RateCardRef | null> {
  requireRead(context);
  const id = profileIdOf(profileId);
  return readLatestRateCard(database, context, id);
}

async function readLatestRateCard(
  database: AppDatabase,
  context: TenantContext,
  profileId: string,
): Promise<RateCardRef | null> {
  const [row] = await withTenantTx(database, context, (tx) =>
    tx
      .select()
      .from(rateCards)
      .where(
        and(
          eq(rateCards.organizationId, context.organizationId),
          eq(rateCards.profileId, profileId),
          sql`${rateCards.effectiveFrom} <= now()`,
        ),
      )
      .orderBy(desc(rateCards.version))
      .limit(1),
  );
  return row ? rateCardRef(row) : null;
}

/**
 * The port routing reads through. It takes an agent's context, and RLS confines each read to that
 * tenant. Only an active profile is a candidate. `getProfile` answers for any status, so a pinned run
 * can tell a profile that stopped qualifying from one that never existed.
 */
export function createProfileStore(database: AppDatabase): ProfileStore {
  return {
    async listCandidates(context) {
      const rows = await withTenantTx(database, context, (tx) =>
        tx
          .select()
          .from(modelProfiles)
          .where(
            and(
              eq(modelProfiles.organizationId, context.organizationId),
              eq(modelProfiles.status, 'active'),
            ),
          )
          .orderBy(asc(modelProfiles.alias)),
      );
      return rows.map(toRoutableProfile);
    },
    async getProfile(context, profileId) {
      const parsed = idSchema.safeParse(profileId);
      if (!parsed.success) return null;
      const [row] = await withTenantTx(database, context, (tx) =>
        tx.select().from(modelProfiles).where(profileIs(context, parsed.data)),
      );
      return row ? toRoutableProfile(row) : null;
    },
    async latestRateCard(context, profileId) {
      const parsed = idSchema.safeParse(profileId);
      return parsed.success ? readLatestRateCard(database, context, parsed.data) : null;
    },
  };
}
