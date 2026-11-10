// Joining through an invitation is an ordinary write, so a tenant in restricted standing takes nobody new
// (ADR-032 D5, "Not an exception: joining through an invitation"). acceptInvitation runs before the person
// has a membership, through withNewTenantTx, which withTenantTx's read-only rule never reached. These cover
// the refusal, that nothing is written by it, and that a tenant in good standing still lets people join.
// Leaving (`offboarding`) is restricted standing too, and a tenant that has gone (`deleted`) is the same as
// one that never existed (people.ts acceptInvitation). Both are reached here only the way the product
// reaches them: requestOffboarding, and ops-erase's sequence through finishErasure.
import { randomUUID } from 'node:crypto';
import { acceptInvitation, createInvitation, pgCode } from '@ensemus/application';
import {
  createOrganization,
  getOrganization,
  invitations,
  memberships,
  offboardings,
  openAppDatabase,
  organizations,
  resolveTenantContext,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { eraseTenantRows } from '@ensemus/database/eraser';
import { setTenantStandingInTx } from '@ensemus/application/saas/standing';
import { createStandingAgentHaltPort } from '@ensemus/application/saas/standing-agent-port';
import {
  advanceOffboarding,
  beginErasure,
  cancelOffboarding,
  finishErasure,
  getOffboarding,
  inspectErasure,
  requestOffboarding,
  setTransitionEnd,
} from '@ensemus/application/saas/offboarding';
import { createTenantObjectErasure } from '@ensemus/application/saas/tenant-object-erasure';
import { sealDelegatedErasureInTx } from '@ensemus/application/knowledge/delegated-erasure';
import type { TenantLifecycle } from '@ensemus/saas/entitlements';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nativeSovereignContext } from '../helpers/sovereign';
import { urls } from '../helpers/stack';
import { LifecycleMemoryStore } from './saas-lifecycle-fixture';
import { offboardingPorts } from './saas-offboarding-fixture';

const code = (name: string) => expect.objectContaining({ code: name });

describe('invitation acceptance in restricted standing', () => {
  const database = openAppDatabase(urls.app());
  const auth = new pg.Client({ connectionString: urls.auth() });
  // ops-erase connects as ensemus_eraser. The stack gives that role no login, so take it as saas-erasure does.
  const eraserClient = new pg.Client({ connectionString: urls.superuser() });
  let eraser: Parameters<typeof eraseTenantRows>[0];
  const agents = createStandingAgentHaltPort();
  const ports = offboardingPorts();
  const operatorRef = 'test-operator@example.invalid';

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

  /** Read as the tenant's own worker, which sees its organization whatever the lifecycle. */
  const lifecycleOf = async (organizationId: string) => {
    const [row] = await withTenantTx(database.db, createServiceContext(organizationId), (tx) =>
      tx
        .select({ lifecycle: organizations.lifecycle })
        .from(organizations)
        .where(eq(organizations.id, organizationId)),
    );
    return row?.lifecycle;
  };

  /** The owner as the account page has them: a person with an interactive session (ADR-032 D7). */
  const ownerOf = (context: TenantContext) =>
    nativeSovereignContext(database.db, context.userId, context.organizationId);

  /** The owner asks to leave, by the organization's exact name. This is the only way into `offboarding`. */
  const requestToLeave = async (context: TenantContext) => {
    const owner = await ownerOf(context);
    const organization = await getOrganization(database.db, owner);
    if (!organization) throw new Error('TEST_ORGANIZATION_MISSING');
    return requestOffboarding(
      database.db,
      owner,
      { confirmName: organization.name },
      ports.offboardingAgents,
    );
  };

  /** One step of the offboarding workflow, as its worker takes it. */
  const advance = (organizationId: string, offboardingId: string) =>
    advanceOffboarding(database.db, createServiceContext(organizationId), ports, {
      offboardingId,
      now: new Date(),
    });

  /**
   * The workflow up to the operator's last step, once the contract's transition end has passed. `atEach` runs
   * at every state the offboarding reaches on the way, `ready_for_erasure` included.
   */
  const runToErasure = async (
    organizationId: string,
    offboardingId: string,
    atEach: (state: string) => Promise<void> = async () => {},
  ) => {
    const service = createServiceContext(organizationId);
    await advance(organizationId, offboardingId);
    await setTransitionEnd(database.db, service, {
      offboardingId,
      transitionEndsAt: new Date(Date.now() - 1000),
      operatorRef,
    });
    for (let step = 0; step < 12; step++) {
      const { state } = await inspectErasure(database.db, service, { offboardingId });
      await atEach(state);
      if (state === 'ready_for_erasure') return;
      await advance(organizationId, offboardingId);
    }
    throw new Error('TEST_OFFBOARDING_DID_NOT_ADVANCE');
  };

  /**
   * ops-erase from `ready_for_erasure`: tombstones, nothing left pending, the material witness sealed, the
   * rows erased by ensemus_eraser, then finishErasure, which is what moves the tenant to `deleted` (0501
   * check_lifecycle_change admits `deleted` only once the offboarding is verified).
   */
  const erase = async (organizationId: string, offboardingId: string) => {
    const service = createServiceContext(organizationId);
    const input = { offboardingId, operatorRef };
    for (;;) if (!(await beginErasure(database.db, service, input)).more) break;
    expect(await inspectErasure(database.db, service, input)).toMatchObject({
      state: 'erasing',
      activeHolds: 0,
      unsettledActions: 0,
      ledgerPending: 0,
    });
    expect(
      await withTenantTx(database.db, service, (tx) =>
        sealDelegatedErasureInTx(tx, service, input),
      ),
    ).toBe(true);
    const tables = await eraseTenantRows(eraser, organizationId);
    const finished = await finishErasure(
      database.db,
      service,
      { ...input, tables, blobsRemoved: 0 },
      ports.offboardingAgents,
      createTenantObjectErasure({ database: database.db, store: new LifecycleMemoryStore() }),
    );
    expect(finished.state).toBe('reported');
  };

  /**
   * Moves the tenant the way production does. `read_only`, `suspended` and back to `active` are a standing
   * change by a service context, with its record written first. `offboarding` is the owner's request to
   * leave, and leaving it before erasure is the owner cancelling, which restores the standing recorded
   * before it. `deleted` is the whole offboarding through erasure, after which there is no context left.
   */
  async function setStanding(context: TenantContext, to: 'deleted'): Promise<null>;
  async function setStanding(
    context: TenantContext,
    to: Exclude<TenantLifecycle, 'deleted'>,
  ): Promise<TenantContext>;
  async function setStanding(
    context: TenantContext,
    to: TenantLifecycle,
  ): Promise<TenantContext | null> {
    const { organizationId, userId } = context;
    if (to === 'deleted') {
      const { offboardingId } = await requestToLeave(context);
      await runToErasure(organizationId, offboardingId);
      await erase(organizationId, offboardingId);
      expect(await lifecycleOf(organizationId)).toBe('deleted');
      return null;
    }
    if (to === 'offboarding') {
      await requestToLeave(context);
    } else {
      if ((await lifecycleOf(organizationId)) === 'offboarding') {
        const owner = await ownerOf(context);
        const view = await getOffboarding(database.db, owner);
        if (!view) throw new Error('TEST_OFFBOARDING_MISSING');
        await cancelOffboarding(
          database.db,
          owner,
          { reasonCode: 'TEST_CANCELLED', expectedVersion: view.version },
          ports.offboardingAgents,
        );
      }
      const service = createServiceContext(organizationId);
      await withTenantTx(database.db, service, (tx) =>
        setTenantStandingInTx(
          tx,
          service,
          { to, reasonCode: 'TEST_TERMS', actor: { type: 'operator', ref: 'test-operator' } },
          agents,
        ),
      );
    }
    expect(await lifecycleOf(organizationId)).toBe(to);
    return resolveTenantContext(database.db, userId, organizationId);
  }

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
    await eraserClient.connect();
    await eraserClient.query('set session authorization ensemus_eraser');
    eraser = drizzle(eraserClient, { casing: 'snake_case' }) as unknown as Parameters<
      typeof eraseTenantRows
    >[0];
  });
  afterAll(async () => {
    await eraserClient.query('reset session authorization');
    await eraserClient.end();
    await auth.end();
    await database.close();
  });

  // ADR-032 D5 answers TENANT_SUSPENDED for `offboarding` as for `suspended`. Cancelling the offboarding is
  // how the product restores standing from there, and the invitation works again with it.
  it.each([
    ['read_only', 'TENANT_READ_ONLY'],
    ['suspended', 'TENANT_SUSPENDED'],
    ['offboarding', 'TENANT_SUSPENDED'],
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

  it('a deleted tenant answers INVITATION_INVALID, as one that never existed, and nobody joins it', async () => {
    const active = await tenant('deleted');
    const verified = await makeUser('verified');
    const unverified = await makeUser('unverified', false);
    const forVerified = await createInvitation(database.db, active, {
      email: verified.email,
      role: 'admin',
    });
    const forUnverified = await createInvitation(database.db, active, { email: unverified.email });

    expect(await setStanding(active, 'deleted')).toBeNull();

    // ADR-032 D5: `deleted` is the same as never existing, so neither recipient learns the tenant was there.
    const cases = [
      { who: verified, invitation: forVerified, emailVerified: true },
      { who: unverified, invitation: forUnverified, emailVerified: false },
    ];
    for (const { who, invitation, emailVerified } of cases) {
      await expect(
        acceptInvitation(database.db, {
          token: invitation.token,
          userId: who.id,
          email: who.email,
          emailVerified,
        }),
      ).rejects.toEqual(code('INVITATION_INVALID'));
      // Erasure took the invitation with the rest of the tenant's rows (lifecycle.retained_table keeps no
      // `org` table with an organization_id), so nothing is left to claim, and the refusal wrote no
      // membership.
      expect(await stateOf(active.organizationId, invitation.id, who.id)).toEqual({
        invitation: undefined,
        memberships: 0,
      });
      await expect(
        resolveTenantContext(database.db, who.id, active.organizationId),
      ).rejects.toThrow();
    }
    expect(await lifecycleOf(active.organizationId)).toBe('deleted');
  });

  it('an outstanding invitation stays unusable through every step of offboarding, and after it', async () => {
    const active = await tenant('offboarding-lifecycle');
    const invitee = await makeUser('invitee');
    const asks = await makeUser('asks', false);
    const forInvitee = await createInvitation(database.db, active, {
      email: invitee.email,
      role: 'admin',
    });
    const forAsks = await createInvitation(database.db, active, { email: asks.email });

    /** Both recipients are refused with the leaving tenant's answer, and nothing is written. */
    const refused = async (refusal: string) => {
      await expect(
        acceptInvitation(database.db, {
          token: forInvitee.token,
          userId: invitee.id,
          email: invitee.email,
          emailVerified: true,
        }),
      ).rejects.toEqual(code(refusal));
      await expect(
        acceptInvitation(database.db, {
          token: forAsks.token,
          userId: asks.id,
          email: asks.email,
          emailVerified: false,
        }),
      ).rejects.toEqual(code(refusal));
      expect(await stateOf(active.organizationId, forInvitee.id, invitee.id)).toEqual(untouched);
      expect(await stateOf(active.organizationId, forAsks.id, asks.id)).toEqual(untouched);
      await expect(
        resolveTenantContext(database.db, invitee.id, active.organizationId),
      ).rejects.toThrow();
    };

    // The owner asks to leave, which is the product's only way into `offboarding`.
    const { offboardingId } = await requestToLeave(active);
    expect(await lifecycleOf(active.organizationId)).toBe('offboarding');
    const leaving = await resolveTenantContext(database.db, active.userId, active.organizationId);
    expect(leaving.serving).toBe('offboarding');
    // The standing's own guard is untouched: an ordinary write by a member fails in PostgreSQL.
    await expect(
      withTenantTx(database.db, leaving, (tx) =>
        tx.execute(sql`update org.organizations set name = name`),
      ),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === '25006');
    await refused('TENANT_SUSPENDED');

    // Every step the workflow takes keeps it that way, up to the point of no return.
    const seen: string[] = [];
    await runToErasure(active.organizationId, offboardingId, async (state) => {
      seen.push(state);
      expect(await lifecycleOf(active.organizationId)).toBe('offboarding');
      await refused('TENANT_SUSPENDED');
    });
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.at(-1)).toBe('ready_for_erasure');
    const [row] = await withTenantTx(
      database.db,
      createServiceContext(active.organizationId),
      (tx) => tx.select().from(offboardings).where(eq(offboardings.id, offboardingId)),
    );
    expect(row?.state).toBe('ready_for_erasure');

    // Erasure itself: the tenant is gone, and so is its invitation, which no one can now use.
    await erase(active.organizationId, offboardingId);
    expect(await lifecycleOf(active.organizationId)).toBe('deleted');
    await expect(
      acceptInvitation(database.db, {
        token: forInvitee.token,
        userId: invitee.id,
        email: invitee.email,
        emailVerified: true,
      }),
    ).rejects.toEqual(code('INVITATION_INVALID'));
    expect(await stateOf(active.organizationId, forInvitee.id, invitee.id)).toEqual({
      invitation: undefined,
      memberships: 0,
    });
  });

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
