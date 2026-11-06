import 'server-only';
import { AppError } from '@ensemus/application';
import {
  attachModelKey,
  prepareModelKeyCapture,
} from '@ensemus/application/ai-model-profiles';
import { loadModelEgressSettings, readSecret } from '@ensemus/config';
import type { ModelProfileView } from '@ensemus/contracts/ai';
import type { AppDatabase, TenantContext } from '@ensemus/database';
import { storeSecret } from '@ensemus/secrets/seal';
import { modelKeySchema } from './model-form';

/**
 * Takes a key once (ADR-028 FD-10, FD-21). Everything is checked before it is sealed, so a refused key
 * leaves nothing behind. It is sealed under a purpose naming this profile and endpoint, and only the
 * reference is kept. The web tier holds a public key alone, so from here on nothing on this side can read
 * it back. A JavaScript string cannot be wiped, so it stays in this process's memory until it is collected
 * (ADR-028 records that). It is never logged and no response carries it.
 *
 * If the profile changes between the two checks, the attach is refused and the sealed row stays, with
 * nothing pointing at it. Its purpose names the old address, so it can never open under the new one.
 */
export async function captureModelKey(
  database: AppDatabase,
  context: TenantContext,
  input: { profileId: string; expectedVersion: number; key: string },
): Promise<ModelProfileView> {
  const reviewInterlock = loadModelEgressSettings().credentialsReviewed;
  const key = modelKeySchema.safeParse(input.key);
  if (!key.success) throw new AppError('INVALID_INPUT');
  const { purpose } = await prepareModelKeyCapture(database, context, {
    profileId: input.profileId,
    expectedVersion: input.expectedVersion,
    reviewInterlock,
  });
  const { secretRef } = await storeSecret(database, context, {
    publicKeyPem: readSecret('SECRET_SEALING_PUBLIC_KEY'),
    purpose,
    plaintext: key.data,
  });
  return attachModelKey(database, context, {
    profileId: input.profileId,
    expectedVersion: input.expectedVersion,
    secretRef,
    reviewInterlock,
  });
}
