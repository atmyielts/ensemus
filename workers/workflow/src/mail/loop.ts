// One pass of the mail worker: settle claims a dead worker left, expire what waited too long, gather
// digests, then send what is due, one message at a time. The outbox row is the durable state and the
// claim is committed before the relay is contacted (ADR-027 D2): only a refusal before the commit point is
// tried again, with a growing wait, and silence after it is `unknown`, never a second send.
import { createHash, randomBytes } from 'node:crypto';
import type {
  ClaimedAccountMail,
  MailOutcome,
  MailTable,
  SealedLink,
  TenantMailClaim,
  TenantMailPlan,
  TenantMailFacts,
} from '@ensemus/database/mailer';
import type { AttemptResult } from '@ensemus/domain/external-action';
import {
  ACCOUNT_MAIL_SCOPE,
  MAIL_LINK_PURPOSE,
  MAIL_SEND_LEASE_MS,
  MAX_MAIL_ATTEMPTS,
  mailRetryDelayMs,
} from '@ensemus/domain/mail';
import { renderMail, type MailContent } from '@ensemus/domain/mail-templates';
import { buildPlatformMessage, UnsafeMessage, type PlatformMessage } from './mime';
import {
  accountMailContent,
  parseSealedPayload,
  planTenantMail,
  tenantMailContent,
  unsubscribeOneClickUrl,
  type SealedPayload,
} from './plan';

export type MailStore = {
  settleExpiredClaims(leaseMs: number): Promise<number>;
  expireOverdue(): Promise<number>;
  pruneSettled(): Promise<number>;
  gatherDueDigests(): Promise<number>;
  claimAccountMail(): Promise<ClaimedAccountMail | null>;
  claimTenantMail(plan: (facts: TenantMailFacts) => TenantMailPlan): Promise<TenantMailClaim>;
  recordOutcome(table: MailTable, id: string, outcome: MailOutcome): Promise<void>;
};

/** Sends one message, or throws an error with a `code` and `retryable` before the commit point. */
export type MailTransport = (message: PlatformMessage) => Promise<AttemptResult>;

/** Opens a sealed link, or throws. Bound to the message, its tenant and the link purpose. */
export type LinkOpener = (
  sealed: SealedLink,
  binding: { organizationId: string; secretId: string; purpose: string },
) => Buffer;

export type MailLog = {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
};

export type MailDeps = {
  store: MailStore;
  send: MailTransport;
  openLink: LinkOpener;
  log: MailLog;
  sender: { fromAddress: string; fromName: string };
  publicUrl: string;
  now?: () => Date;
  random?: () => number;
};

/** At most this many of each per pass, so one busy queue never starves the other or the housekeeping. */
const ACCOUNT_BATCH = 20;
const TENANT_BATCH = 50;

/** Where the relay's answer, or the refusal before it, leaves a message. Pure. */
export function outcomeOf(
  result: { ok: true; value: AttemptResult } | { ok: false; error: unknown },
  attempts: number,
  addressSha256: string,
  now: Date,
  random: () => number = Math.random,
): MailOutcome {
  if (result.ok) {
    const { value } = result;
    if (value.outcome === 'accepted') return { status: 'sent' };
    if (value.outcome === 'indeterminate') return { status: 'unknown', code: value.code };
    const status = value.providerStatus;
    if (value.outcome === 'rejected') {
      // A temporary refusal at the end of the message is still a refusal: nothing was taken.
      if (status !== undefined && status >= 400 && status < 500 && attempts < MAX_MAIL_ATTEMPTS)
        return retry(value.code, attempts, now, random, status);
      return { status: 'failed', code: value.code, ...(status ? { providerStatus: status } : {}) };
    }
    // not_sent, returned with the relay's status.
    return notSent(
      value.code,
      value.retryable === true,
      attempts,
      addressSha256,
      now,
      random,
      status,
    );
  }
  const error = result.error as { code?: unknown; retryable?: unknown; providerStatus?: unknown };
  if (error instanceof UnsafeMessage) return { status: 'failed', code: 'UNSAFE_MESSAGE' };
  const code =
    typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.code)
      ? error.code
      : 'CONNECT_FAILED';
  const providerStatus =
    typeof error?.providerStatus === 'number' ? error.providerStatus : undefined;
  return notSent(
    code,
    error?.retryable === true,
    attempts,
    addressSha256,
    now,
    random,
    providerStatus,
  );
}

function retry(
  code: string,
  attempts: number,
  now: Date,
  random: () => number,
  providerStatus?: number,
): MailOutcome {
  return {
    status: 'queued',
    code,
    retryAt: new Date(now.getTime() + mailRetryDelayMs(attempts, random)),
    ...(providerStatus ? { providerStatus } : {}),
  };
}

function notSent(
  code: string,
  retryable: boolean,
  attempts: number,
  addressSha256: string,
  now: Date,
  random: () => number,
  providerStatus?: number,
): MailOutcome {
  const status = providerStatus ? { providerStatus } : {};
  // The relay said this address does not take mail. That is a bounce, and it is not tried again.
  if (code === 'RECIPIENT_REFUSED' && !retryable)
    return { status: 'bounced', code, addressSha256, ...status };
  if (retryable && attempts < MAX_MAIL_ATTEMPTS)
    return retry(code, attempts, now, random, providerStatus);
  return { status: 'failed', code: retryable ? 'TOO_MANY_ATTEMPTS' : code, ...status };
}

function render(
  deps: MailDeps,
  to: string,
  messageId: string,
  content: MailContent,
  unsubscribeToken: string | null,
  now: Date,
): PlatformMessage {
  const mail = renderMail(content);
  return buildPlatformMessage({
    fromAddress: deps.sender.fromAddress,
    fromName: deps.sender.fromName,
    to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    messageId,
    date: now,
    unsubscribeUrl: unsubscribeToken
      ? unsubscribeOneClickUrl(deps.publicUrl, unsubscribeToken)
      : null,
  });
}

function openPayload(
  deps: MailDeps,
  sealed: SealedLink | null,
  binding: { organizationId: string; secretId: string },
): SealedPayload | null {
  if (!sealed) return null;
  let plaintext: Buffer | undefined;
  try {
    plaintext = deps.openLink(sealed, { ...binding, purpose: MAIL_LINK_PURPOSE });
    return parseSealedPayload(plaintext, deps.publicUrl);
  } catch {
    return null;
  } finally {
    plaintext?.fill(0);
  }
}

async function attempt(
  deps: MailDeps,
  table: MailTable,
  id: string,
  attempts: number,
  addressSha256: string,
  build: () => PlatformMessage | null,
): Promise<MailOutcome['status']> {
  const now = deps.now?.() ?? new Date();
  let message: PlatformMessage | null;
  try {
    message = build();
  } catch (error) {
    message = null;
    if (!(error instanceof UnsafeMessage)) throw error;
  }
  let outcome: MailOutcome;
  if (!message) {
    // Nothing went: the message could not be put together. It never will be, so it is not tried again.
    outcome = { status: 'failed', code: 'LINK_UNAVAILABLE' };
  } else {
    let result: { ok: true; value: AttemptResult } | { ok: false; error: unknown };
    try {
      result = { ok: true, value: await deps.send(message) };
    } catch (error) {
      result = { ok: false, error };
    }
    outcome = outcomeOf(result, attempts, addressSha256, now, deps.random);
  }
  await deps.store.recordOutcome(table, id, outcome);
  deps.log.info('mail.attempted', {
    table,
    outcome: outcome.status,
    ...('code' in outcome ? { code: outcome.code } : {}),
  });
  return outcome.status;
}

async function sendAccount(deps: MailDeps, claimed: ClaimedAccountMail) {
  const now = deps.now?.() ?? new Date();
  return attempt(deps, 'account', claimed.id, claimed.attempts, claimed.addressSha256, () => {
    const payload = openPayload(deps, claimed.link, {
      organizationId: ACCOUNT_MAIL_SCOPE,
      secretId: claimed.id,
    });
    const content = accountMailContent(
      claimed.kind,
      claimed.recipientName,
      payload,
      deps.publicUrl,
    );
    return content ? render(deps, claimed.address, claimed.messageId, content, null, now) : null;
  });
}

async function sendTenant(
  deps: MailDeps,
  claim: Extract<TenantMailClaim, { claimed: true }>,
  /** Only when the plan gave this message an unsubscribe link: essential mail has none. */
  unsubscribeToken: string | null,
) {
  const now = deps.now?.() ?? new Date();
  const { facts } = claim;
  return attempt(deps, 'tenant', facts.id, facts.attempts, claim.addressSha256, () => {
    const invitationLink =
      facts.kind === 'invitation'
        ? (openPayload(deps, facts.invitation?.link ?? null, {
            organizationId: facts.organizationId,
            secretId: facts.id,
          })?.link ?? null)
        : null;
    const content = tenantMailContent(facts, {
      publicUrl: deps.publicUrl,
      unsubscribeToken,
      invitationLink,
    });
    return content
      ? render(deps, claim.address, claim.messageId, content, unsubscribeToken, now)
      : null;
  });
}

export function newUnsubscribeToken(): { token: string; sha256: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, sha256: createHash('sha256').update(token).digest('hex') };
}

export type PassResult = { sent: number; settled: number };

/** One pass. Safe to run on several workers at once: every claim is a row lock taken with SKIP LOCKED. */
export async function runMailPass(deps: MailDeps): Promise<PassResult> {
  const { store } = deps;
  let sent = 0;
  let settled = await store.settleExpiredClaims(MAIL_SEND_LEASE_MS);
  if (settled) deps.log.warn('mail.claims_expired', { count: settled });
  settled += await store.expireOverdue();
  await store.gatherDueDigests();

  for (let i = 0; i < ACCOUNT_BATCH; i++) {
    const claimed = await store.claimAccountMail();
    if (!claimed) break;
    if ((await sendAccount(deps, claimed)) === 'sent') sent += 1;
  }

  for (let i = 0; i < TENANT_BATCH; i++) {
    const unsubscribe = newUnsubscribeToken();
    const decided = { unsubscribe: false };
    const claim = await store.claimTenantMail((facts) => {
      const plan = planTenantMail(facts, {
        now: deps.now?.() ?? new Date(),
        unsubscribeTokenSha256: unsubscribe.sha256,
      });
      decided.unsubscribe = plan.action === 'send' && plan.unsubscribe !== null;
      return plan;
    });
    if (!claim.claimed) {
      if (!claim.settled) break;
      settled += 1;
      continue;
    }
    const status = await sendTenant(deps, claim, decided.unsubscribe ? unsubscribe.token : null);
    if (status === 'sent') sent += 1;
  }
  return { sent, settled };
}
