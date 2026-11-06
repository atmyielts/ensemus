// Owned by the model-profiles slice (MODEL-01, COMM-02). See docs/06-delivery/m4-slices.md and ADR-028 FD-10,
// FD-21, FD-23. Needs `model.manage` or `model.activate`. A key arrives here sealed, as a reference, and
// nothing here can read one back. Every stub refuses.
import type {
  CreateModelProfile,
  ModelProfileView,
  UpdateModelProfile,
} from '@ensemus/contracts/ai';
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type { ProfileStore } from './ports';

const refuse = () => new Error('NOT_IMPLEMENTED');

export function createModelProfile(
  _database: AppDatabase,
  _context: TenantContext,
  _input: CreateModelProfile,
): Promise<ModelProfileView> {
  throw refuse();
}

export function listModelProfiles(
  _database: AppDatabase,
  _context: TenantContext,
): Promise<readonly ModelProfileView[]> {
  throw refuse();
}

export function getModelProfile(
  _database: AppDatabase,
  _context: TenantContext,
  _profileId: string,
): Promise<ModelProfileView> {
  throw refuse();
}

/** An endpoint change voids the key and returns the profile to draft: the trigger does that part. */
export function updateModelProfile(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { profileId: string; patch: UpdateModelProfile },
): Promise<ModelProfileView> {
  throw refuse();
}

/**
 * Points the profile at a key the caller already stored with `storeSecret` from @ensemus/secrets/seal,
 * using `modelKeyPurpose(profileId, endpointUrl)` as its purpose. That sends the profile back to draft.
 * Refuses a hosted kind unless the operator's interlock is set (FD-21). The caller passes the setting's
 * value, because the web tier has its own settings loader.
 */
export function attachModelKey(
  _database: AppDatabase,
  _context: TenantContext,
  _input: {
    profileId: string;
    expectedVersion: number;
    secretRef: string;
    reviewInterlock: string | null;
  },
): Promise<ModelProfileView> {
  throw refuse();
}

/** Moves to `probing` and emits model_profile.probe_requested, in one transaction. */
export function requestModelProbe(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { profileId: string; expectedVersion: number },
): Promise<void> {
  throw refuse();
}

export function disableModelProfile(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { profileId: string; expectedVersion: number },
): Promise<void> {
  throw refuse();
}

export function addRateCard(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { profileId: string; inputMicrosPerMtok: number; outputMicrosPerMtok: number },
): Promise<{ rateCardId: string; version: number }> {
  throw refuse();
}

/** The port routing reads through. */
export function createProfileStore(_database: AppDatabase): ProfileStore {
  throw refuse();
}
