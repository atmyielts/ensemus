// Guided onboarding (UX-21, Journey A in docs/01-product/02-personas-and-journeys.md). A step counts as done
// because the real record exists, never because someone clicked it. Owned by the composer-onboarding slice.

export const ONBOARDING_STEPS = [
  'responsibility_statement',
  'invite_team',
  'company_structure',
  'first_knowledge_source',
  'model_provider',
  'second_factor',
  'first_simulation',
  'first_work_unit',
] as const;
export type OnboardingStepKey = (typeof ONBOARDING_STEPS)[number];

/** What is true right now, read from the records themselves. */
export type OnboardingFacts = {
  responsibilityAcknowledged: boolean;
  activeMembers: number;
  pendingInvitations: number;
  teams: number;
  projects: number;
  /** Null while M5's port is unavailable. "Not available" is not the same as "not done". */
  knowledgeSources: number | null;
  /** Null while M4's port is unavailable. */
  activeModelProfiles: number | null;
  actorHasSecondFactor: boolean;
  passedSimulations: number;
  workUnits: number;
  skipped: readonly OnboardingStepKey[];
};

export type OnboardingStepState = 'done' | 'skipped' | 'to_do' | 'unavailable';

export type OnboardingStatus = {
  steps: readonly { key: OnboardingStepKey; state: OnboardingStepState; optional: boolean }[];
  /** Everything required is done. Journey A: AI stays optional and the rest still works. */
  finished: boolean;
  next: OnboardingStepKey | null;
};

/** Pure. The model provider is optional: incomplete provider setup never blocks the core. */
export function onboardingStatus(_facts: OnboardingFacts): OnboardingStatus {
  throw new Error('NOT_IMPLEMENTED');
}
