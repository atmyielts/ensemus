import { describe, it, expect } from 'vitest';
import { decideArtifactSchema, askQuestionSchema } from '@ensemus/contracts/knowledge';
describe('exact human knowledge review contract', () => {
  const digest = 'a'.repeat(64);
  it('requires both reviewed objective and citation digests for acceptance', () => {
    expect(
      decideArtifactSchema.safeParse({ artifact_sha256: digest, verdict: 'accepted' }).success,
    ).toBe(false);
    expect(
      decideArtifactSchema.safeParse({
        artifact_sha256: digest,
        objective_sha256: digest,
        verdict: 'accepted',
      }).success,
    ).toBe(false);
    expect(
      decideArtifactSchema.parse({
        artifact_sha256: digest,
        objective_sha256: digest,
        citations_sha256: digest,
        verdict: 'accepted',
      }).verdict,
    ).toBe('accepted');
  });
  it('requires an actual rejection reason without inventing accepted proof', () => {
    expect(
      decideArtifactSchema.safeParse({
        artifact_sha256: digest,
        verdict: 'rejected',
        reason: '   ',
      }).success,
    ).toBe(false);
    expect(
      decideArtifactSchema.parse({
        artifact_sha256: digest,
        verdict: 'rejected',
        reason: 'Claim is unsupported.',
      }).verdict,
    ).toBe('rejected');
  });
  it('keeps a question restricted unless the person explicitly supplies its classification', () => {
    expect(
      askQuestionSchema.parse({ question: 'Generated confidential question' }).classification,
    ).toBe('restricted');
    expect(
      askQuestionSchema.parse({ question: 'Generated public question', classification: 'public' })
        .classification,
    ).toBe('public');
  });
});
