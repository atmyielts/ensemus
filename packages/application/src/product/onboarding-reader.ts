import { createHash } from 'node:crypto';
import {
  memberships,
  invitations,
  teams,
  projects,
  users,
  workUnits,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import {
  onboardingSteps,
  onboardingCompletions,
  simulationRuns,
  simulationInputs,
} from '@ensemus/database/product';
import { canonicalJson } from '@ensemus/domain/approval';
import {
  onboardingStatus,
  type OnboardingFacts,
  type OnboardingStatus,
} from '@ensemus/domain/onboarding';
import type { SimulationReport } from '@ensemus/domain/simulation';
import { BUNDLED_WORKFLOWS } from '@ensemus/packs/bundled';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { AppError } from '../errors';
import { visibleTo } from '../work';
import { compileCurrentProcess, type SimulationView } from './simulations';

export type CompanyOnboardingView = OnboardingStatus & {
  completionRecorded: boolean;
  latestSimulation: { id: string; status: SimulationView['status']; usable: boolean } | null;
};
export type OptionalSetup = { knowledgeSources: number | null; activeModelProfiles: number | null };
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Only bounded positive witnesses are needed; none of these values is an advertised tenant total. */
export async function onboardingSnapshot(tx: Tx, actor: TenantContext, optional: OptionalSetup) {
  const members = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(eq(memberships.status, 'active'))
    .limit(2);
  const invites = await tx
    .select({ id: invitations.id })
    .from(invitations)
    .where(
      and(
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
        sql`${invitations.expiresAt}>clock_timestamp()`,
      ),
    )
    .limit(1);
  const structure = await tx.select({ id: teams.id }).from(teams).limit(1);
  const project = structure.length
    ? []
    : await tx.select({ id: projects.id }).from(projects).limit(1);
  const work = await tx
    .select({ id: workUnits.id })
    .from(workUnits)
    .where(visibleTo(actor))
    .limit(1);
  const [person] = await tx
    .select({ enrolled: users.twoFactorEnabled })
    .from(users)
    .where(eq(users.id, actor.userId));
  const choices = await tx.select().from(onboardingSteps);
  const [receipt] = await tx
    .select()
    .from(onboardingCompletions)
    .where(eq(onboardingCompletions.organizationId, actor.organizationId));
  const bundle = BUNDLED_WORKFLOWS[0];
  let latestSimulation: CompanyOnboardingView['latestSimulation'] = null,
    passedHash: string | null = null;
  if (bundle) {
    const compiled = await compileCurrentProcess(tx, bundle.graph, bundle.classification);
    const [row] = await tx
      .select({ run: simulationRuns })
      .from(simulationRuns)
      .innerJoin(
        simulationInputs,
        and(
          eq(simulationInputs.organizationId, simulationRuns.organizationId),
          eq(simulationInputs.simulationRunId, simulationRuns.id),
        ),
      )
      .where(
        and(
          eq(simulationRuns.subjectKind, 'bundled_workflow'),
          eq(simulationRuns.subjectKey, bundle.key),
          eq(simulationRuns.subjectSha256, compiled.hash),
          eq(simulationRuns.scenarioKey, bundle.scenario.key),
          eq(simulationInputs.sourceVersion, bundle.version),
          eq(simulationInputs.policyVersion, 'bundled-v1'),
          eq(simulationInputs.specCanonical, canonicalJson(compiled.spec)),
        ),
      )
      .orderBy(desc(simulationRuns.createdAt), desc(simulationRuns.id))
      .limit(1);
    if (row) {
      if (!['queued', 'running', 'passed', 'failed', 'errored'].includes(row.run.status))
        throw new AppError('INVALID_STATE');
      const report = row.run.report as SimulationReport | null;
      const usable =
        row.run.status === 'passed' &&
        !!report &&
        report.outcome === 'passed' &&
        report.subjectSha256 === compiled.hash &&
        row.run.reportSha256 === sha256(canonicalJson(report));
      latestSimulation = {
        id: row.run.id,
        status: row.run.status as SimulationView['status'],
        usable,
      };
      if (usable) passedHash = compiled.hash;
    }
  }
  const facts: OnboardingFacts = {
    responsibilityAcknowledged: choices.some(
      (c) => c.stepKey === 'responsibility_statement' && c.status === 'acknowledged',
    ),
    activeMembers: members.length,
    pendingInvitations: invites.length,
    teams: structure.length,
    projects: project.length,
    ...optional,
    actorHasSecondFactor: person?.enrolled === true,
    passedSimulations: latestSimulation?.usable ? 1 : 0,
    workUnits: work.length,
    skipped: choices
      .filter(
        (c) =>
          c.status === 'skipped' &&
          (c.stepKey === 'model_provider' || c.stepKey === 'first_knowledge_source'),
      )
      .map((c) => c.stepKey as 'model_provider' | 'first_knowledge_source'),
  };
  const view: CompanyOnboardingView = {
    ...onboardingStatus(facts),
    completionRecorded: !!receipt,
    latestSimulation,
  };
  return { view, passedHash };
}
