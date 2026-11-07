import { describe, it, expect } from 'vitest';
import { onboardingStatus, type OnboardingFacts } from './onboarding';
const ready: OnboardingFacts = {
  responsibilityAcknowledged: true,
  activeMembers: 2,
  pendingInvitations: 0,
  teams: 1,
  projects: 0,
  knowledgeSources: 0,
  activeModelProfiles: 0,
  actorHasSecondFactor: true,
  passedSimulations: 1,
  workUnits: 1,
  skipped: [],
};
describe('company onboarding from actual facts', () => {
  it('keeps core finished when both AI setup ports are unavailable', () => {
    const result = onboardingStatus({
      ...ready,
      knowledgeSources: null,
      activeModelProfiles: null,
    });
    expect(result.finished).toBe(true);
    expect(result.next).toBeNull();
    expect(result.steps.filter((s) => s.state === 'unavailable').map((s) => s.key)).toEqual([
      'first_knowledge_source',
      'model_provider',
    ]);
  });
  it('does not let required-step skip assertions create completion', () => {
    const result = onboardingStatus({
      ...ready,
      actorHasSecondFactor: false,
      skipped: ['second_factor'],
    });
    expect(result.finished).toBe(false);
    expect(result.steps.find((s) => s.key === 'second_factor')?.state).toBe('to_do');
  });
  it('allows explicitly skipping optional setup, and real later records supersede that skip', () => {
    expect(
      onboardingStatus({ ...ready, skipped: ['first_knowledge_source'] }).steps.find(
        (s) => s.key === 'first_knowledge_source',
      )?.state,
    ).toBe('skipped');
    expect(
      onboardingStatus({
        ...ready,
        knowledgeSources: 1,
        skipped: ['first_knowledge_source'],
      }).steps.find((s) => s.key === 'first_knowledge_source')?.state,
    ).toBe('done');
  });
  it('counts actual pending invitations or another active person, and actual structure', () => {
    expect(
      onboardingStatus({ ...ready, activeMembers: 1, pendingInvitations: 1, teams: 0, projects: 1 })
        .finished,
    ).toBe(true);
    expect(onboardingStatus({ ...ready, activeMembers: 1, pendingInvitations: 0 }).finished).toBe(
      false,
    );
    expect(onboardingStatus({ ...ready, teams: 0, projects: 0 }).finished).toBe(false);
  });
  it.each(['responsibilityAcknowledged', 'actorHasSecondFactor'] as const)(
    'requires actual %s',
    (key) => expect(onboardingStatus({ ...ready, [key]: false }).finished).toBe(false),
  );
  it.each(['passedSimulations', 'workUnits'] as const)('does not make absent %s green', (key) =>
    expect(onboardingStatus({ ...ready, [key]: 0 }).finished).toBe(false),
  );
  it('does not count invalid numeric assertions as real facts', () =>
    expect(onboardingStatus({ ...ready, workUnits: Infinity }).finished).toBe(false));
});
