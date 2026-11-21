// Owned by the skill-format slice (EXP-04, EXP-06). See docs/06-delivery/m11b-slices.md and ADR-034 D5.
// Checks a review's signature against keys from the deployment's configuration, never from the database.
import { createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '@ensemus/domain/approval';
import {
  REVIEW_CHECK_RESULTS,
  REVIEW_FINDING_CODES,
  reviewCanApprove,
  type ReviewAttestation,
} from '@ensemus/domain/marketplace';
import { isValidPublicKey, keyIdOf } from '@ensemus/skills/signature';

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const result = z.enum(REVIEW_CHECK_RESULTS);
const approved = z.strictObject({
  kind: z.literal('ensemus.skill.review.v1'),
  submissionId: z.uuid(),
  publisherId: z.uuid(),
  name: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
  semver: z.string().regex(/^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/),
  digest: hash,
  signerKeyId: hash,
  verdict: z.literal('approved'),
  checks: z.strictObject({
    signature_and_digest_checked: result,
    license_and_dependencies_checked: result,
    tool_boundaries_match_purpose: result,
    data_classes_match_purpose: result,
    instructions_read_for_abuse: result,
    code_read_for_abuse: result,
    tests_inspected: result,
  }),
  findingCodes: z.array(z.enum(REVIEW_FINDING_CODES)).max(REVIEW_FINDING_CODES.length),
  reviewerKeyId: hash,
  decidedAt: z.iso.datetime(),
});

/** The fixed prefix on what a review key signs. */
export const REVIEW_SIGNATURE_DOMAIN = 'ensemus.skill.review.v1\0';

/** Exactly the bytes a reviewer signs: the domain prefix, then the attestation's canonicalJson. */
export function attestationPayload(attestation: ReviewAttestation): Buffer {
  return Buffer.from(REVIEW_SIGNATURE_DOMAIN + canonicalJson(attestation), 'utf8');
}

/** Checks a stored attestation's shape, with the verdict `approved`. Null for anything else. */
export function parseApprovedAttestation(value: unknown): ReviewAttestation | null {
  try {
    const parsed = approved.safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export type AttestationFacts = {
  /** From the signed manifest; code review cannot be skipped for executable packages. */
  executionKind: 'declarative' | 'sandbox';
  submissionId: string;
  publisherId: string;
  name: string;
  semver: string;
  digest: string;
  signerKeyId: string;
};

/**
 * True only if the reviewer's key is one this deployment configured, it signed exactly this attestation,
 * the verdict is `approved`, and every fact matches. Answers false for any failure, and never throws.
 */
export function verifyApprovedAttestation(input: {
  attestation: unknown;
  signature: Buffer;
  reviewKeys: ReadonlyMap<string, Buffer>;
  facts: AttestationFacts;
}): boolean {
  try {
    const attestation = parseApprovedAttestation(input.attestation);
    if (
      !['declarative', 'sandbox'].includes(input.facts.executionKind) ||
      !attestation ||
      !Buffer.isBuffer(input.signature) ||
      input.signature.length !== 64 ||
      attestation.reviewerKeyId === attestation.signerKeyId ||
      !reviewCanApprove(attestation.checks, attestation.findingCodes, input.facts.executionKind)
    )
      return false;
    for (const field of [
      'submissionId',
      'publisherId',
      'name',
      'semver',
      'digest',
      'signerKeyId',
    ] as const) {
      if (attestation[field] !== input.facts[field]) return false;
    }
    const rawKey = input.reviewKeys.get(attestation.reviewerKeyId);
    if (!rawKey || !isValidPublicKey(rawKey) || keyIdOf(rawKey) !== attestation.reviewerKeyId)
      return false;
    const key = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawKey]),
      format: 'der',
      type: 'spki',
    });
    return verify(null, attestationPayload(attestation), key, input.signature);
  } catch {
    return false;
  }
}
