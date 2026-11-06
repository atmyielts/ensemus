import 'server-only';
import type { OffboardingAgentHaltPort } from '@ensemus/application/saas/ports';
import { getRuntime } from './runtime';

/** The composition root supplies an ownership-scoped M4 binding. Absence always refuses a transition. */
export function getOffboardingAgents(): OffboardingAgentHaltPort | undefined {
  return (
    getRuntime() as ReturnType<typeof getRuntime> & { offboardingAgents?: OffboardingAgentHaltPort }
  ).offboardingAgents;
}
