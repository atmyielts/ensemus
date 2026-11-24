// The inbox's words and links (apps/web/src/lib/notification-view.ts), the same ones email uses.
import { describe, expect, it } from 'vitest';
import { inboxTarget, inboxTitle } from '../../apps/web/src/lib/notification-view';

const ORG = '11111111-1111-4111-8111-111111111111';
const ANSWER = '22222222-2222-4222-8222-222222222222';

describe('an inbox row', () => {
  it('says an answer is ready and opens that answer', () => {
    expect(inboxTitle('knowledge.answer_ready')).toBe('The answer to your question is ready');
    expect(inboxTarget(ORG, `knowledge_answer:${ANSWER}`)).toBe(
      `/o/${ORG}/knowledge/answers/${ANSWER}`,
    );
  });

  it('keeps the words and links the inbox had before', () => {
    expect(inboxTitle('approval.requested')).toBe('An approval needs your decision');
    expect(inboxTarget(ORG, `approval:${ANSWER}`)).toBe(`/o/${ORG}/approvals/${ANSWER}`);
    expect(inboxTarget(ORG, `invitation:${ANSWER}`)).toBe(`/o/${ORG}/people`);
    expect(inboxTarget(ORG, 'unknown')).toBe(`/o/${ORG}/inbox`);
  });

  it('opens billing and support where they live', () => {
    expect(inboxTitle('invoice.issued')).toBe('You have a new invoice');
    expect(inboxTarget(ORG, `invoice:${ANSWER}`)).toBe(`/o/${ORG}/account/invoices/${ANSWER}`);
    expect(inboxTitle('ticket.replied')).toBe('Support replied to your request');
    expect(inboxTarget(ORG, `ticket:${ANSWER}`)).toBe(`/o/${ORG}/account/support/${ANSWER}`);
  });
});
