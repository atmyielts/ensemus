// Owned by the flagship slice (AGENT-12). See docs/06-delivery/m5-slices.md and ADR-029 D12. Deal won to
// client onboarding, on the existing kernel: Work Units with dependencies, an agent's cited brief, a
// person's acceptance, one approved email through M3, and its receipt.
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type { OnboardingState } from '@ensemus/domain/knowledge';
import type { AgentRuns } from './ports';

export type StartOnboardingInput = {
  /** The deal's ID where it lives. A repeat answers CLIENT_ONBOARDING_EXISTS and starts nothing. */
  dealRef: string;
  clientName: string;
  projectName: string;
  /** The accountable owner of the work. Has to be an active member. */
  ownerMembershipId: string;
  /** Reviews the brief and approves the email. Never the owner: M2's SELF_APPROVAL stands. */
  reviewerMembershipId: string;
  /** The connection the welcome email goes through. It has to be able to send. */
  emailConnectionId: string;
  contactEmail: string;
};

/**
 * Needs `client_onboarding.start`. In one transaction: the client, the project, the parent Work Unit, its
 * three children with dependencies (brief, review, welcome email), the row, and the event.
 */
export function startClientOnboarding(
  _database: AppDatabase,
  _context: TenantContext,
  _input: StartOnboardingInput,
): Promise<{ onboardingId: string; workUnitId: string }> {
  throw new Error('NOT_IMPLEMENTED');
}

export type OnboardingView = {
  id: string;
  dealRef: string;
  state: OnboardingState;
  stateCode: string | null;
  clientId: string;
  projectId: string;
  workUnitId: string;
  /** From M4's ledger. Labelled an estimate wherever shown. Null when nothing has been measured. */
  costMicros: number | null;
  /** The email's receipt, on whose word. `unknown` stays unknown (ADR-027 D6). */
  receipt: { status: string; externalId: string | null } | null;
  version: number;
  createdAt: Date;
  finishedAt: Date | null;
};

/** NOT_FOUND unless the viewer can read the parent Work Unit. */
export function getClientOnboarding(
  _database: AppDatabase,
  _context: TenantContext,
  _onboardingId: string,
): Promise<OnboardingView> {
  throw new Error('NOT_IMPLEMENTED');
}

export type OnboardingStep = {
  state: OnboardingState;
  /** What the workflow does next. A run or a person moves it on, and the workflow only looks again. */
  waitFor: 'nothing' | 'agent_run' | 'person' | 'external_action';
};

/**
 * The workflow's one Activity: reads the row and the work and moves to the next state, requesting the
 * agent's run or the email's intent when it is time. Idempotent, because Activities retry. An `unknown`
 * email ends the onboarding `unknown` and it waits for a person, as it does everywhere.
 */
export function advanceClientOnboarding(
  _database: AppDatabase,
  _context: TenantContext,
  _deps: { agentRuns: AgentRuns },
  _input: { onboardingId: string },
): Promise<OnboardingStep> {
  throw new Error('NOT_IMPLEMENTED');
}
