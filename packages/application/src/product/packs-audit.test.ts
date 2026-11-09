import { appendAudit, type Tx } from '@ensemus/database';
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors';
import { capabilityDecisionReason } from './packs';

/** A transaction that keeps what appendAudit would insert, so the audit format check runs for real. */
function recordingTx() {
  const rows: unknown[] = [];
  const tx = {
    insert: () => ({
      values: async (row: unknown) => {
        rows.push(row);
      },
    }),
  } as unknown as Tx;
  return { tx, rows };
}

const entry = (safeReason: string) => ({
  organizationId: '7f0c1f6e-3a39-4f5e-9d7a-3f4a0a4f1b11',
  actorType: 'user' as const,
  actorId: '0b7f5a2e-4e8c-4c1a-9f62-0a3c7d1e2f44',
  action: 'pack.capability_decided',
  targetRef: 'pack_installation:5d1e7c3a-8b2f-4a6d-9c0e-1f2a3b4c5d6e',
  decision: 'allow' as const,
  safeReason,
});

describe('the audit reason a pack capability decision is recorded with', () => {
  it.each([
    ['accepted', 'ACCEPTED'],
    ['declined', 'DECLINED'],
  ] as const)('records %s as the code %s, which the audit log accepts', async (decision, code) => {
    expect(capabilityDecisionReason(decision)).toBe(code);
    const { tx, rows } = recordingTx();
    await appendAudit(tx, entry(capabilityDecisionReason(decision)));
    expect(rows).toEqual([expect.objectContaining({ safeReason: code })]);
  });

  it('would be refused as the lower-case decision itself, which is what answered 500 before', async () => {
    for (const decision of ['accepted', 'declined']) {
      const { tx, rows } = recordingTx();
      await expect(appendAudit(tx, entry(decision))).rejects.toThrow(
        'Audit reasons must be codes, not free text',
      );
      expect(rows).toEqual([]);
    }
  });

  it('refuses anything but the two decisions, so nothing a caller wrote reaches the log', () => {
    for (const decision of ['pending', 'ACCEPTED', '', 'accepted; drop'])
      expect(() => capabilityDecisionReason(decision as 'accepted')).toThrow(
        new AppError('INVALID_INPUT'),
      );
  });
});
