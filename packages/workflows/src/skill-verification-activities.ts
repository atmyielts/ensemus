import { createHash } from 'node:crypto';
import {
  beginSkillVerification,
  createFixtureRuns,
  loadFixtureRunResults,
  markSkillVersionVerified,
  recordSkillTestRun,
  rejectSkillVersion,
  skillVerificationOutcome,
  type SkillFeatureGate,
  type VerificationSubject,
} from '@ensemus/application';
import { createServiceContext } from '@ensemus/database/service';
import { canonicalJson } from '@ensemus/domain/approval';
import {
  SKILL_BUNDLE_MAX_BYTES,
  skillBundleObjectKey,
  type SkillRejectCode,
} from '@ensemus/domain/skill';
import {
  parseSkillBundle,
  readFixtures,
  runContractTests,
  type ParsedSkillBundle,
} from '@ensemus/skills/bundle';
import { checkTenantSignature } from '@ensemus/skills/signature';
import { checkManifestSupplyChain, policyForManifest } from '@ensemus/skills/supply-chain';
import { ApplicationFailure } from '@temporalio/common';
import {
  hasMarketplaceBundleSignature,
  hasMarketplaceReview,
  matchesMarketplaceBundle,
} from './marketplace-install-step';
import type { SkillCheckStep, SkillVerificationInput, SkillVerificationOutcome } from './schemas';
import type { SkillActivityDeps } from './skill-deps';

export function createSkillVerificationActivities({
  database,
  store,
  ceilings,
  reviewKeys,
  sandboxGate,
}: SkillActivityDeps & { sandboxGate?: SkillFeatureGate }) {
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

  async function checkedBundle(
    { organizationId, skillVersionId }: SkillVerificationInput,
    subject: VerificationSubject,
  ): Promise<
    | { ok: true; parsed: ParsedSkillBundle; signature: Buffer }
    | { ok: false; code: SkillRejectCode }
  > {
    const reject = (code: SkillRejectCode) => ({ ok: false as const, code });
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
    if (subject.origin === 'marketplace') {
      const listing = subject.listing;
      if (!listing || listing.state !== 'listed') return reject('LISTING_NOT_AVAILABLE');
      if (!hasMarketplaceReview(listing, reviewKeys)) return reject('ATTESTATION_INVALID');
      if (
        listing.bundleSha256 !== subject.bundleSha256 ||
        !matchesMarketplaceBundle(result.parsed, listing)
      )
        return reject('BUNDLE_HASH_MISMATCH');
      if (!hasMarketplaceBundleSignature(result.parsed, listing))
        return reject('SIGNATURE_INVALID');
    } else {
      const trust = checkTenantSignature({
        digest,
        keyId: bundle.signature.key_id,
        signature,
        lookup: (keyId) => subject.trustedSigners.find((key) => key.keyId === keyId) ?? null,
      });
      if (trust !== 'ok') return reject(trust);
    }
    return { ok: true, parsed: result.parsed, signature };
  }

  function verify(
    input: SkillVerificationInput,
    context: ReturnType<typeof createServiceContext>,
    { manifest, digest, bundle }: ParsedSkillBundle,
    signature: Buffer,
  ) {
    return markSkillVersionVerified(database, context, {
      skillVersionId: input.skillVersionId,
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
    const result = await checkedBundle(input, subject);
    if (!result.ok) return reject(result.code);
    const { manifest, digest, bundle } = result.parsed;
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
    if (policy.policy !== null) {
      if (!(await sandboxGate?.isEnabled(context, 'sandbox'))) return reject('SANDBOX_UNAVAILABLE');
      const fixtures = readFixtures(result.parsed);
      if (!fixtures) return reject('TESTS_FAILED');
      const sandboxRunIds = await createFixtureRuns(database, context, {
        skillVersionId,
        digest,
        signerKeyId: bundle.signature.key_id,
        policy: policy.policy,
        policyHash: policy.policyHash,
        fixtures,
      });
      return sandboxRunIds.length
        ? { step: 'run_fixtures', sandboxRunIds }
        : {
            step: 'finished',
            outcome: await skillVerificationOutcome(database, context, skillVersionId),
          };
    }
    return {
      step: 'finished',
      outcome: await verify(input, context, result.parsed, result.signature),
    };
  }

  async function finish(input: SkillVerificationInput): Promise<SkillVerificationOutcome> {
    const { organizationId, skillVersionId } = input;
    const context = createServiceContext(organizationId);
    const subject = await beginSkillVerification(database, context, input);
    if (!subject) return skillVerificationOutcome(database, context, skillVersionId);
    if (!(await sandboxGate?.isEnabled(context, 'sandbox')))
      return settleRejection(input, 'SANDBOX_UNAVAILABLE');
    const result = await checkedBundle(input, subject);
    if (!result.ok) return settleRejection(input, result.code);
    const { manifest, digest, bundle } = result.parsed;
    const fixtures = readFixtures(result.parsed);
    if (manifest.execution.kind !== 'sandbox' || !fixtures)
      return settleRejection(input, 'TESTS_FAILED');
    const runs = await loadFixtureRunResults(database, context, {
      skillVersionId,
      digest,
      signerKeyId: bundle.signature.key_id,
    });
    const firstFailed = fixtures.findIndex((fixture, index) => {
      const run = runs[index];
      return (
        run?.position !== fixture.position ||
        run.status !== 'succeeded' ||
        canonicalJson(run.output) !== canonicalJson(fixture.expectedOutput)
      );
    });
    const failure = firstFailed === -1 ? null : runs[firstFailed];
    const code =
      firstFailed === -1
        ? null
        : failure?.status === 'runner_unavailable' ||
            failure?.outcomeCode === 'FEATURE_DISABLED' ||
            failure?.outcomeCode === 'ISOLATION_NOT_PROVED'
          ? 'SANDBOX_UNAVAILABLE'
          : 'TESTS_FAILED';
    await recordSkillTestRun(database, context, {
      skillVersionId,
      digest,
      mode: 'sandbox',
      outcome: code ? 'failed' : 'passed',
      fixturesTotal: fixtures.length,
      fixturesPassed: firstFailed === -1 ? fixtures.length : firstFailed,
      firstFailedFixture: firstFailed === -1 ? null : firstFailed,
      code,
      startedAt: new Date(),
    });
    return code
      ? settleRejection(input, code)
      : verify(input, context, result.parsed, result.signature);
  }

  async function safe<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ApplicationFailure && error.type === 'SKILL_BUNDLE_READ_FAILED')
        throw error;
      throw ApplicationFailure.retryable('Skill verification failed', 'SKILL_VERIFICATION_RETRY');
    }
  }

  return {
    checkSkillBundle: (input: SkillVerificationInput) => safe(() => check(input)),
    finishSkillVerification: (input: SkillVerificationInput) => safe(() => finish(input)),
    abandonSkillVerification,
  };
}

export type SkillVerificationActivities = ReturnType<typeof createSkillVerificationActivities>;
