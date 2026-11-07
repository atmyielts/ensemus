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
export function onboardingStatus(facts: OnboardingFacts): OnboardingStatus {
  const positive = (n: number) => Number.isSafeInteger(n) && n > 0;
  const optional = new Set<OnboardingStepKey>(['first_knowledge_source', 'model_provider']);
  const done: Record<OnboardingStepKey, boolean> = {
    responsibility_statement: facts.responsibilityAcknowledged === true,
    invite_team:
      (Number.isSafeInteger(facts.activeMembers) && facts.activeMembers > 1) ||
      positive(facts.pendingInvitations),
    company_structure: positive(facts.teams) || positive(facts.projects),
    first_knowledge_source: facts.knowledgeSources !== null && positive(facts.knowledgeSources),
    model_provider: facts.activeModelProfiles !== null && positive(facts.activeModelProfiles),
    second_factor: facts.actorHasSecondFactor === true,
    first_simulation: positive(facts.passedSimulations),
    first_work_unit: positive(facts.workUnits),
  };
  const steps = ONBOARDING_STEPS.map((key) => ({
    key,
    optional: optional.has(key),
    state: (done[key]
      ? 'done'
      : optional.has(key) && facts.skipped.includes(key)
        ? 'skipped'
        : (key === 'first_knowledge_source' && facts.knowledgeSources === null) ||
            (key === 'model_provider' && facts.activeModelProfiles === null)
          ? 'unavailable'
          : 'to_do') as OnboardingStepState,
  }));
  const finished = steps.every((step) => step.optional || step.state === 'done');
  return {
    steps,
    finished,
    next: finished ? null : (steps.find((step) => step.state === 'to_do')?.key ?? null),
  };
}
