// For the mail worker only (enforced by lint). The ensemus_mailer role crosses tenants, as the dispatcher
// does, and reads only what an email needs (0571). Every transaction checks restore admission first, and
// 0571's restrictive policies hold that for any query here too. A message's claim is committed before the
// relay is contacted, so a crash leaves a trace and never a second send (ADR-027 D2).
import { sql } from 'drizzle-orm';
import { openDatabase, type EnsemusDrizzle } from './connection';
import { assertRestoreAdmission } from './restore-authority';
import type { Tx } from './tenant';

export function openMailerDatabase(url: string) {
  return openDatabase(url, { max: 4 });
}

export type MailerDb = EnsemusDrizzle;

export type SealedLink = {
  keyId: string;
  wrappedKey: Buffer;
  iv: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
};

export type MailTable = 'account' | 'tenant';
const TABLE = {
  account: sql.raw('platform.account_mail_outbox'),
  tenant: sql.raw('platform.mail_outbox'),
} as const;

function inMailerTx<T>(db: MailerDb, fn: (tx: Tx) => Promise<T>, organizationId?: string) {
  return db.transaction(async (tx) => {
    await assertRestoreAdmission(tx);
    // Tenant rows are born only with their tenant bound (0533), as any other tenant table's are.
    if (organizationId)
      await tx.execute(sql`select set_config('app.organization_id', ${organizationId}, true)`);
    return fn(tx);
  });
}

const sealedOf = (row: {
  link_key_id: string | null;
  link_wrapped_key: Buffer | null;
  link_iv: Buffer | null;
  link_ciphertext: Buffer | null;
  link_auth_tag: Buffer | null;
}): SealedLink | null =>
  row.link_key_id && row.link_wrapped_key && row.link_iv && row.link_ciphertext && row.link_auth_tag
    ? {
        keyId: row.link_key_id,
        wrappedKey: row.link_wrapped_key,
        iv: row.link_iv,
        ciphertext: row.link_ciphertext,
        authTag: row.link_auth_tag,
      }
    : null;

/** The deterministic Message-ID, the same on every try, so someone can search the relay's log for it. */
export const mailMessageId = (id: string, domain: string) => `<${id}@${domain}>`;

// --- Housekeeping

/**
 * A claim held longer than the lease belongs to a worker that died or hung after it may have spoken to
 * the relay. Nobody can know whether it went, so it is `unknown`, and it is never sent again.
 */
export async function settleExpiredClaims(db: MailerDb, leaseMs: number): Promise<number> {
  let settled = 0;
  for (const table of ['account', 'tenant'] as const) {
    settled += await inMailerTx(db, async (tx) => {
      const result = await tx.execute(sql`
        update ${TABLE[table]} set status = 'unknown', last_code = 'LEASE_EXPIRED'
         where status = 'sending' and claimed_at < now() - make_interval(secs => ${leaseMs / 1000})`);
      return result.rowCount ?? 0;
    });
  }
  return settled;
}

/** A message whose link has stopped working, or that is no longer news, is not sent late. */
export async function expireOverdue(db: MailerDb): Promise<number> {
  let expired = 0;
  for (const table of ['account', 'tenant'] as const) {
    expired += await inMailerTx(db, async (tx) => {
      const result = await tx.execute(sql`
        update ${TABLE[table]} set status = 'expired', last_code = 'EXPIRED'
         where status = 'queued' and send_before <= now()`);
      return result.rowCount ?? 0;
    });
  }
  return expired;
}

/** Settled messages are kept thirty days, and spent unsubscribe tokens until they expire. */
export async function pruneSettled(db: MailerDb): Promise<number> {
  return inMailerTx(db, async (tx) => {
    let pruned = 0;
    for (const table of ['account', 'tenant'] as const) {
      const result = await tx.execute(sql`
        delete from ${TABLE[table]}
         where status not in ('queued','sending','held') and updated_at < now() - interval '30 days'`);
      pruned += result.rowCount ?? 0;
    }
    const tokens = await tx.execute(
      sql`delete from platform.mail_unsubscribe_tokens where expires_at < now()`,
    );
    return pruned + (tokens.rowCount ?? 0);
  });
}

// --- Outcomes

export type MailOutcome =
  | { status: 'sent' }
  | { status: 'queued'; code: string; providerStatus?: number; retryAt: Date }
  | { status: 'failed' | 'unknown'; code: string; providerStatus?: number }
  | { status: 'bounced'; code: string; providerStatus?: number; addressSha256: string };

/**
 * Records what the relay said. A bounce also keeps notification mail away from that address until it is
 * proven again. The database erases the link and the address as the message settles.
 */
export async function recordOutcome(
  db: MailerDb,
  table: MailTable,
  id: string,
  outcome: MailOutcome,
): Promise<void> {
  await inMailerTx(db, async (tx) => {
    const status = outcome.status;
    const code = 'code' in outcome ? outcome.code : null;
    const providerStatus = 'providerStatus' in outcome ? (outcome.providerStatus ?? null) : null;
    const retryAt = outcome.status === 'queued' ? outcome.retryAt.toISOString() : null;
    await tx.execute(sql`
      update ${TABLE[table]}
         set status = ${status},
             last_code = coalesce(${code}, last_code),
             provider_status = ${providerStatus}::integer,
             next_attempt_at = coalesce(${retryAt}::timestamptz, next_attempt_at)
       where id = ${id}::uuid
         and (status = 'sending' or (status = 'unknown' and ${status} = 'sent'))`);
    if (outcome.status === 'bounced')
      await tx.execute(sql`
        insert into platform.mail_suppressions (address_sha256, reason)
        values (${outcome.addressSha256}, 'RECIPIENT_REFUSED') on conflict do nothing`);
  });
}

// --- Account mail

export type ClaimedAccountMail = {
  id: string;
  kind: string;
  attempts: number;
  address: string;
  addressSha256: string;
  recipientName: string;
  link: SealedLink | null;
  messageId: string;
};

/** Claims the next account message that is due, or answers null. */
export async function claimAccountMail(
  db: MailerDb,
  messageIdDomain: string,
): Promise<ClaimedAccountMail | null> {
  return inMailerTx(db, async (tx) => {
    const picked = await tx.execute<{ id: string }>(sql`
      select id from platform.account_mail_outbox
       where status = 'queued' and next_attempt_at <= now() and send_before > now()
       order by next_attempt_at limit 1 for update skip locked`);
    const id = picked.rows[0]?.id;
    if (!id) return null;
    const claimed = await tx.execute<{
      id: string;
      kind: string;
      attempts: number;
      recipient_address: string;
      recipient_sha256: string;
      recipient_user_id: string;
      link_key_id: string | null;
      link_wrapped_key: Buffer | null;
      link_iv: Buffer | null;
      link_ciphertext: Buffer | null;
      link_auth_tag: Buffer | null;
      message_id: string;
    }>(sql`
      update platform.account_mail_outbox
         set status = 'sending', attempts = attempts + 1, message_id = ${mailMessageId(id, messageIdDomain)}
       where id = ${id}::uuid
      returning id, kind, attempts, recipient_address, recipient_sha256, recipient_user_id, link_key_id,
                link_wrapped_key, link_iv, link_ciphertext, link_auth_tag, message_id`);
    const row = claimed.rows[0]!;
    const user = await tx.execute<{ name: string }>(
      sql`select name from identity.users where id = ${row.recipient_user_id}::uuid`,
    );
    return {
      id: row.id,
      kind: row.kind,
      attempts: row.attempts,
      address: row.recipient_address,
      addressSha256: row.recipient_sha256,
      recipientName: user.rows[0]?.name ?? '',
      link: sealedOf(row),
      messageId: row.message_id,
    };
  });
}

// --- Tenant mail

export type TenantMailFacts = {
  id: string;
  organizationId: string;
  kind: 'invitation' | 'notification' | 'digest';
  attempts: number;
  sendBefore: Date;
  organization: { name: string; lifecycle: string } | null;
  /** A member's, for a notification or a digest. */
  member: {
    membershipId: string;
    name: string;
    address: string;
    addressVerified: boolean;
    active: boolean;
  } | null;
  /** An invitation's own address, and whether it can still be accepted. */
  invitation: {
    address: string;
    open: boolean;
    inviterName: string;
    link: SealedLink | null;
  } | null;
  notification: {
    kind: string;
    targetRef: string;
    reminderNumber: number | null;
    read: boolean;
  } | null;
  /** A digest's topic, and what it gathered, by notification kind. */
  digest: { topic: string; items: { kind: string; count: number }[] } | null;
  /** The person's choice for this message's topic, if they made one. */
  preference: string | null;
  /** The address refused a message outright before. */
  bounced: boolean;
  /** Messages to this member, and from this tenant, claimed in the last hour. */
  recentToMember: number;
  recentForOrganization: number;
};

export type TenantMailPlan =
  | { action: 'send'; unsubscribe: { topic: string; tokenSha256: string } | null }
  | { action: 'hold'; digestDueAt: Date }
  | { action: 'settle'; status: 'skipped' | 'suppressed'; code: string };

export type TenantMailClaim =
  | { claimed: false; settled: boolean }
  | {
      claimed: true;
      facts: TenantMailFacts;
      messageId: string;
      address: string;
      addressSha256: string;
    };

type TenantRow = {
  id: string;
  organization_id: string;
  kind: 'invitation' | 'notification' | 'digest';
  attempts: number;
  send_before: Date;
  recipient_membership_id: string | null;
  recipient_address: string | null;
  notification_id: string | null;
  notification_kind: string | null;
  target_ref: string | null;
  reminder_number: number | null;
  invitation_id: string | null;
  link_key_id: string | null;
  link_wrapped_key: Buffer | null;
  link_iv: Buffer | null;
  link_ciphertext: Buffer | null;
  link_auth_tag: Buffer | null;
};

/** The SHA-256 of a lower-cased address, as 0571 computes it. */
async function addressSha256(tx: Tx, address: string): Promise<string> {
  const result = await tx.execute<{ h: string }>(
    sql`select encode(sha256(convert_to(lower(btrim(${address})),'UTF8')),'hex') as h`,
  );
  return result.rows[0]!.h;
}

async function gatherFacts(
  tx: Tx,
  row: TenantRow,
  topicOf: (row: {
    kind: string;
    notificationKind: string | null;
    targetRef: string | null;
  }) => string | null,
): Promise<{ facts: TenantMailFacts; address: string | null }> {
  const org = await tx.execute<{ name: string; lifecycle: string }>(
    sql`select name, lifecycle from org.organizations where id = ${row.organization_id}::uuid`,
  );
  let member: TenantMailFacts['member'] = null;
  if (row.recipient_membership_id) {
    const found = await tx.execute<{
      status: string;
      name: string;
      email: string;
      email_verified: boolean;
    }>(sql`
      select m.status, u.name, u.email, u.email_verified
        from org.memberships m join identity.users u on u.id = m.user_id
       where m.organization_id = ${row.organization_id}::uuid and m.id = ${row.recipient_membership_id}::uuid`);
    const m = found.rows[0];
    if (m)
      member = {
        membershipId: row.recipient_membership_id,
        name: m.name,
        address: m.email,
        addressVerified: m.email_verified,
        active: m.status === 'active',
      };
  }
  let invitation: TenantMailFacts['invitation'] = null;
  if (row.kind === 'invitation' && row.invitation_id) {
    const found = await tx.execute<{ open: boolean; inviter: string | null }>(sql`
      select (i.accepted_at is null and i.revoked_at is null and i.expires_at > now()) as open,
             (select u.name from org.memberships m join identity.users u on u.id = m.user_id
               where m.organization_id = i.organization_id and m.id = i.invited_by_membership_id) as inviter
        from org.invitations i
       where i.organization_id = ${row.organization_id}::uuid and i.id = ${row.invitation_id}::uuid`);
    const i = found.rows[0];
    invitation = {
      address: row.recipient_address ?? '',
      open: Boolean(i?.open) && row.recipient_address !== null,
      inviterName: i?.inviter ?? '',
      link: sealedOf(row),
    };
  }
  let notification: TenantMailFacts['notification'] = null;
  if (row.kind === 'notification' && row.notification_id) {
    const found = await tx.execute<{ read: boolean }>(sql`
      select read_at is not null as read from platform.notifications
       where organization_id = ${row.organization_id}::uuid and id = ${row.notification_id}::uuid`);
    notification = {
      kind: row.notification_kind ?? '',
      targetRef: row.target_ref ?? '',
      reminderNumber: row.reminder_number,
      // A notification erased since is as good as read: there is nothing left to tell anyone about.
      read: found.rows[0]?.read ?? true,
    };
  }
  let digest: TenantMailFacts['digest'] = null;
  if (row.kind === 'digest') {
    const items = await tx.execute<{ kind: string; count: number }>(sql`
      select notification_kind as kind, count(*)::int as count from platform.mail_outbox
       where organization_id = ${row.organization_id}::uuid and digest_id = ${row.id}::uuid
       group by notification_kind order by count(*) desc, notification_kind`);
    digest = { topic: (row.target_ref ?? '').replace(/^topic:/, ''), items: items.rows };
  }
  const topic = topicOf({
    kind: row.kind,
    notificationKind: row.notification_kind,
    targetRef: row.target_ref,
  });
  let preference: string | null = null;
  if (topic && row.recipient_membership_id) {
    const found = await tx.execute<{ delivery: string }>(sql`
      select delivery from org.notification_preferences
       where organization_id = ${row.organization_id}::uuid
         and membership_id = ${row.recipient_membership_id}::uuid and topic = ${topic}`);
    preference = found.rows[0]?.delivery ?? null;
  }
  const address = member?.address ?? invitation?.address ?? null;
  let bounced = false;
  if (address) {
    const found = await tx.execute(sql`
      select 1 from platform.mail_suppressions where address_sha256 = ${await addressSha256(tx, address)}`);
    bounced = found.rows.length > 0;
  }
  const counts = await tx.execute<{ member: number; org: number }>(sql`
    select count(*) filter (where recipient_membership_id is not distinct from ${row.recipient_membership_id}::uuid)::int as member,
           count(*)::int as org
      from platform.mail_outbox
     where organization_id = ${row.organization_id}::uuid and id <> ${row.id}::uuid
       and status in ('sending','sent','unknown') and claimed_at > now() - interval '1 hour'`);
  return {
    address,
    facts: {
      id: row.id,
      organizationId: row.organization_id,
      kind: row.kind,
      attempts: row.attempts,
      sendBefore: row.send_before,
      organization: org.rows[0] ?? null,
      member,
      invitation,
      notification,
      digest,
      preference,
      bounced,
      recentToMember: counts.rows[0]?.member ?? 0,
      recentForOrganization: counts.rows[0]?.org ?? 0,
    },
  };
}

/**
 * Takes the next tenant message that is due, looks up what is true now, and asks `plan` what to do. A
 * message to send is claimed, with an unsubscribe token when it can carry one, and the claim committed
 * before anything is sent. Anything else settles here. Answers `claimed: false` with nothing due.
 */
export async function claimTenantMail(
  db: MailerDb,
  options: {
    messageIdDomain: string;
    topicOf: (row: {
      kind: string;
      notificationKind: string | null;
      targetRef: string | null;
    }) => string | null;
    plan: (facts: TenantMailFacts) => TenantMailPlan;
    /** Unsubscribe tokens stay good this long. */
    unsubscribeDays: number;
  },
): Promise<TenantMailClaim> {
  const picked = await inMailerTx(db, async (tx) => {
    const found = await tx.execute<{ id: string; organization_id: string }>(sql`
      select id, organization_id from platform.mail_outbox
       where status = 'queued' and next_attempt_at <= now() and send_before > now()
       order by next_attempt_at limit 1`);
    return found.rows[0] ?? null;
  });
  if (!picked) return { claimed: false, settled: false };
  return inMailerTx(
    db,
    async (tx): Promise<TenantMailClaim> => {
      const locked = await tx.execute<TenantRow>(sql`
        select id, organization_id, kind, attempts, send_before, recipient_membership_id, recipient_address,
               notification_id, notification_kind, target_ref, reminder_number, invitation_id, link_key_id,
               link_wrapped_key, link_iv, link_ciphertext, link_auth_tag
          from platform.mail_outbox
         where id = ${picked.id}::uuid and status = 'queued' and next_attempt_at <= now() and send_before > now()
         for update skip locked`);
      const row = locked.rows[0];
      // Another worker has it, or it moved since: the next pass picks whatever is next.
      if (!row) return { claimed: false, settled: true };
      const { facts, address } = await gatherFacts(tx, row, options.topicOf);
      const plan = options.plan(facts);
      if (plan.action === 'settle') {
        await tx.execute(sql`
          update platform.mail_outbox set status = ${plan.status}, last_code = ${plan.code}
           where id = ${row.id}::uuid`);
        return { claimed: false, settled: true };
      }
      if (plan.action === 'hold') {
        await tx.execute(sql`
          update platform.mail_outbox set status = 'held', digest_due_at = ${plan.digestDueAt.toISOString()}::timestamptz
           where id = ${row.id}::uuid`);
        return { claimed: false, settled: true };
      }
      if (!address) {
        await tx.execute(sql`
          update platform.mail_outbox set status = 'skipped', last_code = 'RECIPIENT_GONE'
           where id = ${row.id}::uuid`);
        return { claimed: false, settled: true };
      }
      const sha = await addressSha256(tx, address);
      const messageId = mailMessageId(row.id, options.messageIdDomain);
      await tx.execute(sql`
        update platform.mail_outbox
           set status = 'sending', attempts = attempts + 1, message_id = ${messageId},
               recipient_sha256 = coalesce(recipient_sha256, ${sha})
         where id = ${row.id}::uuid`);
      if (plan.unsubscribe && facts.member)
        await tx.execute(sql`
          insert into platform.mail_unsubscribe_tokens
            (token_sha256, organization_id, membership_id, topic, expires_at)
          values (${plan.unsubscribe.tokenSha256}, ${row.organization_id}::uuid,
                  ${facts.member.membershipId}::uuid, ${plan.unsubscribe.topic},
                  now() + make_interval(days => ${options.unsubscribeDays}))`);
      return {
        claimed: true,
        facts: { ...facts, attempts: row.attempts + 1 },
        messageId,
        address,
        addressSha256: sha,
      };
    },
    picked.organization_id,
  );
}

// --- Digests

/**
 * Gathers what each member asked to hear about once a day into one digest per topic. What they have
 * already opened in Ensemus is left out, and a member with nothing unread gets nothing.
 */
export async function gatherDueDigests(
  db: MailerDb,
  topicOf: (notificationKind: string) => string,
  limit = 50,
): Promise<number> {
  const due = await inMailerTx(db, async (tx) => {
    const found = await tx.execute<{
      organization_id: string;
      recipient_membership_id: string;
    }>(sql`
      select distinct organization_id, recipient_membership_id from platform.mail_outbox
       where status = 'held' and digest_due_at <= now() limit ${limit}`);
    return found.rows;
  });
  let made = 0;
  for (const pair of due) {
    made += await inMailerTx(
      db,
      async (tx) => {
        const held = await tx.execute<{
          id: string;
          notification_kind: string;
          digest_due_at: Date;
          read: boolean;
        }>(sql`
          select o.id, o.notification_kind, o.digest_due_at,
                 coalesce((select n.read_at is not null from platform.notifications n
                            where n.organization_id = o.organization_id and n.id = o.notification_id), true) as read
            from platform.mail_outbox o
           where o.organization_id = ${pair.organization_id}::uuid
             and o.recipient_membership_id = ${pair.recipient_membership_id}::uuid
             and o.status = 'held' and o.digest_due_at <= now()
           for update of o skip locked`);
        const unread = held.rows.filter((row) => !row.read);
        const read = held.rows.filter((row) => row.read);
        if (read.length)
          await tx.execute(sql`
            update platform.mail_outbox set status = 'skipped', last_code = 'ALREADY_READ'
             where id in (${sql.join(
               read.map((row) => sql`${row.id}::uuid`),
               sql`, `,
             )})`);
        const byTopic = new Map<string, typeof unread>();
        for (const row of unread) {
          const topic = topicOf(row.notification_kind);
          byTopic.set(topic, [...(byTopic.get(topic) ?? []), row]);
        }
        let digests = 0;
        for (const [topic, rows] of byTopic) {
          const day = rows
            .map((row) => new Date(row.digest_due_at).toISOString().slice(0, 13))
            .sort()[0];
          const base = `digest:${pair.organization_id}:${pair.recipient_membership_id}:${topic}:${day}`;
          // Joins the digest already made for this hour while it waits, and makes another once it has gone,
          // so a late arrival is never folded into a message that was already sent.
          const existing = await tx.execute<{ id: string; status: string }>(sql`
            select id, status from platform.mail_outbox where idempotency_key = ${base}`);
          const current = existing.rows[0];
          let id = current?.status === 'queued' ? current.id : undefined;
          if (!id) {
            const key = current ? `${base}:${rows[0]!.id}` : base;
            const inserted = await tx.execute<{ id: string }>(sql`
              insert into platform.mail_outbox (organization_id, kind, idempotency_key, recipient_membership_id,
                target_ref, send_before, next_attempt_at)
              values (${pair.organization_id}::uuid, 'digest', ${key}, ${pair.recipient_membership_id}::uuid,
                ${`topic:${topic}`}, now() + interval '2 days', now())
              on conflict (idempotency_key) do nothing returning id`);
            id = inserted.rows[0]?.id;
          }
          if (!id) continue;
          await tx.execute(sql`
            update platform.mail_outbox set status = 'digested', digest_id = ${id}::uuid
             where id in (${sql.join(
               rows.map((row) => sql`${row.id}::uuid`),
               sql`, `,
             )})`);
          digests += 1;
        }
        return digests;
      },
      pair.organization_id,
    );
  }
  return made;
}
