// Joining through an invitation is an ordinary write, so a tenant in restricted standing takes nobody new
// (ADR-032 D5, "Not an exception: joining through an invitation"). acceptInvitation runs before the person
// has a membership, through withNewTenantTx, which withTenantTx's read-only rule never reached. These cover
// the refusal, that nothing is written by it, and that a tenant in good standing still lets people join.
import { randomUUID } from 'node:crypto';
import { acceptInvitation, createInvitation, pgCode } from '@ensemus/application';
import {
  createOrganization,
  invitations,
  memberships,
  openAppDatabase,
  resolveTenantContext,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { setTenantStandingInTx } from '@ensemus/application/saas/standing';
import { createStandingAgentHaltPort } from '@ensemus/application/saas/standing-agent-port';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { urls } from '../helpers/stack';

const code = (name: string) => expect.objectContaining({ code: name });

describe('invitation acceptance in restricted standing', () => {
  const database = openAppDatabase(urls.app());
  const auth = new pg.Client({ connectionString: urls.auth() });
  const agents = createStandingAgentHaltPort();

  const makeUser = async (label: string, emailVerified = true) => {
    const id = randomUUID();
    const email = `${label}-${id}@example.invalid`;
    await auth.query(
      'insert into identity.users (id, name, email, email_verified) values ($1, $2, $3, $4)',
      [id, label, email, emailVerified],
    );
    return { id, email };
  };

  const tenant = async (label: string) => {
    const owner = await makeUser(`${label}-owner`);
    const made = await createOrganization(database.db, {
      userId: owner.id,
      name: `Invitation ${label}`,
      commercialMode: 'byom',
    });
    return resolveTenantContext(database.db, owner.id, made.organizationId);
  };

  /** The production path for a standing change: a service context, with its record written first. */
  const setStanding = async (context: TenantContext, to: 'active' | 'read_only' | 'suspended') => {
    const service = createServiceContext(context.organizationId);
    await withTenantTx(database.db, service, (tx) =>
      setTenantStandingInTx(
        tx,
        service,
        { to, reasonCode: 'TEST_TERMS', actor: { type: 'operator', ref: 'test-operator' } },
        agents,
      ),
    );
    return resolveTenantContext(database.db, context.userId, context.organizationId);
  };

  /** Read as the tenant's own worker, which is served in full whatever the standing. */
  const stateOf = async (organizationId: string, invitationId: string, userId: string) =>
    withTenantTx(database.db, createServiceContext(organizationId), async (tx) => {
      const [invitation] = await tx
        .select({
          acceptedAt: invitations.acceptedAt,
          claimedAt: invitations.claimedAt,
          claimedByUserId: invitations.claimedByUserId,
        })
        .from(invitations)
        .where(eq(invitations.id, invitationId));
      const joined = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(eq(memberships.userId, userId));
      return { invitation, memberships: joined.length };
    });

  const untouched = {
    invitation: { acceptedAt: null, claimedAt: null, claimedByUserId: null },
    memberships: 0,
  };

  beforeAll(async () => {
    await auth.connect();
  });
  afterAll(async () => {
    await auth.end();
    await database.close();
  });

  it.each([
    ['read_only', 'TENANT_READ_ONLY'],
    ['suspended', 'TENANT_SUSPENDED'],
  ] as const)(
    'a %s tenant refuses with %s, writes nothing, and the invitation works once standing returns',
    async (standing, refusal) => {
      const active = await tenant(standing);
      const verified = await makeUser('verified');
      const unverified = await makeUser('unverified', false);
      // Invitations are made while the tenant is in good standing, as they would be in production.
      const forVerified = await createInvitation(database.db, active, {
        email: verified.email,
        role: 'admin',
      });
      const forUnverified = await createInvitation(database.db, active, {
        email: unverified.email,
      });
      const restricted = await setStanding(active, standing);
      expect(restricted.serving).toBe(standing);

      // The standing's own guard is untouched: an ordinary write by a member still fails in PostgreSQL.
      await expect(
        withTenantTx(database.db, restricted, (tx) =>
          tx.execute(sql`update org.organizations set name = name`),
        ),
      ).rejects.toSatisfy((error: unknown) => pgCode(error) === '25006');

      // A verified address would join. Refused, with no membership and the invitation still unused.
      await expect(
        acceptInvitation(database.db, {
          token: forVerified.token,
          userId: verified.id,
          email: verified.email,
          emailVerified: true,
        }),
      ).rejects.toEqual(code(refusal));
      expect(await stateOf(active.organizationId, forVerified.id, verified.id)).toEqual(untouched);
      await expect(
        resolveTenantContext(database.db, verified.id, active.organizationId),
      ).rejects.toThrow();

      // An unverified address would only ask to join, which is also a write: not claimed either.
      await expect(
        acceptInvitation(database.db, {
          token: forUnverified.token,
          userId: unverified.id,
          email: unverified.email,
          emailVerified: false,
        }),
      ).rejects.toEqual(code(refusal));
      expect(await stateOf(active.organizationId, forUnverified.id, unverified.id)).toEqual(
        untouched,
      );

      // Someone who is not the recipient learns nothing about the standing.
      const stranger = await makeUser('stranger');
      await expect(
        acceptInvitation(database.db, {
          token: forVerified.token,
          userId: stranger.id,
          email: stranger.email,
          emailVerified: true,
        }),
      ).rejects.toEqual(code('INVITATION_INVALID'));

      // Back in good standing, the same invitation joins, in the role it names.
      await setStanding(restricted, 'active');
      expect(
        await acceptInvitation(database.db, {
          token: forVerified.token,
          userId: verified.id,
          email: verified.email,
          emailVerified: true,
        }),
      ).toEqual({ status: 'joined', organizationId: active.organizationId });
      const joined = await resolveTenantContext(database.db, verified.id, active.organizationId);
      expect(joined.role).toBe('admin');
      expect(joined.serving).toBe('full');
    },
  );

  it('a tenant in good standing accepts an invitation and creates the membership', async () => {
    const active = await tenant('active');
    expect(active.serving).toBe('full');
    const invitee = await makeUser('invitee');
    const { id, token } = await createInvitation(database.db, active, { email: invitee.email });
    expect(
      await acceptInvitation(database.db, {
        token,
        userId: invitee.id,
        email: invitee.email,
        emailVerified: true,
      }),
    ).toEqual({ status: 'joined', organizationId: active.organizationId });
    const after = await stateOf(active.organizationId, id, invitee.id);
    expect(after.memberships).toBe(1);
    expect(after.invitation?.acceptedAt).toBeInstanceOf(Date);
    expect((await resolveTenantContext(database.db, invitee.id, active.organizationId)).role).toBe(
      'member',
    );
  });

  it('a tenant in good standing still records an unverified request to join', async () => {
    const active = await tenant('active-unverified');
    const invitee = await makeUser('asks', false);
    const { id, token } = await createInvitation(database.db, active, { email: invitee.email });
    expect(
      await acceptInvitation(database.db, {
        token,
        userId: invitee.id,
        email: invitee.email,
        emailVerified: false,
      }),
    ).toEqual({ status: 'awaiting_confirmation' });
    const after = await stateOf(active.organizationId, id, invitee.id);
    expect(after.memberships).toBe(0);
    expect(after.invitation?.claimedByUserId).toBe(invitee.id);
    expect(after.invitation?.acceptedAt).toBeNull();
  });
});
