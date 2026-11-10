import type { OffboardingOutcome, OffboardingStepResult } from './saas-schemas';

export async function runOffboarding(ports: {
  advance(): Promise<OffboardingStepResult>;
  now(): number;
  sleep(ms: number): Promise<void>;
  restart?(): Promise<never>;
}): Promise<OffboardingOutcome> {
  for (let steps = 0; ; steps++) {
    if (steps === 100 && ports.restart) return ports.restart();
    const step = await ports.advance();
    if (step.kind === 'stop') return step.outcome;
    if (step.kind === 'wait') {
      const remaining = step.untilMs - ports.now();
      if (remaining > 0) await ports.sleep(remaining);
    }
  }
}
