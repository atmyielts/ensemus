import { createHash } from 'node:crypto';
import {
  beginSkillVerification,
  markSkillVersionVerified,
  recordSkillTestRun,
  rejectSkillVersion,
  skillVerificationOutcome,
} from '@ensemus/application';
import { createServiceContext } from '@ensemus/database/service';
import {
  SKILL_BUNDLE_MAX_BYTES,
  skillBundleObjectKey,
  type SkillRejectCode,
} from '@ensemus/domain/skill';
import { parseSkillBundle, runContractTests } from '@ensemus/skills/bundle';
import { checkTenantSignature } from '@ensemus/skills/signature';
import { checkManifestSupplyChain, policyForManifest } from '@ensemus/skills/supply-chain';
import { ApplicationFailure } from '@temporalio/common';
import type { SkillCheckStep, SkillVerificationInput, SkillVerificationOutcome } from './schemas';
import type { SkillActivityDeps } from './skill-deps';

export function createSkillVerificationActivities({
  database,
  store,
  ceilings,
}: SkillActivityDeps) {
  async function settleRejection(
    input: SkillVerificationInput,
    code: SkillRejectCode,
  ): Promise<SkillVerificationOutcome> {
    const context = createServiceContext(input.organizationId);
    await rejectSkillVersion(database, context, { skillVersionId: input.skillVersionId, code });
    return skillVerificationOutcome(database, context, input.skillVersionId);
  }

  async function abandonSkillVerification(
    input: SkillVerificationInput,
    code: SkillRejectCode,
  ): Promise<SkillVerificationOutcome> {
    try {
      return await settleRejection(input, code);
    } catch {
      throw ApplicationFailure.retryable(
        'Skill verification could not settle',
        'SKILL_VERIFICATION_RETRY',
      );
    }
  }

  async function check(input: SkillVerificationInput): Promise<SkillCheckStep> {
    const { organizationId, skillVersionId } = input;
    const context = createServiceContext(organizationId);
    const reject = async (code: SkillRejectCode): Promise<SkillCheckStep> => ({
      step: 'finished',
      outcome: await settleRejection(input, code),
    });
    const subject = await beginSkillVerification(database, context, input);
    if (!subject)
      return {
        step: 'finished',
        outcome: await skillVerificationOutcome(database, context, skillVersionId),
      };
    if (subject.origin !== 'tenant') return reject('LISTING_NOT_AVAILABLE');
    const key = skillBundleObjectKey(organizationId, skillVersionId);
    if (subject.bundleObjectKey !== key) return reject('BUNDLE_HASH_MISMATCH');

    let bytes;
    try {
      bytes = await store.get(key, SKILL_BUNDLE_MAX_BYTES);
    } catch {
      throw ApplicationFailure.retryable('Skill bundle read failed', 'SKILL_BUNDLE_READ_FAILED');
    }
    if (
      bytes.length !== subject.sizeBytes ||
      createHash('sha256').update(bytes).digest('hex') !== subject.bundleSha256
    )
      return reject('BUNDLE_HASH_MISMATCH');
    const result = parseSkillBundle(bytes);
    if (!result.ok) return reject(result.code);
    const { manifest, digest, bundle } = result.parsed;
    if (manifest.name !== subject.packageName) return reject('NAME_MISMATCH');
    const supplyChain = checkManifestSupplyChain(manifest);
    if (supplyChain !== 'ok') return reject(supplyChain);
    const signature = Buffer.from(bundle.signature.value_base64, 'base64');
    const trust = checkTenantSignature({
      digest,
      keyId: bundle.signature.key_id,
      signature,
      lookup: (keyId) => subject.trustedSigners.find((key) => key.keyId === keyId) ?? null,
    });
    if (trust !== 'ok') return reject(trust);
    const startedAt = new Date();
    const contract = runContractTests(result.parsed);
    const failed = contract.firstFailed !== null;
    await recordSkillTestRun(database, context, {
      skillVersionId,
      digest,
      mode: 'contract',
      outcome: failed ? 'failed' : 'passed',
      fixturesTotal: contract.total,
      fixturesPassed: contract.passed,
      firstFailedFixture: contract.firstFailed,
      code: failed ? 'TESTS_FAILED' : null,
      startedAt,
    });
    if (failed) return reject('TESTS_FAILED');
    const policy = policyForManifest(manifest, ceilings);
    if (!policy.ok) return reject(policy.code);
    // Runtime fixture execution requires a qualified sandbox worker.
    if (policy.policy !== null) return reject('SANDBOX_UNAVAILABLE');

    const outcome = await markSkillVersionVerified(database, context, {
      skillVersionId,
      facts: {
        semver: manifest.version,
        digest,
        manifest,
        executionKind: manifest.execution.kind,
        license: manifest.license,
        maxClassification: manifest.max_classification,
        signerKeyId: bundle.signature.key_id,
        signature,
      },
    });
    return { step: 'finished', outcome };
  }

  return {
    async checkSkillBundle(input: SkillVerificationInput): Promise<SkillCheckStep> {
      try {
        return await check(input);
      } catch (error) {
        if (error instanceof ApplicationFailure && error.type === 'SKILL_BUNDLE_READ_FAILED')
          throw error;
        throw ApplicationFailure.retryable('Skill verification failed', 'SKILL_VERIFICATION_RETRY');
      }
    },
    async finishSkillVerification(
      input: SkillVerificationInput,
    ): Promise<SkillVerificationOutcome> {
      return abandonSkillVerification(input, 'SANDBOX_UNAVAILABLE');
    },
    abandonSkillVerification,
  };
}

export type SkillVerificationActivities = ReturnType<typeof createSkillVerificationActivities>;
