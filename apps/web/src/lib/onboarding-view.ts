// Progress outcomes use the same words on every onboarding page. Technical codes stay in details.
const outcomes = new Map<string, string>([
  [
    'AGENT_UNAVAILABLE',
    'Onboarding stopped because the approved brief agent or its model setup was unavailable. Ask an administrator to check the published client brief agent, active model and budget before starting another onboarding.',
  ],
  [
    'INITIATOR_UNAVAILABLE',
    'The person who requested this no longer has the access needed to continue. Ask an administrator to review their membership and permissions.',
  ],
  [
    'PARTICIPANT_UNAVAILABLE',
    'A named owner or reviewer is no longer available. Check their current membership before starting another onboarding.',
  ],
  [
    'REVIEWER_UNAVAILABLE',
    'The named reviewer is no longer assigned or eligible to review this brief. Open the brief work to check its owner and contributors.',
  ],
  [
    'WORK_CHANGED',
    'The linked work, its owner or its objective changed. Onboarding stopped so an earlier review cannot be used for a different outcome.',
  ],
  [
    'AGENT_FAILED',
    'The brief agent stopped without a completed result. Open the brief work to review its run and the recorded reason.',
  ],
  [
    'BRIEF_MISSING',
    'The run did not produce exactly one confirmed brief. Open the brief work to inspect its outputs before starting another onboarding.',
  ],
  [
    'BRIEF_UNAVAILABLE',
    'The brief or its supporting information is no longer available to this onboarding. Open the linked work to review current access.',
  ],
  [
    'EMAIL_FAILED',
    'The welcome email was not confirmed as sent. Open the email work to review the action and its recorded outcome.',
  ],
  [
    'EMAIL_OUTCOME_UNVERIFIED',
    'Email delivery could not be confirmed. It has not been automatically sent again. Review the email action and receipt before deciding what to do.',
  ],
]);

export function onboardingOutcomeMessage(code: string): string {
  return (
    outcomes.get(code) ??
    'Onboarding stopped because its saved inputs or permissions could not be confirmed. Open the linked work to review the current details.'
  );
}
