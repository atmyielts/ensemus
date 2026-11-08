import 'server-only';
import type { OffboardingAgentHaltPort } from '@ensemus/application/saas/ports';
import { createOffboardingAgentHaltPort } from '@ensemus/application/saas/offboarding-agent-port';

/** The composition root supplies an ownership-scoped M4 binding. Absence always refuses a transition. */
export function getOffboardingAgents(): OffboardingAgentHaltPort {
  return createOffboardingAgentHaltPort();
}
