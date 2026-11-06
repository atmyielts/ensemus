// Owned by the payments slice (BILL-01, OPS-21). Failed payments follow the published rules, without data
// loss. With no approved policy nothing automatic happens, and a person decides. See ADR-032 D5.
import {
  auditEvents,
  appendAudit,
  billingAccounts,
  collectionCases,
  collectionPolicies,
  invoices,
  memberships,
  organizations,
  payments,
  subscriptions,
  type AppDatabase,
  type TenantContext,
} from '@ensemus/database';
import { withAccountTx } from '@ensemus/database/account';
import { nextCollectionStep } from '@ensemus/saas/payment';
import { NOTIFY_PAYMENT_FAILED, invoiceTargetRef } from '@ensemus/saas/events';
import { collectionStepsSchema } from '@ensemus/contracts/saas';
import { and, asc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import { AppError } from '../errors';
import { notify } from '../work';
import {
  afterInvoicePaidInTx,
  recoverCollectedStandingInTx,
  requestInvoicePaymentInTx,
} from './payments';
import { setTenantStandingInTx } from './standing';
import type { AgentHaltPort } from './ports';

export type CollectionOutcome = {
  opened: number;
  stepsTaken: number;
  /** Overdue with no approved policy. It waits for a person, and an operator's alert counts these. */
  noPolicy: number;
};

/**
 * Service only, from the billing cycle. For each overdue invoice: opens a case on the subscription's policy,
 * and takes each due step once, by moving `step_no` under the case's lock. `retry` asks for a new payment
 * only when none is live. `read_only` and `suspend` go through `setTenantStandingInTx`. Nothing deletes.
 * An invoice paid since resolves its case, and gives the tenant back its standing.
 */
export async function runCollections(
  database: AppDatabase,
  context: TenantContext,
  ports: { agents: AgentHaltPort },
  now: Date,
): Promise<CollectionOutcome> {
  if (context.actorType !== 'service') throw new AppError('NOT_FOUND');
  if (!Number.isFinite(now.getTime())) throw new AppError('INVALID_INPUT');
  return withAccountTx(database, context, async (tx) => {
    const [org] = await tx
      .select()
      .from(organizations)
      .where(eq(organizations.id, context.organizationId))
      .for('no key update');
    if (!org || org.lifecycle === 'deleted') throw new AppError('NOT_FOUND');
    if (org.commercialMode === 'sovereign') return { opened: 0, stepsTaken: 0, noPolicy: 0 };
    let opened = 0,
      stepsTaken = 0,
      noPolicy = 0;
    const cases = await tx
      .select({
        id: collectionCases.id,
        invoiceId: collectionCases.invoiceId,
        status: invoices.status,
      })
      .from(collectionCases)
      .innerJoin(invoices, eq(invoices.id, collectionCases.invoiceId))
      .where(eq(collectionCases.status, 'open'))
      .orderBy(asc(collectionCases.openedAt), asc(collectionCases.id))
      .limit(100);
    for (const row of cases) {
      if (row.status === 'paid')
        await afterInvoicePaidInTx(tx, context, { invoiceId: row.invoiceId }, ports.agents);
      if (row.status === 'void' && (await recoverCollectedStandingInTx(tx, context, ports.agents)))
        await tx
          .update(collectionCases)
          .set({
            status: 'written_off',
            resolvedAt: now,
            nextStepAt: null,
            version: sql`${collectionCases.version}+1`,
          })
          .where(eq(collectionCases.id, row.id));
    }
    const overdue = await tx
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.organizationId, context.organizationId),
          eq(invoices.status, 'open'),
          gt(invoices.totalMicros, 0n),
          lte(invoices.dueAt, now),
        ),
      )
      .orderBy(asc(invoices.dueAt), asc(invoices.id))
      .limit(100);
    for (const invoice of overdue) {
      // A top-up is prepaid capacity not yet delivered. It has no subscription collection policy and
      // never suspends existing service or triggers an automatic purchase/payment attempt.
      if (invoice.kind === 'top_up') {
        noPolicy += 1;
        continue;
      }
      const [sub] = invoice.subscriptionId
        ? await tx.select().from(subscriptions).where(eq(subscriptions.id, invoice.subscriptionId))
        : [];
      const [existingCase] = await tx
        .select({ policyId: collectionCases.collectionPolicyId })
        .from(collectionCases)
        .where(eq(collectionCases.invoiceId, invoice.id));
      const policyId = existingCase?.policyId ?? sub?.collectionPolicyId;
      const [policy] = policyId
        ? await tx.select().from(collectionPolicies).where(eq(collectionPolicies.id, policyId))
        : [];
      if (!policy || policy.status === 'draft') {
        noPolicy += 1;
        continue;
      }
      const parsed = collectionStepsSchema.safeParse(policy.steps);
      if (!parsed.success) throw new AppError('INVALID_INPUT');
      const created = await tx
        .insert(collectionCases)
        .values({
          organizationId: context.organizationId,
          invoiceId: invoice.id,
          collectionPolicyId: policy.id,
          nextStepAt: invoice.dueAt,
        })
        .onConflictDoNothing()
        .returning({ id: collectionCases.id });
      if (created.length) opened += 1;
      const [current] = await tx
        .select()
        .from(collectionCases)
        .where(eq(collectionCases.invoiceId, invoice.id))
        .for('update');
      if (!current || current.status !== 'open') continue;
      if (sub?.status === 'active')
        await tx
          .update(subscriptions)
          .set({ status: 'past_due', version: sub.version + 1, updatedAt: now })
          .where(eq(subscriptions.id, sub.id));
      let stepNo = current.stepNo;
      let version = current.version;
      for (;;) {
        const [uncertain] = await tx
          .select({ id: payments.id })
          .from(payments)
          .where(
            and(
              eq(payments.invoiceId, invoice.id),
              inArray(payments.status, ['sending', 'reconciling', 'unknown']),
            ),
          )
          .limit(1);
        if (uncertain) break;
        const decision = nextCollectionStep(parsed.data, invoice.dueAt!, stepNo, now);
        if (decision.kind === 'done') break;
        if (decision.kind === 'wait') {
          if (current.nextStepAt?.getTime() !== decision.until.getTime())
            await tx
              .update(collectionCases)
              .set({ nextStepAt: decision.until })
              .where(eq(collectionCases.id, current.id));
          break;
        }
        if (decision.action === 'notify') {
          const owners = await tx
            .select({ id: memberships.id })
            .from(memberships)
            .where(and(eq(memberships.role, 'owner'), eq(memberships.status, 'active')));
          await notify(
            tx,
            context,
            owners.map((row) => row.id),
            NOTIFY_PAYMENT_FAILED,
            invoiceTargetRef(invoice.id),
          );
        } else if (decision.action === 'retry') {
          const [account] = await tx
            .select({ processor: billingAccounts.processor })
            .from(billingAccounts)
            .where(eq(billingAccounts.organizationId, context.organizationId));
          if (!account?.processor) {
            const targetRef = `collection_case:${current.id}`;
            const [seen] = await tx
              .select({ id: auditEvents.id })
              .from(auditEvents)
              .where(
                and(
                  eq(auditEvents.action, 'billing.collection_blocked'),
                  eq(auditEvents.targetRef, targetRef),
                  eq(auditEvents.safeReason, 'PROCESSOR_NOT_CONFIGURED'),
                ),
              )
              .limit(1);
            if (!seen)
              await appendAudit(tx, {
                organizationId: context.organizationId,
                actorType: 'service',
                action: 'billing.collection_blocked',
                targetRef,
                decision: 'deny',
                safeReason: 'PROCESSOR_NOT_CONFIGURED',
              });
            break;
          }
          await requestInvoicePaymentInTx(tx, context, {
            invoiceId: invoice.id,
            processor: account.processor,
            now,
          });
        } else {
          const [standing] = await tx
            .select({ lifecycle: organizations.lifecycle })
            .from(organizations)
            .where(eq(organizations.id, context.organizationId));
          // A collection policy may reduce service, but cannot reverse offboarding or an operator stop.
          if (
            standing?.lifecycle === 'active' ||
            (standing?.lifecycle === 'read_only' && decision.action === 'suspend')
          )
            await setTenantStandingInTx(
              tx,
              context,
              {
                to: decision.action === 'read_only' ? 'read_only' : 'suspended',
                reasonCode:
                  decision.action === 'read_only' ? 'COLLECTION_READ_ONLY' : 'COLLECTION_SUSPEND',
                actor: { type: 'system', ref: 'system:collections', collectionPolicyId: policy.id },
              },
              ports.agents,
            );
        }
        stepNo = decision.stepNo;
        version += 1;
        stepsTaken += 1;
        await tx
          .update(collectionCases)
          .set({ stepNo, nextStepAt: decision.next, version })
          .where(eq(collectionCases.id, current.id));
      }
    }
    return { opened, stepsTaken, noPolicy };
  });
}
