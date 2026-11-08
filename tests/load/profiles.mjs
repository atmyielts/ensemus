// Generated test parameters, not commercial tiers or measured capacity. All may be overridden in a
// reviewed profile file. Headcount personas come from the cost/capacity plan; other numbers are inputs.
const profile = (personaPeople, tenantCount, concurrencyPerTenant, requestsPerTenant, modelCalls) =>
  Object.freeze({
    kind: 'test-persona',
    personaPeople,
    tenantCount,
    concurrencyPerTenant,
    requestsPerTenant,
    documents: personaPeople * 5,
    activeClients: Math.ceil(personaPeople / 4),
    activeProjects: personaPeople,
    workUnits: personaPeople * 10,
    concurrentModelCalls: modelCalls,
    connectedApps: 2,
    retentionDays: null,
    retentionBasisRef: null,
    scenario: 'A',
    requestTimeoutMs: 10000,
    responseBodyLimitBytes: 1024 * 1024,
    eventLoopProbeIntervalMs: 20,
    scenarioTimeoutMs: 60000,
  });
export const profiles = Object.freeze({
  small: profile(20, 1, 4, 200, 2),
  medium: profile(100, 1, 12, 600, 6),
  growing: profile(300, 1, 24, 1200, 12),
  multiTenantAggregate: profile(100, 4, 6, 600, 4),
});
export const scenarios = Object.freeze({
  A: { name: 'Baseline business API reads', requiresControls: false },
  B: { name: 'Agent burst alongside business reads', requiresControls: true },
  C: { name: 'Ingestion and indexing alongside business reads', requiresControls: true },
  D: { name: 'Model timeout and rate limits', requiresControls: true },
  E: { name: 'Temporal restart and workflow recovery', requiresControls: true },
  F: { name: 'Database failover', requiresControls: true },
  G: { name: 'Tenant cache invalidation and denial', requiresControls: true },
  H: { name: 'Multiple web replica consistency', requiresControls: true },
  I: { name: 'Partial external effect and crash reconciliation', requiresControls: true },
  J: { name: 'Offline Sovereign boot', requiresControls: true },
  K: { name: 'Mass source revocation', requiresControls: true },
  L: { name: 'BYOM credential rotation', requiresControls: true },
});
