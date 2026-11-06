import { describe, expect, it } from 'vitest';
import { overallStatus, type IncidentOrigin, type PublishedIncident } from './operations';

const incident = (origin: IncidentOrigin): PublishedIncident => ({
  origin,
  severity: 'high',
  state: 'investigating',
  title: 'Test incident',
  startedAt: new Date('2026-01-01T00:00:00Z'),
  resolvedAt: null,
});
describe('published service status', () => {
  it('does not call an unavailable provider an Ensemus outage', () => {
    expect(overallStatus([incident('model_provider')])).toBe('provider_degraded');
    expect(overallStatus([incident('connector_provider')])).toBe('provider_degraded');
  });
  it('does not attribute an unknown cause to a provider', () => {
    expect(overallStatus([incident('unknown'), incident('model_provider')])).toBe('unknown');
  });
  it('keeps a known Ensemus incident visible alongside other origins', () => {
    expect(overallStatus([incident('unknown'), incident('ensemus')])).toBe('degraded');
  });
  it('reports no open published incidents as operational and ignores resolved history', () => {
    expect(overallStatus([])).toBe('operational');
    expect(
      overallStatus([{ ...incident('ensemus'), state: 'resolved', resolvedAt: new Date() }]),
    ).toBe('operational');
  });
});
