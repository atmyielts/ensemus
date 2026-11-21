// Platform email (0570, 0571), against real roles, RLS and triggers. FLAGGED FOR HUMAN SECURITY REVIEW,
// with the migration it tests. Who may queue what, how a message moves, that a link and an address are
// erased as a message settles, the limits, the notification and support-reply triggers, digests,
// preferences and unsubscribe links. Every address and key is a generated test value.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInvitation, notify } from '@ensemus/application';
import { openTicket } from '@ensemus/application/saas/support';
import { replyAsDesk } from '@ensemus/application/saas/support-desk';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  describeUnsubscribe,
  getMyNotificationPreferences,
  setMyNotificationPreferences,
  unsubscribeByToken,
} from '@ensemus/application/platform-mail';
import {
  createOrganization,
  notifications,
  openAppDatabase,
  resolveTenantContext,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { openAuthDatabase, queueAccountMail } from '@ensemus/database/auth';
import {
  claimAccountMail,
  claimTenantMail,
  gatherDueDigests,
  openMailerDatabase,
  recordOutcome,
  settleExpiredClaims,
  type TenantMailFacts,
} from '@ensemus/database/mailer';
import { ACCOUNT_MAIL_SCOPE, MAIL_LINK_PURPOSE, notificationTopicOf } from '@ensemus/domain/mail';
import { FileKeyProvider, openSealed } from '@ensemus/secrets/broker';
import { sealSecret } from '@ensemus/secrets/seal';
import { eq, sql } from 'drizzle-orm';
import { secret, urls } from '../helpers/stack';
import { newUnsubscribeToken } from '../../workers/workflow/src/mail/loop';
import { planTenantMail, topicOfMail } from '../../workers/workflow/src/mail/plan';

const DOMAIN = 'ensemus.example.invalid';

/** A database refusal's code, wherever the driver or the ORM put it in the chain of causes. */
async function refusedWith(work: Promise<unknown>, code: string) {
  const error = await work.then(
    () => null,
    (failure: unknown) => failure,
  );
  const codes: unknown[] = [];
  let link: unknown = error;
  for (let depth = 0; depth < 5 && link && typeof link === 'object'; depth++) {
    codes.push((link as { code?: unknown }).code);
    link = (link as { cause?: unknown }).cause;
  }
  expect(codes).toContain(code);
}
const PUBLIC_URL = 'https://ensemus.example.invalid';

describe('platform mail', () => {
  const app = openAppDatabase(urls.app(), { max: 4 });
  const authDb = openAuthDatabase(urls.auth());
  const mailer = openMailerDatabase(urls.mailer());
  const su = new pg.Client({ connectionString: urls.superuser() });
  const auth = new pg.Client({ connectionString: urls.auth() });
  const appClient = new pg.Client({ connectionString: urls.app() });
  const mailerClient = new pg.Client({ connectionString: urls.mailer() });
  const publicKeyPem = secret('sealing_public_key.pem');
  const keys = new FileKeyProvider([secret('sealing_private_key.pem')]);
  const seal = (input: {
    organizationId: string;
    secretId: string;
    purpose: string;
    plaintext: string;
  }) => sealSecret({ ...input, publicKeyPem });

  let owner: TenantContext;
  let member: TenantContext;
  let unverified: TenantContext;
  let memberAddress: string;
  let organizationId: string;

  const makeUser = async (
    label: string,
    options: { verified?: boolean; password?: boolean } = {},
  ) => {
    const id = randomUUID();
    const email = `${label}-${id}@example.invalid`;
    await auth.query(
      'insert into identity.users (id, name, email, email_verified) values ($1, $2, $3, $4)',
      [id, label, email, options.verified ?? false],
    );
    if (options.password !== false)
      await auth.query(
        `insert into identity.accounts (user_id, account_id, provider_id, password)
         values ($1, $1::text, 'credential', 'not-a-real-hash')`,
        [id],
      );
    return { id, email };
  };

  const addMember = async (label: string, verified: boolean) => {
    const user = await makeUser(label, { verified });
    await withTenantTx(app.db, owner, (tx) =>
      tx.execute(
        sql`insert into org.memberships (organization_id, user_id, role)
            values (${organizationId}, ${user.id}, 'member')`,
      ),
    );
    return {
      context: await resolveTenantContext(app.db, user.id, organizationId),
      email: user.email,
    };
  };

  /** Runs as the superuser with triggers off: time travel, which no role can do. */
  const travel = async (statement: string, values: unknown[] = []) => {
    await su.query('begin');
    try {
      await su.query("set local session_replication_role = 'replica'");
      await su.query(statement, values);
      await su.query('commit');
    } catch (error) {
      await su.query('rollback');
      throw error;
    }
  };

  /** Leaves only this test's own messages due, so a claim picks one of ours. */
  const onlyOursDue = async (ids: string[]) => {
    for (const table of ['platform.mail_outbox', 'platform.account_mail_outbox'])
      await travel(
        `update ${table} set next_attempt_at = case when id = any($1::uuid[]) then now() - interval '1 second'
                                                    else greatest(next_attempt_at, now() + interval '1 day') end
          where status = 'queued'`,
        [ids],
      );
  };

  const mailFor = async (where: string, values: unknown[]) =>
    (
      await su.query(
        `select * from platform.mail_outbox where ${where} order by created_at`,
        values,
      )
    ).rows;

  beforeAll(async () => {
    await Promise.all([su.connect(), auth.connect(), appClient.connect(), mailerClient.connect()]);
    const ownerUser = await makeUser('mail-owner', { verified: true });
    const created = await createOrganization(app.db, {
      userId: ownerUser.id,
      name: 'Mail Test Ltd',
      commercialMode: 'byom',
    });
    organizationId = created.organizationId;
    owner = await resolveTenantContext(app.db, ownerUser.id, organizationId);
    const verified = await addMember('mail-member', true);
    member = verified.context;
    memberAddress = verified.email;
    unverified = (await addMember('mail-unverified', false)).context;
  });

  afterAll(async () => {
    await Promise.all([su.end(), auth.end(), appClient.end(), mailerClient.end()]);
    await Promise.all([app.close(), authDb.close(), mailer.close()]);
  });

  describe('account mail', () => {
    const queue = (
      input: Partial<Parameters<typeof queueAccountMail>[1]> & { userId: string; address: string },
    ) => {
      const id = input.id ?? randomUUID();
      return queueAccountMail(authDb.db, {
        id,
        kind: 'email_verification',
        idempotencyKey: `test:${randomUUID()}`,
        link: seal({
          organizationId: ACCOUNT_MAIL_SCOPE,
          secretId: id,
          purpose: MAIL_LINK_PURPOSE,
          plaintext: JSON.stringify({ link: `${PUBLIC_URL}/verify-email/token-${id}` }),
        }),
        ...input,
      }).then(() => id);
    };
    const row = async (id: string) =>
      (await su.query('select * from platform.account_mail_outbox where id = $1', [id])).rows[0];

    it('is queued by the auth role alone, to the person’s own address, with the times the database sets', async () => {
      const user = await makeUser('acct');
      const id = await queue({ userId: user.id, address: user.email.toUpperCase() });
      const queued = await row(id);
      expect(queued.status).toBe('queued');
      expect(queued.recipient_address).toBe(user.email.toLowerCase());
      expect(queued.recipient_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(new Date(queued.send_before).getTime() - new Date(queued.created_at).getTime()).toBe(
        24 * 60 * 60 * 1000,
      );
      // Not to somebody else's address, and never by the application role.
      await refusedWith(
        queue({ userId: user.id, address: 'someone-else@example.invalid' }),
        'EN571',
      );
      await expect(
        appClient.query(
          `insert into platform.account_mail_outbox (kind, idempotency_key, recipient_user_id, recipient_address)
           values ('password_changed', $1, $2, $3)`,
          [randomUUID(), user.id, user.email],
        ),
      ).rejects.toThrow(/permission denied/);
    });

    it('proves a new address only at an address that is not yet theirs', async () => {
      const user = await makeUser('acct-change');
      await refusedWith(
        queue({ userId: user.id, address: user.email, kind: 'email_change_verify' }),
        'EN571',
      );
      const id = await queue({
        userId: user.id,
        address: `moved-${randomUUID()}@example.invalid`,
        kind: 'email_change_verify',
      });
      expect((await row(id)).status).toBe('queued');
    });

    it('keeps the sixth message an hour to one address unsent, and keeps nothing of it', async () => {
      const user = await makeUser('acct-limit');
      const ids: string[] = [];
      for (let i = 0; i < 6; i++) ids.push(await queue({ userId: user.id, address: user.email }));
      const statuses = await Promise.all(ids.map(async (id) => (await row(id)).status));
      expect(statuses).toEqual(['queued', 'queued', 'queued', 'queued', 'queued', 'suppressed']);
      const last = await row(ids[5]!);
      expect(last.last_code).toBe('RATE_LIMITED');
      expect(last.recipient_address).toBeNull();
      expect(last.link_ciphertext).toBeNull();
    });

    it('sends no reset to someone with no password, and says nothing about it', async () => {
      const user = await makeUser('acct-sso', { password: false });
      const id = await queue({ userId: user.id, address: user.email, kind: 'password_reset' });
      expect(await row(id)).toMatchObject({
        status: 'suppressed',
        last_code: 'NO_PASSWORD_ACCOUNT',
      });
    });

    it('is moved only by the mail worker, along the arrows, and settling erases the link', async () => {
      const user = await makeUser('acct-send');
      const id = await queue({ userId: user.id, address: user.email });
      await expect(
        auth.query(`update platform.account_mail_outbox set status='sending' where id=$1`, [id]),
      ).rejects.toThrow(/permission denied|MAIL_PROGRESS_DENIED/);
      await onlyOursDue([id]);
      const claimed = await claimAccountMail(mailer.db, DOMAIN);
      expect(claimed).toMatchObject({ id, attempts: 1, address: user.email.toLowerCase() });
      expect(claimed!.messageId).toBe(`<${id}@${DOMAIN}>`);
      const plaintext = openSealed(keys, claimed!.link!, {
        organizationId: ACCOUNT_MAIL_SCOPE,
        secretId: id,
        purpose: MAIL_LINK_PURPOSE,
      });
      expect(JSON.parse(plaintext.toString()).link).toBe(`${PUBLIC_URL}/verify-email/token-${id}`);
      await recordOutcome(mailer.db, 'account', id, { status: 'sent' });
      const sent = await row(id);
      expect(sent).toMatchObject({
        status: 'sent',
        last_code: 'ACCEPTED_BY_RELAY',
        recipient_address: null,
      });
      expect(sent.link_ciphertext).toBeNull();
      expect(sent.recipient_sha256).toMatch(/^[0-9a-f]{64}$/);
      await refusedWith(
        mailerClient.query(`update platform.account_mail_outbox set status='queued' where id=$1`, [
          id,
        ]),
        'EN572',
      );
    });

    it('calls a claim a dead worker left unknown, and never sends it again', async () => {
      const user = await makeUser('acct-lease');
      const id = await queue({ userId: user.id, address: user.email });
      await onlyOursDue([id]);
      expect((await claimAccountMail(mailer.db, DOMAIN))?.id).toBe(id);
      await settleExpiredClaims(mailer.db, 0);
      expect(await row(id)).toMatchObject({ status: 'unknown', last_code: 'LEASE_EXPIRED' });
      expect(await claimAccountMail(mailer.db, DOMAIN)).toBeNull();
      // A late answer is believed.
      await recordOutcome(mailer.db, 'account', id, { status: 'sent' });
      expect((await row(id)).status).toBe('sent');
    });

    it('retries only before the commit point, with a wait', async () => {
      const user = await makeUser('acct-retry');
      const id = await queue({ userId: user.id, address: user.email });
      await onlyOursDue([id]);
      await claimAccountMail(mailer.db, DOMAIN);
      await refusedWith(
        mailerClient.query(
          `update platform.account_mail_outbox set status='queued', last_code='RELAY_BUSY' where id=$1`,
          [id],
        ),
        'EN572',
      );
      await recordOutcome(mailer.db, 'account', id, {
        status: 'queued',
        code: 'RELAY_BUSY',
        retryAt: new Date(Date.now() + 60_000),
      });
      expect(await row(id)).toMatchObject({ status: 'queued', attempts: 1, claimed_at: null });
    });
  });

  describe('notification mail', () => {
    const notificationIdsFor = async (membershipId: string, targetRef: string) =>
      (
        await withTenantTx(app.db, owner, (tx) =>
          tx
            .select({ id: notifications.id })
            .from(notifications)
            .where(
              sql`${notifications.recipientMembershipId} = ${membershipId} and ${notifications.targetRef} = ${targetRef}`,
            ),
        )
      ).map((row) => row.id);

    it('queues one message per notification, in its transaction, and one per reminder', async () => {
      const target = `knowledge_answer:${randomUUID()}`;
      await withTenantTx(app.db, owner, (tx) =>
        notify(tx, owner, [member.membershipId], 'knowledge.answer_ready', target),
      );
      const [notificationId] = await notificationIdsFor(member.membershipId, target);
      const queued = await mailFor('notification_id = $1', [notificationId]);
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({
        kind: 'notification',
        notification_kind: 'knowledge.answer_ready',
        target_ref: target,
        recipient_membership_id: member.membershipId,
        recipient_address: null,
        reminder_number: null,
        status: 'queued',
      });
      expect(new Date(queued[0].next_attempt_at).getTime()).toBeGreaterThan(
        new Date(queued[0].created_at).getTime(),
      );
      await withTenantTx(app.db, owner, (tx) =>
        tx
          .update(notifications)
          .set({ remindersSent: sql`${notifications.remindersSent} + 1` })
          .where(eq(notifications.id, notificationId!)),
      );
      const both = await mailFor('notification_id = $1', [notificationId]);
      expect(both.map((row) => row.reminder_number)).toEqual([null, 1]);
    });

    it('cannot be queued directly, for any notification', async () => {
      const target = `approval:${randomUUID()}`;
      await withTenantTx(app.db, owner, (tx) =>
        notify(tx, owner, [member.membershipId], 'approval.requested', target),
      );
      const [notificationId] = await notificationIdsFor(member.membershipId, target);
      await refusedWith(
        withTenantTx(app.db, owner, (tx) =>
          tx.execute(sql`
            insert into platform.mail_outbox (organization_id, kind, idempotency_key, recipient_membership_id,
              notification_id, notification_kind, target_ref, send_before)
            values (${organizationId}, 'notification', ${randomUUID()}, ${member.membershipId},
              ${notificationId}, 'approval.requested', ${target}, now() + interval '1 day')`),
        ),
        'EN571',
      );
    });

    it('reads what is true when it is due: address, proof, choice, and whether it was read', async () => {
      const target = `knowledge_answer:${randomUUID()}`;
      await withTenantTx(app.db, owner, (tx) =>
        notify(
          tx,
          owner,
          [member.membershipId, unverified.membershipId],
          'knowledge.answer_ready',
          target,
        ),
      );
      await setMyNotificationPreferences(app.db, member, { answers: 'daily' });
      const rows = await mailFor('target_ref = $1', [target]);
      await onlyOursDue(rows.map((row) => row.id));
      const seen: TenantMailFacts[] = [];
      for (let i = 0; i < 2; i++) {
        await claimTenantMail(mailer.db, {
          messageIdDomain: DOMAIN,
          topicOf: topicOfMail,
          unsubscribeDays: 90,
          plan: (facts) => {
            seen.push(facts);
            return planTenantMail(facts, {
              now: new Date(),
              unsubscribeTokenSha256: 'c'.repeat(64),
            });
          },
        });
      }
      const forMember = seen.find((facts) => facts.member?.membershipId === member.membershipId)!;
      expect(forMember.member).toMatchObject({
        address: memberAddress,
        addressVerified: true,
        active: true,
      });
      expect(forMember.preference).toBe('daily');
      expect(forMember.notification).toMatchObject({ kind: 'knowledge.answer_ready', read: false });
      const after = await mailFor('target_ref = $1', [target]);
      const byMember = Object.fromEntries(after.map((row) => [row.recipient_membership_id, row]));
      // Held for the morning, and never mailed to an address nobody proved.
      expect(byMember[member.membershipId]).toMatchObject({ status: 'held' });
      expect(byMember[unverified.membershipId]).toMatchObject({
        status: 'skipped',
        last_code: 'ADDRESS_UNVERIFIED',
      });
      await setMyNotificationPreferences(app.db, member, { answers: 'immediate' });
    });

    it('gathers held news into one digest per topic, leaving out what was read', async () => {
      const targets = [`work_unit:${randomUUID()}`, `work_unit:${randomUUID()}`];
      for (const target of targets)
        await withTenantTx(app.db, owner, (tx) =>
          notify(tx, owner, [member.membershipId], 'work.assigned', target),
        );
      const rows = await mailFor('target_ref = any($1)', [targets]);
      await onlyOursDue(rows.map((row) => row.id));
      for (let i = 0; i < 2; i++)
        await claimTenantMail(mailer.db, {
          messageIdDomain: DOMAIN,
          topicOf: topicOfMail,
          unsubscribeDays: 90,
          plan: (facts) =>
            planTenantMail(facts, { now: new Date(), unsubscribeTokenSha256: 'd'.repeat(64) }),
        });
      expect((await mailFor('target_ref = any($1)', [targets])).map((row) => row.status)).toEqual([
        'held',
        'held',
      ]);
      // One read in the app since, and the morning has come.
      await withTenantTx(app.db, member, (tx) =>
        tx
          .update(notifications)
          .set({ readAt: new Date() })
          .where(eq(notifications.id, rows[0].notification_id)),
      );
      await travel(
        `update platform.mail_outbox set digest_due_at = now() - interval '1 second' where id = any($1::uuid[])`,
        [rows.map((row) => row.id)],
      );
      expect(await gatherDueDigests(mailer.db, notificationTopicOf)).toBeGreaterThanOrEqual(1);
      const settled = await mailFor('target_ref = any($1)', [targets]);
      expect(settled.map((row) => [row.status, row.last_code])).toEqual([
        ['skipped', 'ALREADY_READ'],
        ['digested', null],
      ]);
      const [digest] = await mailFor('id = $1', [settled[1].digest_id]);
      expect(digest).toMatchObject({
        kind: 'digest',
        status: 'queued',
        recipient_membership_id: member.membershipId,
        target_ref: 'topic:activity',
      });
    });
  });

  describe('support replies', () => {
    it('reach the person who opened the ticket, in the app and by email', async () => {
      const desk = new pg.Client({ connectionString: urls.superuser() });
      await desk.connect();
      try {
        await desk.query('set role ensemus_support');
        const { ticketId } = await openTicket(app.db, member, {
          subject: 'A test request',
          category: 'other',
          body: 'Test context.',
        });
        await replyAsDesk(
          drizzle(desk, { casing: 'snake_case' }) as unknown as Parameters<typeof replyAsDesk>[0],
          {
            organizationId,
            ticketId,
            agentRef: 'test-agent@example.invalid',
            body: 'A test reply.',
          },
        );
        const notified = await su.query(
          `select id, kind, recipient_membership_id from platform.notifications
            where organization_id = $1 and target_ref = $2`,
          [organizationId, `ticket:${ticketId}`],
        );
        expect(notified.rows).toEqual([
          {
            id: expect.any(String),
            kind: 'ticket.replied',
            recipient_membership_id: member.membershipId,
          },
        ]);
        const [mail] = await mailFor('notification_id = $1', [notified.rows[0].id]);
        expect(mail).toMatchObject({
          kind: 'notification',
          notification_kind: 'ticket.replied',
          status: 'queued',
        });
        // A customer's own message notifies nobody.
        expect(
          (
            await su.query(
              `select count(*)::int as n from platform.notifications where target_ref = $1`,
              [`ticket:${ticketId}`],
            )
          ).rows[0].n,
        ).toBe(1);
      } finally {
        await desk.query('reset role');
        await desk.end();
      }
    });
  });

  describe('invitations', () => {
    it('are emailed only from the transaction that made them, to the address invited', async () => {
      const email = `invitee-${randomUUID()}@example.invalid`;
      const { id, token, emailed } = await createInvitation(
        app.db,
        owner,
        { email },
        { mail: { seal, publicUrl: PUBLIC_URL } },
      );
      expect(emailed).toBe(true);
      const [row] = await mailFor('invitation_id = $1', [id]);
      expect(row).toMatchObject({ kind: 'invitation', recipient_address: email, status: 'queued' });
      const plaintext = openSealed(
        keys,
        {
          keyId: row.link_key_id,
          wrappedKey: row.link_wrapped_key,
          iv: row.link_iv,
          ciphertext: row.link_ciphertext,
          authTag: row.link_auth_tag,
        },
        { organizationId, secretId: row.id, purpose: MAIL_LINK_PURPOSE },
      );
      expect(JSON.parse(plaintext.toString()).link).toBe(`${PUBLIC_URL}/invite/${token}`);
      // Later, from another transaction, the same invitation cannot be mailed again.
      await refusedWith(
        withTenantTx(app.db, owner, (tx) =>
          tx.execute(sql`
            insert into platform.mail_outbox (organization_id, kind, idempotency_key, invitation_id,
              recipient_address, link_key_id, link_wrapped_key, link_iv, link_ciphertext, link_auth_tag, send_before)
            values (${organizationId}, 'invitation', ${randomUUID()}, ${id}, ${email}, 'k', '\\x00', '\\x00',
              '\\x00', '\\x00', now() + interval '1 day')`),
        ),
        'EN571',
      );
    });

    it('stop at three an hour to one address, and still hand back the link', async () => {
      const email = `again-${randomUUID()}@example.invalid`;
      const results = [];
      for (let i = 0; i < 4; i++)
        results.push(
          await createInvitation(
            app.db,
            owner,
            { email },
            { mail: { seal, publicUrl: PUBLIC_URL } },
          ),
        );
      expect(results.map((result) => result.emailed)).toEqual([true, true, true, false]);
      expect(results[3]!.token).toBeTruthy();
    });
  });

  describe('preferences and unsubscribe links', () => {
    it('are a person’s own, and never another member’s', async () => {
      await setMyNotificationPreferences(app.db, member, { billing: 'off', activity: 'daily' });
      const mine = await getMyNotificationPreferences(app.db, member);
      expect(mine.find((p) => p.topic === 'billing')).toEqual({
        topic: 'billing',
        delivery: 'off',
        isDefault: false,
      });
      // Set back to its default, a topic keeps no row.
      expect(mine.find((p) => p.topic === 'activity')).toEqual({
        topic: 'activity',
        delivery: 'daily',
        isDefault: true,
      });
      expect((await getMyNotificationPreferences(app.db, owner)).every((p) => p.isDefault)).toBe(
        true,
      );
      await expect(
        withTenantTx(app.db, owner, (tx) =>
          tx.execute(sql`
            insert into org.notification_preferences (organization_id, membership_id, topic, delivery)
            values (${organizationId}, ${member.membershipId}, 'support', 'off')`),
        ),
      ).rejects.toThrow();
      await setMyNotificationPreferences(app.db, member, { billing: 'immediate' });
    });

    it('turn off one topic for one person, with no session, and only off', async () => {
      const unsubscribe = newUnsubscribeToken();
      await mailer.db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.organization_id', ${organizationId}, true)`);
        await tx.execute(sql`
          insert into platform.mail_unsubscribe_tokens (token_sha256, organization_id, membership_id, topic, expires_at)
          values (${unsubscribe.sha256}, ${organizationId}, ${member.membershipId}, 'approvals', now() + interval '90 days')`);
      });
      expect(await describeUnsubscribe(app.db, unsubscribe.token)).toEqual({ topic: 'approvals' });
      expect(await unsubscribeByToken(app.db, unsubscribe.token)).toEqual({
        status: 'done',
        topic: 'approvals',
        organizationId,
      });
      expect(await unsubscribeByToken(app.db, unsubscribe.token)).toMatchObject({ status: 'done' });
      const mine = await getMyNotificationPreferences(app.db, member);
      expect(mine.find((p) => p.topic === 'approvals')?.delivery).toBe('off');
      expect(await unsubscribeByToken(app.db, newUnsubscribeToken().token)).toEqual({
        status: 'invalid',
      });
      // The link writes only `off`, and only its own topic.
      await appClient.query('begin');
      try {
        await appClient.query("select set_config('app.mail_unsubscribe_token', $1, true)", [
          unsubscribe.sha256,
        ]);
        await appClient.query("select set_config('app.organization_id', $1, true)", [
          organizationId,
        ]);
        await expect(
          appClient.query(
            `update org.notification_preferences set delivery = 'immediate'
              where membership_id = $1 and topic = 'approvals'`,
            [member.membershipId],
          ),
        ).rejects.toThrow(/row-level security/);
      } finally {
        await appClient.query('rollback');
      }
      await setMyNotificationPreferences(app.db, member, { approvals: 'immediate' });
    });
  });

  describe('the mail worker’s role', () => {
    it('reads names and addresses, and nothing a notification points at', async () => {
      await expect(mailerClient.query('select title from work.work_units limit 1')).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        mailerClient.query('select target_ref from platform.notifications limit 1'),
      ).rejects.toThrow(/permission denied/);
      await expect(
        mailerClient.query('select password from identity.accounts limit 1'),
      ).rejects.toThrow(/permission denied/);
      await expect(
        mailerClient.query('select token_hash from org.invitations limit 1'),
      ).rejects.toThrow(/permission denied/);
      const { rows } = await su.query(
        `select rolsuper or rolcreaterole or rolbypassrls or rolcreatedb as elevated
           from pg_roles where rolname = 'ensemus_mailer'`,
      );
      expect(rows).toEqual([{ elevated: false }]);
    });
  });
});
