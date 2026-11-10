import type { OnboardingStepKey, OnboardingStepState } from '@ensemus/domain/onboarding';
export const SETUP_COPY: Record<
  OnboardingStepKey,
  { title: string; description: string; path: string; link: string }
> = {
  responsibility_statement: {
    title: 'Data and model responsibilities',
    description:
      'Read how your company controls access, approved destinations and model use before adding sensitive data.',
    path: '/settings',
    link: 'Company settings',
  },
  invite_team: {
    title: 'Invite your team',
    description: 'A second active person or a current invitation is recorded.',
    path: '/people',
    link: 'People and invitations',
  },
  company_structure: {
    title: 'Set up your company structure',
    description: 'At least one team or a project you can read is recorded.',
    path: '/people',
    link: 'People and teams',
  },
  first_knowledge_source: {
    title: 'Add a trusted source (optional)',
    description:
      'A source has been added. Indexing, freshness and provider authorization are checked on its own page.',
    path: '/knowledge',
    link: 'Company knowledge',
  },
  model_provider: {
    title: 'Add a model profile (optional)',
    description:
      'An active profile is configured. That does not prove provider connectivity, model quality or live qualification.',
    path: '/settings/models',
    link: 'Model profiles',
  },
  second_factor: {
    title: 'Protect your account',
    description:
      'Your current account has a second factor enrolled. Setup adds no new MFA prompt to ordinary work.',
    path: '/security/two-factor',
    link: 'Set up a second factor',
  },
  first_simulation: {
    title: 'Rehearse the first workflow',
    description:
      'Run the actual bundled client status update as a pure rehearsal. It shows possible steps, approvals and sends without performing them.',
    path: '/studio',
    link: 'Open Studio',
  },
  first_work_unit: {
    title: 'Create your first Work',
    description:
      'At least one Work item is currently readable. Creating it does not start an assistant or send a message.',
    path: '/compose',
    link: 'Describe an outcome',
  },
};
export function setupStateLabel(state: OnboardingStepState) {
  return {
    done: 'Recorded',
    skipped: 'Skipped for now',
    to_do: 'To do',
    unavailable: 'Not available here',
  }[state];
}
