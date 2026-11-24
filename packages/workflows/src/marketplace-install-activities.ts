import { createHash } from 'node:crypto';
import {
  AppError,
  beginInstallation,
  finishInstallation,
  materializeInstallation,
  type SkillFeatureGate,
} from '@ensemus/application';
import { createServiceContext } from '@ensemus/database/service';
import { listingObjectKey } from '@ensemus/domain/marketplace';
import { SKILL_BUNDLE_MAX_BYTES } from '@ensemus/domain/skill';
import { parseSkillBundle } from '@ensemus/skills/bundle';
import { ApplicationFailure } from '@temporalio/common';
import {
  hasMarketplaceBundleSignature,
  hasMarketplaceReview,
  matchesMarketplaceBundle,
} from './marketplace-install-step';
import type {
  MarketplaceInstallFinish,
  MarketplaceInstallInput,
  MarketplaceInstallStep,
} from './schemas';
import type { SkillActivityDeps } from './skill-deps';

export function createMarketplaceInstallActivities({
  database,
  store,
  reviewKeys,
  gate,
}: SkillActivityDeps & { gate: SkillFeatureGate }) {
  async function materialize(input: MarketplaceInstallInput): Promise<MarketplaceInstallStep> {
    const context = createServiceContext(input.organizationId);
    const started = await beginInstallation(database, context, input);
    if (started.step === 'settled') return started;
    if (started.step === 'unavailable' || !(await gate.isEnabled(context, 'marketplace')))
      return { step: 'failed', code: 'LISTING_NOT_AVAILABLE' };
    const { subject, skillVersionId } = started;
    if (!hasMarketplaceReview(subject, reviewKeys))
      return { step: 'failed', code: 'ATTESTATION_INVALID' };
    if (skillVersionId) return { step: 'verify', skillVersionId };
    if (subject.objectKey !== listingObjectKey(subject.digest) || !subject.bundleSha256)
      return { step: 'failed', code: 'BUNDLE_HASH_MISMATCH' };

    const bytes = await store.get(subject.objectKey, SKILL_BUNDLE_MAX_BYTES).catch(() => {
      throw ApplicationFailure.retryable(
        'Marketplace source bundle could not be read',
        'MARKETPLACE_BUNDLE_PENDING',
      );
    });
    if (
      bytes.length !== subject.sizeBytes ||
      createHash('sha256').update(bytes).digest('hex') !== subject.bundleSha256
    )
      return { step: 'failed', code: 'BUNDLE_HASH_MISMATCH' };
    const parsed = parseSkillBundle(bytes);
    if (!parsed.ok || !matchesMarketplaceBundle(parsed.parsed, subject))
      return { step: 'failed', code: 'BUNDLE_HASH_MISMATCH' };
    if (!hasMarketplaceBundleSignature(parsed.parsed, subject))
      return { step: 'failed', code: 'SIGNATURE_INVALID' };
    if (!(await gate.isEnabled(context, 'marketplace')))
      return { step: 'failed', code: 'LISTING_NOT_AVAILABLE' };
    const result = await materializeInstallation(database, store, context, {
      ...input,
      subject,
      bytes,
    });
    return result.ok
      ? { step: 'verify', skillVersionId: result.skillVersionId }
      : { step: 'failed', code: result.code };
  }

  return {
    async materializeListing(input: MarketplaceInstallInput): Promise<MarketplaceInstallStep> {
      try {
        return await materialize(input);
      } catch (error) {
        if (error instanceof ApplicationFailure && error.type === 'MARKETPLACE_BUNDLE_PENDING')
          throw error;
        if (error instanceof AppError && error.code === 'SKILL_UPLOAD_PENDING')
          throw ApplicationFailure.retryable(
            'Marketplace tenant copy is pending',
            'MARKETPLACE_BUNDLE_PENDING',
          );
        throw ApplicationFailure.retryable(
          'Marketplace copy could not advance',
          'MARKETPLACE_INSTALL_RETRY',
        );
      }
    },
    async finishListingInstall(input: MarketplaceInstallFinish) {
      try {
        const context = createServiceContext(input.organizationId);
        const outcome =
          input.outcome.ok && !(await gate.isEnabled(context, 'marketplace'))
            ? ({ ok: false, code: 'LISTING_NOT_AVAILABLE' } as const)
            : input.outcome;
        return await finishInstallation(database, context, { ...input, outcome });
      } catch {
        throw ApplicationFailure.retryable(
          'Marketplace installation could not settle',
          'MARKETPLACE_INSTALL_RETRY',
        );
      }
    },
  };
}
export type MarketplaceInstallActivities = ReturnType<typeof createMarketplaceInstallActivities>;
