import { createLogger } from '@ensemus/telemetry';
import type { ProbeStep } from './schemas';

const log = createLogger('worker');

export async function recordProbeStep(probeId: string, step: ProbeStep): Promise<void> {
  log.info('probe.step', { probeId, step });
}

export type Activities = { recordProbeStep: typeof recordProbeStep };
