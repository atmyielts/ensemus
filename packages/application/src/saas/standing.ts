// Owned by the subscriptions slice (OPS-21). A tenant's standing, which is what suspension is. Moving it
// never deletes anything, and the database refuses a move with no record beside it. See ADR-032 D5.
import { createHash, randomBytes } from 'node:crypto';
import {
  memberships,
  appendAudit,
  organizations,
  offboardings,
  standingChanges,
  withNewTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { accountContextOf, withAccountTx } from '@ensemus/database/account';
import { createServiceContext } from '@ensemus/database/service';
import { z } from 'zod';
import { TENANT_LIFECYCLE_TRANSITIONS, type TenantLifecycle } from '@ensemus/saas/entitlements';
import {
  AGGREGATE_ORGANIZATION,
  TENANT_STANDING_CHANGED,
  NOTIFY_STANDING_CHANGED,
  organizationTargetRef,
} from '@ensemus/saas/events';
import { and, eq } from 'drizzle-orm';
import { emit } from '../events';
import { notify } from '../work';
import { AppError } from '../errors';
import { idSchema } from '../ids';
import { loadPlanTerms } from './catalog';
import { canStartOn } from '@ensemus/saas/catalog';
import { startSubscriptionInTx } from './subscriptions';
import { loadEntitlementMetadataInTx } from './entitlement-metadata';

export type StandingActor =
  | { type: 'operator'; ref: string }
  | { type: 'system'; ref: string; collectionPolicyId?: string }
  | { type: 'membership'; ref: string };

/**
 * Service only. Writes `billing.standing_changes` and then the lifecycle, in that order, in the caller's
 * transaction. Emits TENANT_STANDING_CHANGED, tells owners, and halts or releases agents through the port.
 * A repeat that changes nothing writes nothing.
 */
export async function setTenantStandingInTx(
  tx: Tx,
  context: TenantContext,
  input: {
    to: TenantLifecycle;
    reasonCode: string;
    actor: StandingActor;
    offboardingCancellationId?: string;
  },
  agents: import('./ports').AgentHaltPort,
): Promise<'changed' | 'unchanged'> {
  if (context.actorType !== 'service') throw new AppError('NOT_FOUND');
  if (
    !/^[A-Z][A-Z0-9_]{0,63}$/.test(input.reasonCode) ||
    !input.actor.ref ||
    input.actor.ref.length > 200 ||
    /[\r\n\0]/.test(input.actor.ref)
  )
    throw new AppError('INVALID_INPUT');
  const [org] = await tx
    .select()
    .from(organizations)
    .where(eq(organizations.id, context.organizationId))
    .for('no key update');
  if (!org || org.lifecycle === 'deleted') throw new AppError('NOT_FOUND');
  if (org.lifecycle === input.to) return 'unchanged';
  // Leaving offboarding other than by erasure is cancelling it, and only cancelOffboarding does that: it
  // marks the intent cancelled first and names it here, so the restore is to the standing recorded when it
  // began. Any other move out of `offboarding`, such as an operator's unsuspend to `active`, would serve a
  // tenant beside a live offboarding, so it is refused before anything is written. Erasure's move to
  // `deleted` is the one other way out, which 0501's check_lifecycle_change admits only once verified.
  if (
    org.lifecycle === 'offboarding' &&
    input.to !== 'deleted' &&
    input.offboardingCancellationId === undefined
  )
    throw new AppError('INVALID_TRANSITION');
  if (input.offboardingCancellationId !== undefined) {
    const id = idSchema.safeParse(input.offboardingCancellationId);
    if (
      !id.success ||
      org.lifecycle !== 'offboarding' ||
      input.reasonCode !== 'OFFBOARDING_CANCELLED'
    )
      throw new AppError('INVALID_TRANSITION');
    const [prior] = await tx
      .select({ fromLifecycle: standingChanges.fromLifecycle })
      .from(standingChanges)
      .innerJoin(
        offboardings,
        and(
          eq(offboardings.organizationId, standingChanges.organizationId),
          eq(offboardings.createdAt, standingChanges.occurredAt),
        ),
      )
      .where(
        and(
          eq(offboardings.organizationId, context.organizationId),
          eq(offboardings.id, id.data),
          eq(offboardings.state, 'cancelled'),
          eq(standingChanges.toLifecycle, 'offboarding'),
          eq(standingChanges.reasonCode, 'OFFBOARDING_REQUESTED'),
        ),
      )
      .limit(1);
    if (!prior || prior.fromLifecycle !== input.to) throw new AppError('INVALID_TRANSITION');
  }
  const transitions = TENANT_LIFECYCLE_TRANSITIONS[org.lifecycle as TenantLifecycle];
  if (!transitions?.includes(input.to)) throw new AppError('INVALID_TRANSITION');
  if (
    input.actor.type === 'system' &&
    !input.actor.collectionPolicyId &&
    input.reasonCode !== 'PLAN_LIMIT_EXCEEDED'
  )
    throw new AppError('INVALID_INPUT');
  if (
    !agents ||
    typeof agents.haltTenantAgents !== 'function' ||
    typeof agents.releaseTenantAgents !== 'function'
  )
    throw new AppError('PREREQUISITES_INCOMPLETE');
  await tx.insert(standingChanges).values({
    organizationId: context.organizationId,
    fromLifecycle: org.lifecycle,
    toLifecycle: input.to,
    reasonCode: input.reasonCode,
    collectionPolicyId:
      input.actor.type === 'system' ? (input.actor.collectionPolicyId ?? null) : null,
    actorType: input.actor.type,
    actorRef: input.actor.ref,
  });
  await tx
    .update(organizations)
    .set({ lifecycle: input.to })
    .where(eq(organizations.id, context.organizationId));
  if (input.to === 'active' || input.offboardingCancellationId)
    await agents.releaseTenantAgents(tx, context, input.reasonCode);
  else await agents.haltTenantAgents(tx, context, input.reasonCode);
  await emit(tx, context, {
    eventType: TENANT_STANDING_CHANGED,
    aggregateType: AGGREGATE_ORGANIZATION,
    aggregateId: context.organizationId,
    aggregateVersion: 1,
    classification: 'internal',
    payload: {
      organization_id: context.organizationId,
      from: org.lifecycle,
      to: input.to,
      reason_code: input.reasonCode,
    },
  });
  const owners = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(
        eq(memberships.organizationId, context.organizationId),
        eq(memberships.role, 'owner'),
        eq(memberships.status, 'active'),
      ),
    );
  await notify(
    tx,
    context,
    owners.map((owner) => owner.id),
    NOTIFY_STANDING_CHANGED,
    organizationTargetRef(context.organizationId),
  );
  return 'changed';
}

/**
 * For handing M6's export service a context that can write in any standing, since a customer leaving or
 * suspended must still be able to get their data out (ADR-032 D5). Nothing else should need this.
 */
export const forExportInAnyStanding = (context: TenantContext) => accountContextOf(context);

/** Account status is visible to every member, without invoice or billing contact details. */
export async function getTenantStanding(database: AppDatabase, context: TenantContext) {
  if (context.actorType !== 'user') throw new AppError('NOT_FOUND');
  return withAccountTx(database, context, async (tx) => {
    const [org] = await tx
      .select({ lifecycle: organizations.lifecycle })
      .from(organizations)
      .where(eq(organizations.id, context.organizationId));
    if (!org || org.lifecycle === 'deleted') throw new AppError('NOT_FOUND');
    const change = await loadEntitlementMetadataInTx(tx, context);
    return {
      lifecycle: org.lifecycle,
      reasonCode: change.standingReasonCode,
      changedAt: change.standingChangedAt,
    };
  });
}

export type AccountSurface = 'core' | 'account';

/**
 * Whether this person may use this surface. `core` is everything ordinary, and `account` is billing, export,
 * support and leaving. A suspended or leaving tenant loses `core`, as a TENANT_SUSPENDED error the web tier
 * turns into its own page. A read-only one keeps its reads, and PostgreSQL refuses its writes. Fixed by the
 * foundation, because every route and page goes through it. Pure on the context, so it is cheap.
 */
export function assertServing(context: TenantContext, surface: AccountSurface): void {
  if (surface === 'account') return;
  if (context.serving === 'suspended' || context.serving === 'offboarding') {
    throw new AppError('TENANT_SUSPENDED');
  }
}

/**
 * A trusted operator capability, implemented at the composition root. General application identity reads
 * cannot look up an unrelated person. Preparing binds a request key to a hash and that existing person;
 * an already completed key refuses and never reissues a token. The invitation write validates that
 * capability in the caller's transaction, stores only its hash and activates no membership. A separate
 * single-use consumer must verify the matching signed-in person before activating the owner membership.
 * Neither method may be implemented with a general application-role identity or owner-creation grant.
 */
export interface TenantProvisioningPort {
  prepare(input: {
    ownerEmail: string;
    operatorRef: string;
    requestKey: string;
    requestHash: string;
  }): Promise<{
    ownerUserId: string;
    organizationId: string;
    ownerMembershipId: string;
    capability: string;
  } | null>;
  issueOwnerInvitationInTx(
    tx: Tx,
    input: {
      ownerUserId: string;
      organizationId: string;
      ownerMembershipId: string;
      capability: string;
      requestKey: string;
      requestHash: string;
      invitationTokenHash: string;
      operatorRef: string;
    },
  ): Promise<void>;
}

const operatorReference = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !/[\r\n\0]/.test(value));
export const tenantCommandInputSchemas = {
  provision: z.strictObject({
    organizationName: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .refine((value) => !/[\r\n\0]/.test(value)),
    commercialMode: z.enum(['cloud', 'byom']),
    ownerEmail: z
      .email()
      .max(254)
      .transform((value) => value.trim().toLowerCase()),
    planVersionId: idSchema,
    operatorRef: operatorReference,
    requestKey: z
      .string()
      .min(16)
      .max(128)
      .refine((value) => !/[\r\n\0]/.test(value)),
  }),
  standing: z.strictObject({
    organizationId: idSchema,
    operatorRef: operatorReference,
    reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  }),
};

/** Provisions an existing person's tenant and returns its bootstrap invitation once, over a private route. */
export async function provisionTenant(
  database: AppDatabase,
  input: {
    organizationName: string;
    commercialMode: 'cloud' | 'byom';
    ownerEmail: string;
    planVersionId: string;
    operatorRef: string;
    requestKey: string;
  },
  provisioner?: TenantProvisioningPort,
  deliverInvitation?: (result: {
    organizationId: string;
    invitationToken: string;
  }) => Promise<void>,
): Promise<{ organizationId: string; invitationToken: string }> {
  const parsed = tenantCommandInputSchemas.provision.safeParse(input);
  if (
    !parsed.success ||
    /[\r\n\0]/.test(
      input.organizationName + input.ownerEmail + input.operatorRef + input.requestKey,
    )
  )
    throw new AppError('INVALID_INPUT');
  if (!provisioner) throw new AppError('PREREQUISITES_INCOMPLETE');
  const values = parsed.data;
  const requestHash = createHash('sha256').update(JSON.stringify(values)).digest('hex');
  const prepared = await provisioner.prepare({
    ownerEmail: values.ownerEmail,
    operatorRef: values.operatorRef,
    requestKey: values.requestKey,
    requestHash,
  });
  if (!prepared) throw new AppError('NOT_FOUND');
  if (
    ![prepared.ownerUserId, prepared.organizationId, prepared.ownerMembershipId].every(
      (id) => idSchema.safeParse(id).success,
    ) ||
    !prepared.capability
  )
    throw new AppError('PREREQUISITES_INCOMPLETE');
  const invitationToken = randomBytes(32).toString('base64url');
  const context = createServiceContext(prepared.organizationId);
  return withNewTenantTx(database, prepared.organizationId, prepared.ownerUserId, async (tx) => {
    const plan = await loadPlanTerms(tx, values.planVersionId);
    if (!plan || !canStartOn(plan, values.commercialMode)) throw new AppError('PLAN_NOT_AVAILABLE');
    await tx.insert(organizations).values({
      id: prepared.organizationId,
      name: values.organizationName,
      commercialMode: values.commercialMode,
    });
    await tx.insert(memberships).values({
      organizationId: prepared.organizationId,
      id: prepared.ownerMembershipId,
      userId: prepared.ownerUserId,
      role: 'owner',
      status: 'invited',
    });
    await emit(tx, context, {
      eventType: 'organization.created',
      aggregateType: AGGREGATE_ORGANIZATION,
      aggregateId: prepared.organizationId,
      aggregateVersion: 1,
      classification: 'internal',
      payload: { organization_id: prepared.organizationId },
    });
    await appendAudit(tx, {
      organizationId: prepared.organizationId,
      actorType: 'service',
      action: 'organization.provisioned',
      targetRef: `organization:${prepared.organizationId}`,
      decision: 'allow',
      safeReason: 'OPERATOR_PROVISIONING',
    });
    await startSubscriptionInTx(tx, context, { planVersionId: values.planVersionId });
    await provisioner.issueOwnerInvitationInTx(tx, {
      ...prepared,
      requestKey: values.requestKey,
      requestHash,
      invitationTokenHash: createHash('sha256').update(invitationToken).digest('hex'),
      operatorRef: values.operatorRef,
    });
    const result = { organizationId: prepared.organizationId, invitationToken };
    // Private delivery succeeds before committing a bootstrap whose token is stored only as a hash.
    await deliverInvitation?.(result);
    return result;
  });
}
