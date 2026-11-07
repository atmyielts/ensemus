import { describe, expect, it } from 'vitest';
import {
  companyPulseSchema,
  pulseQuerySchema,
  setPulseSignalStateSchema,
} from '@ensemus/contracts/experience';
import { PULSE_SIGNAL_KINDS } from '@ensemus/domain/pulse';

describe('Pulse HTTP contracts', () => {
  it('keeps its signal vocabulary aligned with actual pure rules', () => {
    expect(companyPulseSchema.shape.signals.element.shape.kind.options).toEqual([
      ...PULSE_SIGNAL_KINDS,
    ]);
  });
  it('admits only explicit current-viewer preferences and query choices', () => {
    expect(pulseQuerySchema.parse({})).toEqual({ include_dismissed: false });
    expect(pulseQuerySchema.parse({ include_dismissed: 'true' })).toEqual({
      include_dismissed: true,
    });
    expect(pulseQuerySchema.safeParse({ include_dismissed: 'anything' }).success).toBe(false);
    expect(
      setPulseSignalStateSchema.safeParse({ state: 'dismissed', membership_id: 'another-person' })
        .success,
    ).toBe(false);
    expect(setPulseSignalStateSchema.safeParse({ state: 'snoozed' }).success).toBe(false);
    expect(
      setPulseSignalStateSchema.safeParse({ state: 'open', until: new Date().toISOString() })
        .success,
    ).toBe(false);
  });
});
