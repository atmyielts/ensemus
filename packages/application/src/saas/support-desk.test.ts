import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { replyAsDesk, SupportContentBusy, type DeskDb } from './support-desk';
const input = {
  organizationId: randomUUID(),
  ticketId: randomUUID(),
  agentRef: 'test-desk@example.invalid',
  body: 'Test reply',
};
describe('desk fence contention does not cause automatic replay', () => {
  it('maps only the explicit fixed fence code to a plain retryable busy result', async () => {
    const transaction = vi.fn().mockRejectedValue({ cause: { code: 'EN807' } });
    const failure = await replyAsDesk({ transaction } as unknown as DeskDb, input).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SupportContentBusy);
    expect(failure).toMatchObject({
      code: 'SUPPORT_CONTENT_BUSY',
      retryable: true,
      message: 'This organization is being updated. Try again.',
    });
    expect(transaction).toHaveBeenCalledTimes(1);
  });
  it.each(['55P03', '25006', '42501'])('preserves unrelated database refusal %s', async (code) => {
    const original = { cause: { code } },
      transaction = vi.fn().mockRejectedValue(original);
    await expect(replyAsDesk({ transaction } as unknown as DeskDb, input)).rejects.toBe(original);
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
