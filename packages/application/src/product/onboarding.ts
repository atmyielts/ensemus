import { type AppDatabase, type TenantContext, type Tx } from '@ensemus/database';
import { onboardingCompletions, onboardingSteps } from '@ensemus/database/product';
import { type OnboardingStepKey } from '@ensemus/domain/onboarding';
import { ONBOARDING_FINISHED } from '@ensemus/domain/product-events';
import { BUNDLED_WORKFLOWS } from '@ensemus/packs/bundled';
import { sql } from 'drizzle-orm';
import { AppError } from '../errors';
import { emit } from '../events';
import { auditAction } from '../work';
import { databaseInTransaction } from '../transaction-database';
import { experiencePerson, withExperienceTx } from './experience-authority';
import {
  onboardingSnapshot,
  type CompanyOnboardingView,
  type OptionalSetup,
} from './onboarding-reader';
import type { ProductPorts } from './ports';
import { requestSimulation, type SimulationView } from './simulations';

export type { CompanyOnboardingView } from './onboarding-reader';
type SetupPorts = Pick<ProductPorts, 'knowledge' | 'modelReadiness'>;
const companyTx = <T>(database: AppDatabase, context: TenantContext, fn: (tx: Tx) => Promise<T>) =>
  withExperienceTx(database, context, fn, 'INVALID_STATE');

async function optionalCount(read: () => Promise<number>): Promise<number | null> {
  try {
    const n = await read();
    if (!Number.isSafeInteger(n) || n < 0) throw new AppError('INVALID_STATE');
    return n;
  } catch (error) {
    if (error instanceof AppError && error.code === 'CAPABILITY_UNAVAILABLE') return null;
    throw error;
  }
}
/** A missing adapter is visible; an outage or malformed count must not become a fake zero. */
async function optionalSetup(
  database: AppDatabase,
  context: TenantContext,
  ports: SetupPorts,
): Promise<OptionalSetup> {
  await companyTx(database, context, (tx) => experiencePerson(tx, context, true));
  const knowledgeSources = await optionalCount(
    async () => (await ports.knowledge.summary(context)).sources,
  );
  const activeModelProfiles = await optionalCount(
    async () => (await ports.modelReadiness.summary(context)).activeProfiles,
  );
  return { knowledgeSources, activeModelProfiles };
}

/** Read-only: a page refresh never acknowledges or completes company setup. */
export async function getOnboarding(
  database: AppDatabase,
  context: TenantContext,
  ports: SetupPorts,
): Promise<CompanyOnboardingView> {
  const optional = await optionalSetup(database, context, ports);
  return companyTx(database, context, async (tx) =>
    onboardingSnapshot(tx, await experiencePerson(tx, context, true), optional).then((s) => s.view),
  );
}

/** This records only a human decision. All other steps are always derived from current records. */
export async function decideOnboardingStep(
  database: AppDatabase,
  context: TenantContext,
  ports: SetupPorts,
  input: { step: OnboardingStepKey; decision: 'acknowledged' | 'skipped' },
): Promise<CompanyOnboardingView> {
  const valid =
    (input.step === 'responsibility_statement' && input.decision === 'acknowledged') ||
    ((input.step === 'first_knowledge_source' || input.step === 'model_provider') &&
      input.decision === 'skipped');
  if (!valid) throw new AppError('INVALID_INPUT');
  const optional = await optionalSetup(database, context, ports);
  return companyTx(database, context, async (tx) => {
    const actor = await experiencePerson(tx, context, true);
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended('ensemus:company-onboarding:'||${actor.organizationId}::text,0))`,
    );
    await tx
      .insert(onboardingSteps)
      .values({
        organizationId: actor.organizationId,
        stepKey: input.step,
        status: input.decision,
        decidedByMembershipId: actor.membershipId,
      })
      .onConflictDoUpdate({
        target: [onboardingSteps.organizationId, onboardingSteps.stepKey],
        set: {
          status: input.decision,
          decidedByMembershipId: actor.membershipId,
          decidedAt: sql`clock_timestamp()`,
        },
      });
    const snapshot = await onboardingSnapshot(tx, actor, optional);
    if (
      snapshot.view.finished &&
      !snapshot.view.completionRecorded &&
      snapshot.view.latestSimulation?.usable &&
      snapshot.passedHash
    ) {
      const [receipt] = await tx
        .insert(onboardingCompletions)
        .values({
          organizationId: actor.organizationId,
          completedByMembershipId: actor.membershipId,
          firstSimulationId: snapshot.view.latestSimulation.id,
          firstSimulationSha256: snapshot.passedHash,
        })
        .onConflictDoNothing()
        .returning();
      if (receipt) {
        await emit(tx, actor, {
          eventType: ONBOARDING_FINISHED,
          aggregateType: 'company_onboarding',
          aggregateId: actor.organizationId,
          aggregateVersion: 1,
          classification: 'internal',
          payload: { simulation_id: receipt.firstSimulationId },
        });
        await auditAction(
          tx,
          actor,
          'onboarding.finished',
          `company_onboarding:${actor.organizationId}`,
        );
      }
    }
    return (await onboardingSnapshot(tx, actor, optional)).view;
  });
}

/** Uses the real immutable-input request/outbox and pure worker; never executes the workflow. */
export async function startFirstSimulation(
  database: AppDatabase,
  context: TenantContext,
  input: { processKey: string },
): Promise<SimulationView> {
  const first = BUNDLED_WORKFLOWS[0];
  if (!first || input.processKey !== first.key) throw new AppError('INVALID_INPUT');
  return companyTx(database, context, async (tx) => {
    const actor = await experiencePerson(tx, context, true);
    return requestSimulation(databaseInTransaction(tx), actor, {
      subject: { kind: 'bundled_workflow', processKey: first.key },
      scenarioKey: first.scenario.key,
    });
  });
}
