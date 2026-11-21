import type { TenantMailFacts } from '@ensemus/database/mailer';
import { describe, expect, it } from 'vitest';
import {
  accountMailContent,
  parseSealedPayload,
  planTenantMail,
  tenantMailContent,
  topicOfMail,
} from './plan';

const ORG = '11111111-1111-4111-8111-111111111111';
const ANSWER = '22222222-2222-4222-8222-222222222222';
const URL = 'https://ensemus.example.com';
const now = new Date('2026-11-12T10:00:00Z');
const options = { now, unsubscribeTokenSha256: 'a'.repeat(64) };

const notification = (overrides: Partial<TenantMailFacts> = {}): TenantMailFacts => ({
  id: '33333333-3333-4333-8333-333333333333',
  organizationId: ORG,
  kind: 'notification',
  attempts: 0,
  sendBefore: new Date('2026-11-15T10:00:00Z'),
  organization: { name: 'Northwind', lifecycle: 'active' },
  member: {
    membershipId: '44444444-4444-4444-8444-444444444444',
    name: 'Ada',
    address: 'ada@example.com',
    addressVerified: true,
    active: true,
  },
  invitation: null,
  notification: {
    kind: 'knowledge.answer_ready',
    targetRef: `knowledge_answer:${ANSWER}`,
    reminderNumber: null,
    read: false,
  },
  digest: null,
  preference: null,
  bounced: false,
  recentToMember: 0,
  recentForOrganization: 0,
  ...overrides,
});

describe('planning a tenant message', () => {
  it('sends an answer at once, with an unsubscribe link for its topic', () => {
    expect(planTenantMail(notification(), options)).toEqual({
      action: 'send',
      unsubscribe: { topic: 'answers', tokenSha256: 'a'.repeat(64) },
    });
  });

  it('holds it for the morning when that is the choice, or the hour is busy', () => {
    expect(planTenantMail(notification({ preference: 'daily' }), options)).toEqual({
      action: 'hold',
      digestDueAt: new Date('2026-11-13T08:00:00Z'),
    });
    expect(planTenantMail(notification({ recentToMember: 20 }), options).action).toBe('hold');
    expect(planTenantMail(notification({ recentForOrganization: 500 }), options).action).toBe(
      'hold',
    );
  });

  it('skips what was read, who left, or a company that is gone', () => {
    const read = notification();
    read.notification!.read = true;
    expect(planTenantMail(read, options)).toMatchObject({
      status: 'skipped',
      code: 'ALREADY_READ',
    });
    expect(
      planTenantMail(
        notification({ member: { ...notification().member!, active: false } }),
        options,
      ),
    ).toMatchObject({ code: 'RECIPIENT_GONE' });
    expect(
      planTenantMail(notification({ organization: { name: 'x', lifecycle: 'deleted' } }), options),
    ).toMatchObject({ code: 'RECIPIENT_GONE' });
  });

  it('keeps chosen mail away from an address that bounced, but not essential mail', () => {
    expect(planTenantMail(notification({ bounced: true }), options)).toMatchObject({
      status: 'suppressed',
      code: 'ADDRESS_BOUNCED',
    });
    const essential = notification({ bounced: true });
    essential.notification!.kind = 'break_glass.requested';
    expect(planTenantMail(essential, options)).toEqual({ action: 'send', unsubscribe: null });
  });

  it('sends an open invitation with no unsubscribe link, and skips a closed one', () => {
    const invitation = notification({
      kind: 'invitation',
      member: null,
      notification: null,
      invitation: {
        address: 'new@example.com',
        open: true,
        inviterName: 'Grace',
        link: {
          keyId: 'k',
          wrappedKey: Buffer.alloc(1),
          iv: Buffer.alloc(1),
          ciphertext: Buffer.alloc(1),
          authTag: Buffer.alloc(1),
        },
      },
    });
    expect(planTenantMail(invitation, options)).toEqual({ action: 'send', unsubscribe: null });
    invitation.invitation!.open = false;
    expect(planTenantMail(invitation, options)).toMatchObject({ code: 'INVITATION_CLOSED' });
  });

  it('sends a digest with something in it, to a confirmed address', () => {
    const digest = notification({
      kind: 'digest',
      notification: null,
      digest: { topic: 'activity', items: [{ kind: 'work.assigned', count: 2 }] },
    });
    expect(planTenantMail(digest, options)).toEqual({
      action: 'send',
      unsubscribe: { topic: 'activity', tokenSha256: 'a'.repeat(64) },
    });
    expect(
      planTenantMail({ ...digest, digest: { topic: 'activity', items: [] } }, options),
    ).toMatchObject({ status: 'skipped' });
    expect(planTenantMail({ ...digest, preference: 'off' }, options)).toMatchObject({
      code: 'PREFERENCE_OFF',
    });
  });

  it('reads the topic of a notification and of a digest', () => {
    expect(
      topicOfMail({ kind: 'notification', notificationKind: 'invoice.issued', targetRef: 'x' }),
    ).toBe('billing');
    expect(
      topicOfMail({ kind: 'digest', notificationKind: null, targetRef: 'topic:support' }),
    ).toBe('support');
    expect(topicOfMail({ kind: 'invitation', notificationKind: null, targetRef: null })).toBeNull();
  });
});

describe('what a tenant message says', () => {
  it('leads an answer to its own page, with the company name and nothing of its content', () => {
    const content = tenantMailContent(notification(), {
      publicUrl: URL,
      unsubscribeToken: 'tok',
      invitationLink: null,
    });
    expect(content).toMatchObject({
      kind: 'notification',
      title: 'The answer to your question is ready',
      link: `${URL}/o/${ORG}/knowledge/answers/${ANSWER}`,
      organizationName: 'Northwind',
      unsubscribeLink: `${URL}/unsubscribe/tok`,
      preferencesLink: `${URL}/o/${ORG}/notifications`,
    });
  });

  it('offers no preferences or unsubscribe link on essential mail', () => {
    const content = tenantMailContent(notification(), {
      publicUrl: URL,
      unsubscribeToken: null,
      invitationLink: null,
    });
    expect(content).toMatchObject({ unsubscribeLink: null, preferencesLink: null });
  });
});

describe('account mail', () => {
  it('needs its link, except the notice of a changed password', () => {
    expect(accountMailContent('password_reset', 'Ada', null, URL)).toBeNull();
    expect(
      accountMailContent('password_reset', 'Ada', { link: `${URL}/reset-password/t` }, URL),
    ).toMatchObject({ kind: 'password_reset', validMinutes: 30 });
    expect(accountMailContent('password_changed', 'Ada', null, URL)).toMatchObject({
      resetLink: `${URL}/forgot-password`,
    });
    expect(
      accountMailContent('email_change_confirm', 'Ada', { link: `${URL}/verify-email/t` }, URL),
    ).toBeNull();
  });

  it('opens only a link back to this Ensemus', () => {
    const sealed = (value: unknown) => Buffer.from(JSON.stringify(value));
    expect(parseSealedPayload(sealed({ link: `${URL}/reset-password/t` }), URL)).toEqual({
      link: `${URL}/reset-password/t`,
    });
    expect(parseSealedPayload(sealed({ link: 'https://evil.example/x' }), URL)).toBeNull();
    expect(parseSealedPayload(sealed({ link: `${URL}.evil.example/x` }), URL)).toBeNull();
    expect(parseSealedPayload(Buffer.from('not json'), URL)).toBeNull();
    expect(
      parseSealedPayload(
        sealed({ link: `${URL}/verify-email/t`, newAddress: 'b@example.com' }),
        URL,
      ),
    ).toEqual({ link: `${URL}/verify-email/t`, newAddress: 'b@example.com' });
  });
});
