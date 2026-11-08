import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@ensemus/domain/approval';
import { workTitleInput } from '../work-title';
import { createWorkInput } from '../work';
import { delegatedBodyProofFromProposal } from './delegated-title';

const argumentsFor = (title: unknown) => ({
  agent_version_id: '00000000-0000-4000-8000-000000000001',
  title,
  tools: ['work.read'],
  max_cost_micros: 1,
});

describe('actual delegated Work title transform', () => {
  it.each([
    '  Generated title  ',
    '\u00a0\ufeffКлиент 🧭\u2009\u2029',
    '\tQuotes " and \\ and\nnewlines\r\n',
  ])('matches the exact Work kernel Unicode normalization for %j', (raw) => {
    const title = workTitleInput.parse(raw);
    expect(title).toBe(createWorkInput.parse({ title: raw }).title);
    const proof = delegatedBodyProofFromProposal(argumentsFor(raw));
    expect(proof).toEqual({
      transformVersion: 'work-title-v1',
      derivedBodySha256: createHash('sha256')
        .update(canonicalJson({ objective: null, title }))
        .digest('hex'),
    });
    expect(proof).not.toHaveProperty('title');
    expect(proof).not.toHaveProperty('objective');
  });
  it('binds the actual normalized bytes, without guessing SQL whitespace or accepting an invalid proposal', () => {
    expect(delegatedBodyProofFromProposal(argumentsFor('\u00a0same\ufeff'))).toEqual(
      delegatedBodyProofFromProposal(argumentsFor('same')),
    );
    expect(delegatedBodyProofFromProposal(argumentsFor('different'))).not.toEqual(
      delegatedBodyProofFromProposal(argumentsFor('same')),
    );
    for (const invalid of [
      null,
      {},
      argumentsFor('\u00a0\ufeff'),
      argumentsFor(3),
      argumentsFor('x'.repeat(201)),
    ])
      expect(delegatedBodyProofFromProposal(invalid)).toBeNull();
  });
});
