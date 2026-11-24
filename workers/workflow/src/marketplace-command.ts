// The offline marketplace operator authenticates review decisions. Private keys stay off the server.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pgCode, type MarketplaceReviewKeys, type ObjectStore } from '@ensemus/application';
import {
  createListing,
  delistListing,
  getApprovedReview,
  getSubmissionForReview,
  listOperatorQueue,
  markSubmissionInReview,
  MarketplaceOperatorRefusal,
  recordReview,
  reserveListingObject,
  setPublisherState,
  type openMarketplaceOperatorDatabase,
} from '@ensemus/database/marketplace-operator';
import type { MarketplaceSubmissionRow } from '@ensemus/database';
import { canonicalJson } from '@ensemus/domain/approval';
import { DELIST_CODES, DELIST_MODES, listingObjectKey } from '@ensemus/domain/marketplace';
import { SKILL_BUNDLE_MEDIA_TYPE } from '@ensemus/domain/skill';
import { parseSkillBundle } from '@ensemus/skills/bundle';
import {
  attestationPayload,
  parseReviewAttestation,
  verifyApprovedAttestation,
  verifyReviewAttestation,
  type AttestationFacts,
} from '@ensemus/skills/review';
import { verifySkillSignature } from '@ensemus/skills/signature';
import { skillManifestSchema } from '@ensemus/contracts/skills';
import { createLogger } from '@ensemus/telemetry';

export const log = createLogger('marketplace-operator');

export type MarketplaceCommandDeps = {
  db: ReturnType<typeof openMarketplaceOperatorDatabase>['db'];
  store: ObjectStore;
  reviewKeys: MarketplaceReviewKeys;
  print: (line: string) => void;
};

class CommandRefusal extends Error {
  constructor(
    readonly code:
      | 'INVALID_ARGUMENTS'
      | 'INVALID_DECISION'
      | 'SIGNATURE_INVALID'
      | 'BUNDLE_MISMATCH'
      | 'LISTING_OBJECT_CONFLICT',
  ) {
    super(code);
    this.name = 'MarketplaceCommandRefusal';
  }
}

type Argument<T> = (value: string) => T;
type Arguments<T extends unknown[]> = { [K in keyof T]: Argument<T[K]> };

function checked<T>(condition: boolean, value: T): T {
  if (!condition) throw new CommandRefusal('INVALID_ARGUMENTS');
  return value;
}

const uuid = (value: string) =>
  checked(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
    value.toLowerCase(),
  );
const label = (value: string) => {
  const trimmed = value.trim();
  return checked(trimmed.length <= 120 && /^[^\p{Cc}\p{Cf}]+$/u.test(trimmed), trimmed);
};
const version = (value: string) => {
  const expectedVersion = Number(value);
  return checked(
    /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(expectedVersion),
    expectedVersion,
  );
};
const path = (value: string) => checked(value.length > 0 && value.length <= 32768, value);
const oneOf =
  <T extends string>(values: readonly T[]) =>
  (value: string): T => {
    const found = values.find((item) => item === value);
    if (!found) throw new CommandRefusal('INVALID_ARGUMENTS');
    return found;
  };

function parse<T extends unknown[]>(schema: Arguments<T>, input: readonly string[]): T {
  if (input.length !== schema.length) throw new CommandRefusal('INVALID_ARGUMENTS');
  return schema.map((parser, position) => parser(input[position]!)) as T;
}

function reviewChoices(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CommandRefusal('INVALID_DECISION');
  const fields = ['verdict', 'checks', 'findingCodes', 'reviewerKeyId', 'decidedAt'];
  const keys = Object.keys(value);
  if (keys.length !== fields.length || !keys.every((key) => fields.includes(key)))
    throw new CommandRefusal('INVALID_DECISION');
  return value;
}

async function readDecision(file: string): Promise<unknown> {
  const input = await readFile(file, 'utf8');
  if (input.length > 16384) throw new CommandRefusal('INVALID_DECISION');
  try {
    return JSON.parse(input);
  } catch {
    throw new CommandRefusal('INVALID_DECISION');
  }
}

async function readSignature(file: string) {
  const raw = (await readFile(file, 'utf8')).trim();
  const signature = Buffer.from(raw, 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== raw)
    throw new CommandRefusal('SIGNATURE_INVALID');
  return signature;
}

function factsOf(submission: MarketplaceSubmissionRow): AttestationFacts {
  const manifest = skillManifestSchema.safeParse(submission.manifest);
  if (!manifest.success) throw new CommandRefusal('BUNDLE_MISMATCH');
  return {
    submissionId: submission.id,
    publisherId: submission.publisherId,
    name: submission.name,
    semver: submission.semver,
    digest: submission.digest,
    signerKeyId: submission.signerKeyId,
    executionKind: manifest.data.execution.kind,
  };
}

async function loadSubmission(
  deps: MarketplaceCommandDeps,
  organizationId: string,
  submissionId: string,
) {
  const submission = await getSubmissionForReview(deps.db, { organizationId, submissionId });
  if (!submission) throw new MarketplaceOperatorRefusal('NOT_FOUND');
  return submission;
}

async function checkedBundle(store: ObjectStore, submission: MarketplaceSubmissionRow) {
  const bytes = await store.get(submission.bundleObjectKey, submission.sizeBytes);
  if (bytes.length !== submission.sizeBytes) throw new CommandRefusal('BUNDLE_MISMATCH');
  const check = parseSkillBundle(bytes);
  if (
    !check.ok ||
    check.parsed.digest !== submission.digest ||
    canonicalJson(check.parsed.manifest) !== canonicalJson(submission.manifest)
  )
    throw new CommandRefusal('BUNDLE_MISMATCH');
  const embeddedSignature = check.parsed.bundle.signature;
  if (
    embeddedSignature.key_id !== submission.signerKeyId ||
    embeddedSignature.value_base64 !== submission.signature.toString('base64') ||
    !verifySkillSignature({
      digest: submission.digest,
      signature: submission.signature,
      publicKey: submission.signerPublicKey,
    })
  )
    throw new CommandRefusal('SIGNATURE_INVALID');
  return bytes;
}

function printJson(deps: MarketplaceCommandDeps, value: unknown) {
  // JSON escapes control characters; also neutralize directional and C1 formatting.
  const line = JSON.stringify(value).replace(
    /[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu,
    (character) => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'),
  );
  deps.print(line);
}

export async function marketplaceCommand(
  argv: readonly string[],
  deps: MarketplaceCommandDeps,
): Promise<number> {
  const [command, ...args] = argv;
  try {
    switch (command) {
      case 'queue': {
        parse([], args);
        const queue = await listOperatorQueue(deps.db);
        printJson(
          deps,
          queue.map((row) => ({
            organizationId: row.organizationId,
            submissionId: row.id,
            state: row.state,
            version: row.version,
            delistRequestedAt: row.delistRequestedAt?.toISOString() ?? null,
          })),
        );
        break;
      }
      case 'show': {
        const [organizationId, submissionId, output] = parse([uuid, uuid, path], args);
        const row = await loadSubmission(deps, organizationId, submissionId);
        await writeFile(output, await checkedBundle(deps.store, row), { flag: 'wx' });
        printJson(deps, row.manifest);
        break;
      }
      case 'start-review': {
        const [organizationId, submissionId, expectedVersion] = parse([uuid, uuid, version], args);
        await markSubmissionInReview(deps.db, { organizationId, submissionId, expectedVersion });
        break;
      }
      case 'review-payload': {
        const [organizationId, submissionId, decisionFile, output] = parse(
          [uuid, uuid, path, path],
          args,
        );
        const choices = reviewChoices(await readDecision(decisionFile));
        const row = await loadSubmission(deps, organizationId, submissionId);
        const { executionKind: _executionKind, ...facts } = factsOf(row);
        const attestation = parseReviewAttestation({
          kind: 'ensemus.skill.review.v1',
          ...facts,
          ...choices,
        });
        if (!attestation) throw new CommandRefusal('INVALID_DECISION');
        await writeFile(output, attestationPayload(attestation), { flag: 'wx' });
        printJson(deps, attestation);
        break;
      }
      case 'record-review': {
        const [organizationId, submissionId, file, signatureFile, reviewerLabel, expectedVersion] =
          parse([uuid, uuid, path, path, label, version], args);
        const attestation = parseReviewAttestation(await readDecision(file));
        if (!attestation) throw new CommandRefusal('INVALID_DECISION');
        const signature = await readSignature(signatureFile);
        const row = await loadSubmission(deps, organizationId, submissionId);
        if (
          !verifyReviewAttestation({
            attestation,
            signature,
            reviewKeys: deps.reviewKeys,
            facts: factsOf(row),
          })
        )
          throw new CommandRefusal('SIGNATURE_INVALID');
        const review = await recordReview(deps.db, {
          organizationId,
          attestation,
          attestationSignature: signature,
          reviewerLabel,
          expectedVersion,
        });
        printJson(deps, { reviewId: review.id, verdict: review.verdict });
        break;
      }
      case 'list': {
        const [organizationId, submissionId] = parse([uuid, uuid], args);
        const row = await loadSubmission(deps, organizationId, submissionId);
        if (row.state !== 'approved') throw new MarketplaceOperatorRefusal('INVALID_STATE');
        const review = await getApprovedReview(deps.db, { organizationId, submissionId });
        if (
          !review ||
          !verifyApprovedAttestation({
            attestation: review.attestation,
            signature: review.attestationSignature,
            reviewKeys: deps.reviewKeys,
            facts: factsOf(row),
          })
        )
          throw new CommandRefusal('SIGNATURE_INVALID');
        const bytes = await checkedBundle(deps.store, row);
        const objectKey = listingObjectKey(row.digest);
        const bundleSha256 = createHash('sha256').update(bytes).digest('hex');
        if (
          !(await reserveListingObject(deps.db, {
            organizationId,
            submissionId,
            digest: row.digest,
            bundleSha256,
            sizeBytes: bytes.length,
          }))
        )
          throw new CommandRefusal('LISTING_OBJECT_CONFLICT');
        if (!(await deps.store.exists(objectKey)))
          await deps.store.put(objectKey, bytes, SKILL_BUNDLE_MEDIA_TYPE);
        if (!(await deps.store.get(objectKey, bytes.length)).equals(bytes))
          throw new CommandRefusal('LISTING_OBJECT_CONFLICT');
        const listed = await createListing(deps.db, {
          organizationId,
          submissionId,
          reviewId: review.id,
          objectKey,
          bundleSha256,
        });
        printJson(deps, { listingId: listed.id, state: listed.state, version: listed.version });
        break;
      }
      case 'delist': {
        const [listingId, mode, code, expectedVersion] = parse(
          [uuid, oneOf(DELIST_MODES), oneOf(DELIST_CODES), version],
          args,
        );
        const row = await delistListing(deps.db, { listingId, mode, code, expectedVersion });
        printJson(deps, { listingId: row.id, state: row.state, version: row.version });
        break;
      }
      case 'suspend-publisher':
      case 'reinstate-publisher': {
        const [publisherId, expectedVersion] = parse([uuid, version], args);
        await setPublisherState(deps.db, {
          publisherId,
          expectedVersion,
          state: command === 'suspend-publisher' ? 'suspended' : 'active',
        });
        break;
      }
      default:
        throw new CommandRefusal('INVALID_ARGUMENTS');
    }
    return 0;
  } catch (error) {
    const code =
      error instanceof CommandRefusal || error instanceof MarketplaceOperatorRefusal
        ? error.code
        : pgCode(error);
    if (
      !(error instanceof CommandRefusal) &&
      !(error instanceof MarketplaceOperatorRefusal) &&
      code !== 'ES001' &&
      code !== 'ES004' &&
      code !== 'ES005' &&
      code !== '23505'
    )
      throw error;
    log.warn('marketplace_operator.refused', { reasonCode: code });
    return 2;
  }
}
