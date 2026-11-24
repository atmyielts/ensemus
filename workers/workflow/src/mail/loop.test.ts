import {
  publicEncrypt,
  constants,
  createCipheriv,
  createDecipheriv,
  generateKeyPairSync,
  privateDecrypt,
  randomBytes,
} from 'node:crypto';
import type {
  ClaimedAccountMail,
  MailOutcome,
  MailTable,
  SealedLink,
  TenantMailClaim,
  TenantMailFacts,
  TenantMailPlan,
} from '@ensemus/database/mailer';
import { NotSent } from '@ensemus/connectors';
import { RefusedBeforeCommit } from '@ensemus/connectors/email/smtp';
import type { AttemptResult } from '@ensemus/domain/external-action';
import { ACCOUNT_MAIL_SCOPE, MAIL_LINK_PURPOSE } from '@ensemus/domain/mail';
import { describe, expect, it } from 'vitest';
import { outcomeOf, runMailPass, type LinkOpener, type MailDeps, type MailStore } from './loop';
import type { PlatformMessage } from './mime';

const URL = 'https://ensemus.example.com';
const now = new Date('2026-11-12T10:00:00Z');
const SHA = 'b'.repeat(64);

// A stand-in for the sealing scheme: the binding goes in as additional data, so a link moved to another
// row or tenant does not open, as with @ensemus/secrets.
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const binding = (b: { organizationId: string; secretId: string; purpose: string }) =>
  Buffer.from(`${b.organizationId}|${b.secretId}|${b.purpose}`);
function seal(
  plaintext: string,
  b: { organizationId: string; secretId: string; purpose: string },
): SealedLink {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(binding(b));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    keyId: 'test',
    wrappedKey: publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING }, key),
    iv,
    ciphertext,
    authTag: cipher.getAuthTag(),
  };
}
const openLink: LinkOpener = (sealed, b) => {
  const key = privateDecrypt(
    { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING },
    sealed.wrappedKey,
  );
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.iv);
  decipher.setAAD(binding(b));
  decipher.setAuthTag(sealed.authTag);
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
};

function fakeStore(queues: {
  account?: ClaimedAccountMail[];
  tenant?: TenantMailFacts[];
}): MailStore & { outcomes: [MailTable, string, MailOutcome][]; plans: TenantMailPlan[] } {
  const account = [...(queues.account ?? [])];
  const tenant = [...(queues.tenant ?? [])];
  const outcomes: [MailTable, string, MailOutcome][] = [];
  const plans: TenantMailPlan[] = [];
  return {
    outcomes,
    plans,
    settleExpiredClaims: async () => 0,
    expireOverdue: async () => 0,
    pruneSettled: async () => 0,
    gatherDueDigests: async () => 0,
    claimAccountMail: async () => account.shift() ?? null,
    claimTenantMail: async (plan): Promise<TenantMailClaim> => {
      const facts = tenant.shift();
      if (!facts) return { claimed: false, settled: false };
      const decided = plan(facts);
      plans.push(decided);
      if (decided.action !== 'send') return { claimed: false, settled: true };
      return {
        claimed: true,
        facts: { ...facts, attempts: facts.attempts + 1 },
        messageId: `<${facts.id}@ensemus.example.com>`,
        address: facts.member?.address ?? facts.invitation!.address,
        addressSha256: SHA,
      };
    },
    recordOutcome: async (table, id, outcome) => {
      outcomes.push([table, id, outcome]);
    },
  };
}

function deps(store: MailStore, send: (message: PlatformMessage) => Promise<AttemptResult>) {
  const sent: PlatformMessage[] = [];
  const value: MailDeps = {
    store,
    send: async (message) => {
      sent.push(message);
      return send(message);
    },
    openLink,
    log: { info: () => undefined, warn: () => undefined },
    sender: { fromAddress: 'ensemus@example.com', fromName: 'Ensemus' },
    publicUrl: URL,
    now: () => now,
    random: () => 0,
  };
  return { value, sent };
}

const accepted: AttemptResult = {
  outcome: 'accepted',
  code: 'ACCEPTED_BY_RELAY',
  providerStatus: 250,
};

const resetMail = (): ClaimedAccountMail => {
  const id = '55555555-5555-4555-8555-555555555555';
  return {
    id,
    kind: 'password_reset',
    attempts: 1,
    address: 'ada@example.com',
    addressSha256: SHA,
    recipientName: 'Ada',
    link: seal(JSON.stringify({ link: `${URL}/reset-password/secret-token` }), {
      organizationId: ACCOUNT_MAIL_SCOPE,
      secretId: id,
      purpose: MAIL_LINK_PURPOSE,
    }),
    messageId: `<${id}@ensemus.example.com>`,
  };
};

describe('where an attempt leaves a message', () => {
  const at = (result: Parameters<typeof outcomeOf>[0], attempts = 1) =>
    outcomeOf(result, attempts, SHA, now, () => 0);

  it('is sent when the relay took it, and unknown when nobody can tell', () => {
    expect(at({ ok: true, value: accepted })).toEqual({ status: 'sent' });
    expect(
      at({ ok: true, value: { outcome: 'indeterminate', code: 'TIMEOUT_AFTER_COMMIT' } }),
    ).toEqual({ status: 'unknown', code: 'TIMEOUT_AFTER_COMMIT' });
  });

  it('waits and tries again only when nothing was taken and trying later could work', () => {
    expect(at({ ok: false, error: new NotSent('CONNECT_FAILED', true) })).toEqual({
      status: 'queued',
      code: 'CONNECT_FAILED',
      retryAt: new Date(now.getTime() + 30_000),
    });
    expect(at({ ok: false, error: new NotSent('CONNECT_FAILED', true) }, 6)).toEqual({
      status: 'failed',
      code: 'TOO_MANY_ATTEMPTS',
    });
    expect(at({ ok: false, error: new NotSent('TLS_REQUIRED', false) })).toEqual({
      status: 'failed',
      code: 'TLS_REQUIRED',
    });
  });

  it('calls a refused address a bounce, and a busy relay a wait', () => {
    expect(
      at({ ok: false, error: new RefusedBeforeCommit('RECIPIENT_REFUSED', false, 550) }),
    ).toEqual({
      status: 'bounced',
      code: 'RECIPIENT_REFUSED',
      addressSha256: SHA,
      providerStatus: 550,
    });
    expect(
      at({ ok: false, error: new RefusedBeforeCommit('RELAY_BUSY', true, 451) }),
    ).toMatchObject({ status: 'queued', providerStatus: 451 });
  });

  it('tries again after a temporary refusal at the end, and gives up after a permanent one', () => {
    expect(
      at({
        ok: true,
        value: { outcome: 'rejected', code: 'REFUSED_BY_PROVIDER', providerStatus: 452 },
      }),
    ).toMatchObject({ status: 'queued' });
    expect(
      at({
        ok: true,
        value: { outcome: 'rejected', code: 'REFUSED_BY_PROVIDER', providerStatus: 554 },
      }),
    ).toEqual({ status: 'failed', code: 'REFUSED_BY_PROVIDER', providerStatus: 554 });
  });

  it('never trusts a code it did not make', () => {
    expect(at({ ok: false, error: new Error('relay said: 550 <ada@example.com> no') })).toEqual({
      status: 'failed',
      code: 'CONNECT_FAILED',
    });
  });
});

describe('a pass', () => {
  it('opens a reset link with the key, sends it, and records it sent', async () => {
    const store = fakeStore({ account: [resetMail()] });
    const { value, sent } = deps(store, async () => accepted);
    expect(await runMailPass(value)).toEqual({ sent: 1, settled: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.data).toContain(`${URL}/reset-password/secret-token`);
    expect(sent[0]!.data).not.toContain('List-Unsubscribe');
    expect(store.outcomes).toEqual([['account', resetMail().id, { status: 'sent' }]]);
  });

  it('fails a message whose link was moved to another row, and sends nothing', async () => {
    const moved = { ...resetMail(), id: '66666666-6666-4666-8666-666666666666' };
    const store = fakeStore({ account: [moved] });
    const { value, sent } = deps(store, async () => accepted);
    await runMailPass(value);
    expect(sent).toHaveLength(0);
    expect(store.outcomes[0]![2]).toEqual({ status: 'failed', code: 'LINK_UNAVAILABLE' });
  });

  it('gives chosen mail a one-click unsubscribe, and essential mail none', async () => {
    const member = {
      membershipId: '44444444-4444-4444-8444-444444444444',
      name: 'Ada',
      address: 'ada@example.com',
      addressVerified: true,
      active: true,
    };
    const facts = (kind: string, id: string): TenantMailFacts => ({
      id,
      organizationId: '11111111-1111-4111-8111-111111111111',
      kind: 'notification',
      attempts: 0,
      sendBefore: new Date('2026-11-15T00:00:00Z'),
      organization: { name: 'Northwind', lifecycle: 'active' },
      member,
      invitation: null,
      notification: { kind, targetRef: 'approval:x', reminderNumber: null, read: false },
      digest: null,
      preference: null,
      bounced: false,
      recentToMember: 0,
      recentForOrganization: 0,
    });
    const store = fakeStore({
      tenant: [
        facts('approval.requested', '77777777-7777-4777-8777-777777777777'),
        facts('break_glass.requested', '88888888-8888-4888-8888-888888888888'),
      ],
    });
    const { value, sent } = deps(store, async () => accepted);
    expect(await runMailPass(value)).toEqual({ sent: 2, settled: 0 });
    expect(sent[0]!.data).toMatch(
      /List-Unsubscribe: <https:\/\/ensemus\.example\.com\/api\/mail\/unsubscribe\/[A-Za-z0-9_-]{43}>/,
    );
    expect(sent[1]!.data).not.toContain('List-Unsubscribe');
    expect(store.plans[0]).toMatchObject({ action: 'send', unsubscribe: { topic: 'approvals' } });
    expect(store.plans[1]).toEqual({ action: 'send', unsubscribe: null });
  });

  it('records a refusal and keeps going', async () => {
    const store = fakeStore({ account: [resetMail(), { ...resetMail(), id: resetMail().id }] });
    let calls = 0;
    const { value } = deps(store, async () => {
      calls += 1;
      if (calls === 1) throw new RefusedBeforeCommit('RECIPIENT_REFUSED', false, 550);
      return accepted;
    });
    await runMailPass(value);
    expect(store.outcomes.map(([, , outcome]) => outcome.status)).toEqual(['bounced', 'sent']);
  });
});
