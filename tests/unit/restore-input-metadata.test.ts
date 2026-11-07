import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { AppDatabase } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import {
  createRestoreContributors,
  evaluateRunInputRestoreMetadata,
  evaluateOutputWriteRestoreMetadata,
  transcriptRestoreProofAttention,
  type RestoreRunInputCounts,
} from '@ensemus/application';

const complete: RestoreRunInputCounts = {
  runs: 2,
  checkpoints: 2,
  observations: 5,
  missingCheckpoints: 0,
  legacyHistoryUnknown: 0,
  unfencedTerminalRuns: 0,
  uncertifiedFences: 0,
  certifiedFences: 1,
  unsupportedProtocols: 0,
};
const proof = {
  protocol: 'ai.run_inputs/v1' as const,
  fenceGeneration: 1 as const,
  checkedRuns: 2,
  certifiedRuns: 1,
  remainingPayloads: 0,
};

describe('restored input protocol metadata', () => {
  it('counts real metadata rows rather than reporting a synthetic zero check', () => {
    expect(evaluateRunInputRestoreMetadata(complete)).toEqual({ checked: 9, attention: 0 });
  });
  it('keeps legacy unknown history distinct from a missing modern checkpoint', () => {
    expect(
      evaluateRunInputRestoreMetadata({
        ...complete,
        legacyHistoryUnknown: 1,
        missingCheckpoints: 1,
      }).attention,
    ).toBe(2);
    expect(
      evaluateRunInputRestoreMetadata({ ...complete, legacyHistoryUnknown: 1 }).attention,
    ).toBe(1);
    expect(transcriptRestoreProofAttention(proof, complete)).toBe(0);
  });
  it('requires actual adapter coverage and the exact supported fence generation', () => {
    expect(transcriptRestoreProofAttention(undefined, complete)).toBe(1);
    expect(transcriptRestoreProofAttention({ ...proof, fenceGeneration: 2 }, complete)).toBe(1);
    expect(transcriptRestoreProofAttention({ ...proof, checkedRuns: 1 }, complete)).toBe(1);
    expect(transcriptRestoreProofAttention({ ...proof, certifiedRuns: 0 }, complete)).toBe(1);
    expect(transcriptRestoreProofAttention({ ...proof, remainingPayloads: 3 }, complete)).toBe(3);
  });
  it('keeps registered/started writers and mismatched retained tokens unresolved', () => {
    expect(
      evaluateOutputWriteRestoreMetadata({ writes: 3, unsettledWrites: 1, mismatchedTokens: 1 }),
    ).toEqual({ checked: 3, attention: 2 });
    expect(
      evaluateOutputWriteRestoreMetadata({ writes: 3, unsettledWrites: 0, mismatchedTokens: 0 }),
    ).toEqual({ checked: 3, attention: 0 });
  });
  it('refuses negative or rounded metadata counts', () => {
    expect(() => evaluateRunInputRestoreMetadata({ ...complete, observations: -1 })).toThrow();
    expect(() =>
      evaluateOutputWriteRestoreMetadata({ writes: 1, unsettledWrites: 0.5, mismatchedTokens: 0 }),
    ).toThrow();
  });
  it('does not read private payloads or accept metadata presence as an adapter proof', async () => {
    const statements: string[] = [];
    const database = {
      transaction: async (_bindings: unknown, run: (tx: unknown) => Promise<unknown>) =>
        run({
          execute: async (query: SQL) => {
            statements.push(new PgDialect().sqlToQuery(query).sql);
            return { rows: [complete] };
          },
        }),
    } as unknown as AppDatabase;
    const context = createServiceContext('10000000-0000-4000-8000-000000000001');
    const audit = createRestoreContributors({
      'm4-private-transcripts': {
        reconcile: async () => ({ checked: 9, changed: 0, needsAttention: 0 }),
      },
    }).find((item) => item.name === 'm4-private-transcripts');
    if (!audit) throw new Error('Required audit absent');
    const result = await audit.reconcile(database, context);
    expect(result).toMatchObject({ checked: 9, needsAttention: 1, runInputs: complete });
    expect(statements).toHaveLength(2);
    expect(statements.join('\n')).not.toMatch(/\bai\.step_payloads\b/);
    const withTestOnlyAgentProof = createRestoreContributors({
      'm4-private-transcripts': {
        reconcile: async () => ({
          checked: 9,
          changed: 0,
          needsAttention: 0,
          transcriptProof: proof,
        }),
      },
    }).find((item) => item.name === 'm4-private-transcripts');
    if (!withTestOnlyAgentProof) throw new Error('Required audit absent');
    expect((await withTestOnlyAgentProof.reconcile(database, context)).needsAttention).toBe(0);
    expect(statements.join('\n')).not.toMatch(/\bai\.step_payloads\b/);
  });
});
