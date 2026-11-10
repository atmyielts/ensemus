// No external dependency. Never imported by shipped apps/workers. Only generated fixture accounts may
// be supplied. No response body, credential, tenant identifier or error message is kept in a report.
import { scenarios } from './profiles.mjs';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setInterval, clearInterval, setTimeout, clearTimeout } from 'node:timers';
import { URL } from 'node:url';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const machineRef = (value) => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,120}$/.test(value);
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const nonnegative = (value) => Number.isFinite(value) && value >= 0;
export function summarize(samples) {
  if (
    !Array.isArray(samples) ||
    samples.some((sample) => !nonnegative(sample.durationMs) || typeof sample.ok !== 'boolean')
  )
    throw new Error('SAMPLES_INVALID');
  const sorted = samples.map((sample) => sample.durationMs).sort((a, b) => a - b),
    count = sorted.length;
  const percentile = (rank) => (count ? sorted[Math.ceil(rank * count) - 1] : null);
  return {
    count,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    errorRate: count ? samples.filter((sample) => !sample.ok).length / count : null,
  };
}
export function fairness(perTenant) {
  const values = Object.values(perTenant).map((samples) => summarize(samples).p95);
  if (!values.length || values.some((value) => value === null || value <= 0))
    return { worstToBestP95Ratio: null };
  return { worstToBestP95Ratio: Math.max(...values) / Math.min(...values) };
}
export function validateProfile(profile) {
  if (
    !profile ||
    profile.kind !== 'test-persona' ||
    !Object.hasOwn(scenarios, profile.scenario) ||
    ![
      'personaPeople',
      'tenantCount',
      'concurrencyPerTenant',
      'requestsPerTenant',
      'documents',
      'activeClients',
      'activeProjects',
      'workUnits',
      'concurrentModelCalls',
      'connectedApps',
      'requestTimeoutMs',
      'responseBodyLimitBytes',
      'eventLoopProbeIntervalMs',
      'scenarioTimeoutMs',
    ].every((key) => positive(profile[key])) ||
    !(
      (profile.retentionDays === null && profile.retentionBasisRef === null) ||
      (positive(profile.retentionDays) && machineRef(profile.retentionBasisRef))
    ) ||
    profile.concurrencyPerTenant > profile.personaPeople ||
    profile.concurrencyPerTenant > profile.requestsPerTenant
  )
    throw new Error('PROFILE_INVALID');
  return profile;
}
export function validateTarget(profile, target) {
  if (!target?.baseUrl) throw new Error('EXPLICIT_BASE_URL_REQUIRED');
  const url = new URL(target.baseUrl);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('BASE_URL_INVALID');
  if (
    target.generated !== true ||
    !Array.isArray(target.tenants) ||
    target.tenants.length !== profile.tenantCount
  )
    throw new Error('GENERATED_FIXTURE_REQUIRED');
  const organizations = new Set(),
    users = new Set(),
    cookies = new Set();
  for (const tenant of target.tenants) {
    if (
      !uuid.test(tenant.organizationId) ||
      organizations.has(tenant.organizationId) ||
      !Array.isArray(tenant.actors) ||
      tenant.actors.length < profile.concurrencyPerTenant
    )
      throw new Error('TENANT_FIXTURE_INVALID');
    organizations.add(tenant.organizationId);
    for (const person of tenant.actors) {
      if (
        !uuid.test(person.userId) ||
        users.has(person.userId) ||
        typeof person.email !== 'string' ||
        !/^load-[a-z0-9-]+@example\.invalid$/.test(person.email) ||
        typeof person.cookie !== 'string' ||
        !person.cookie ||
        person.cookie.length > 8192 ||
        /[\r\n\0]/.test(person.cookie) ||
        cookies.has(person.cookie)
      )
        throw new Error('GENERATED_ACTOR_REQUIRED');
      users.add(person.userId);
      cookies.add(person.cookie);
    }
  }
  const context = target.context,
    hardware = context?.hardware;
  if (
    !context ||
    !machineRef(context.environmentRef) ||
    !machineRef(context.release) ||
    !['loopback', 'same_host', 'same_network', 'remote', 'unknown'].includes(
      context.networkLocality,
    ) ||
    !hardware ||
    !machineRef(hardware.cpuModelRef) ||
    !machineRef(hardware.osRef) ||
    !positive(hardware.logicalCpus) ||
    !positive(hardware.memoryBytes)
  )
    throw new Error('MEASUREMENT_CONTEXT_REQUIRED');
  return {
    origin: url.origin,
    context: {
      environmentRef: context.environmentRef,
      release: context.release,
      networkLocality: context.networkLocality,
      hardware: {
        cpuModelRef: hardware.cpuModelRef,
        logicalCpus: hardware.logicalCpus,
        memoryBytes: hardware.memoryBytes,
        osRef: hardware.osRef,
      },
    },
  };
}
const defaultClock = {
  now: () => performance.now(),
  fetch: (url, options) => fetch(url, options),
  monitorDelay: (record, intervalMs) => {
    let expected = performance.now() + intervalMs;
    const timer = setInterval(() => {
      const now = performance.now();
      record(Math.max(0, now - expected));
      expected = now + intervalMs;
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  },
};
function observedDurations(values) {
  if (!Array.isArray(values) || values.some((value) => !nonnegative(value)))
    throw new Error('OBSERVATIONS_INVALID');
  return summarize(values.map((durationMs) => ({ durationMs, ok: true })));
}
async function consume(response, limit) {
  if (!response.body) return;
  const reader = response.body.getReader();
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new Error('BODY_LIMIT');
      }
    }
  } finally {
    reader.releaseLock();
  }
}
/** Controls must be reviewed, local and isolated-environment-specific. Their output is projected below.
 * exercise runs CONCURRENTLY with reads; verify must return actual recovery/integrity observations.
 * B must enqueue real agents and observe queue wait. C–L must actually induce their named condition.
 */
export async function runProfile(input, target, clock = defaultClock) {
  const profile = validateProfile(input),
    { origin, context } = validateTarget(profile, target),
    scenario = scenarios[profile.scenario];
  const controls = target.controls;
  if (
    scenario.requiresControls &&
    (!controls || typeof controls.exercise !== 'function' || typeof controls.verify !== 'function')
  )
    throw new Error('SCENARIO_CONTROLS_REQUIRED');
  if (
    !clock ||
    typeof clock.now !== 'function' ||
    typeof clock.fetch !== 'function' ||
    typeof clock.monitorDelay !== 'function'
  )
    throw new Error('CLOCK_INVALID');
  const perTenant = Object.fromEntries(
      target.tenants.map((_, index) => [`tenant-${index + 1}`, []]),
    ),
    samples = [],
    ttfb = [],
    delays = [];
  let controlsFailed = false,
    observations = null,
    exerciseError = null;
  const start = clock.now(),
    stop = clock.monitorDelay((durationMs) => {
      if (nonnegative(durationMs)) delays.push(durationMs);
    }, profile.eventLoopProbeIntervalMs);
  const runRef = randomUUID(),
    scenarioController = new globalThis.AbortController();
  let scenarioTimer;
  async function controlled(operation) {
    let timeout;
    const expired = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        scenarioController.abort();
        reject(new Error('SCENARIO_DEADLINE'));
      }, profile.scenarioTimeoutMs);
    });
    scenarioTimer = timeout;
    try {
      return await Promise.race([Promise.resolve().then(operation), expired]);
    } finally {
      clearTimeout(timeout);
    }
  }
  async function read(tenant, actor, tenantIndex) {
    const controller = new globalThis.AbortController(),
      timer = setTimeout(() => controller.abort(), profile.requestTimeoutMs);
    timer.unref();
    const began = clock.now();
    let ok = false,
      status = null;
    try {
      const response = await clock.fetch(
        `${origin}/api/v1/organizations/${tenant.organizationId}/work-units`,
        {
          method: 'GET',
          redirect: 'error',
          signal: controller.signal,
          headers: { cookie: actor.cookie, origin, accept: 'application/json' },
        },
      );
      const firstByte = clock.now() - began;
      if (!nonnegative(firstByte)) throw new Error('CLOCK_INVALID');
      ttfb.push({ durationMs: firstByte, ok: response.ok });
      status = response.status;
      await consume(response, profile.responseBodyLimitBytes);
      ok =
        response.ok &&
        response.headers.get('content-type')?.toLowerCase().includes('application/json') === true;
    } catch {
      /* Every thrown request remains a failed sample; response/error text is discarded. */
    } finally {
      clearTimeout(timer);
    }
    const durationMs = clock.now() - began;
    if (!nonnegative(durationMs)) throw new Error('CLOCK_INVALID');
    const sample = { durationMs, ok, status };
    samples.push(sample);
    perTenant[`tenant-${tenantIndex + 1}`].push(sample);
  }
  try {
    // Catch immediately so a control failure cannot become an unhandled rejection while reads run.
    const exercise = scenario.requiresControls
      ? controlled(() =>
          controls.exercise({
            scenario: profile.scenario,
            profile,
            tenants: target.tenants,
            baseUrl: origin,
            runRef,
            signal: scenarioController.signal,
          }),
        ).catch((error) => {
          exerciseError = error;
          controlsFailed = true;
        })
      : Promise.resolve();
    await Promise.resolve(); // Let the control begin before launching the first business read.
    await Promise.all(
      target.tenants.map(async (tenant, tenantIndex) => {
        let next = 0;
        await Promise.all(
          Array.from({ length: profile.concurrencyPerTenant }, async (_, worker) => {
            for (;;) {
              const index = next++;
              if (index >= profile.requestsPerTenant) return;
              await read(tenant, tenant.actors[worker], tenantIndex);
            }
          }),
        );
      }),
    );
    await exercise;
    if (scenario.requiresControls && !controlsFailed) {
      try {
        observations = await controlled(() =>
          controls.verify({
            scenario: profile.scenario,
            tenants: target.tenants,
            baseUrl: origin,
            runRef,
            signal: scenarioController.signal,
          }),
        );
      } catch {
        controlsFailed = true;
      }
    }
  } finally {
    stop();
    scenarioController.abort();
    clearTimeout(scenarioTimer);
  }
  // A malformed observation refuses completion rather than inventing an empty healthy measurement.
  const agentQueueWait =
    observations?.agentQueueWaitMs === undefined
      ? { status: 'owed', summary: null }
      : { status: 'measured', summary: observedDurations(observations.agentQueueWaitMs) };
  let verification = 'owed';
  if (scenario.requiresControls) {
    if (controlsFailed || exerciseError) verification = 'failed';
    else if (
      observations?.conditionInduced === true &&
      observations?.loadOverlappedReads === true &&
      observations?.recovered === true &&
      observations?.isolationVerified === true &&
      observations?.noDuplicateEffects === true &&
      (profile.scenario !== 'B' ||
        (agentQueueWait.status === 'measured' && agentQueueWait.summary.count > 0))
    )
      verification = 'passed';
    else verification = 'failed';
  }
  let costPerVerifiedOutcome = {
    status: 'owed',
    currency: null,
    numeratorMicros: null,
    verifiedOutcomes: null,
  };
  if (typeof target.readVerifiedOutcomeCost === 'function') {
    const fact = await target.readVerifiedOutcomeCost({
      runRef,
      organizationIds: target.tenants.map((tenant) => tenant.organizationId),
      scenario: profile.scenario,
    });
    if (
      fact?.source !== 'actual_m4_ledger' ||
      fact.runRef !== runRef ||
      !/^[A-Z]{3}$/.test(fact.currency) ||
      !/^[0-9]+$/.test(fact.totalCostMicros) ||
      !positive(fact.verifiedOutcomes)
    )
      throw new Error('LEDGER_COST_BASIS_INVALID');
    costPerVerifiedOutcome = {
      status: 'measured',
      currency: fact.currency,
      numeratorMicros: fact.totalCostMicros,
      verifiedOutcomes: fact.verifiedOutcomes,
    };
  }
  const parameters = Object.fromEntries(
    [
      'kind',
      'personaPeople',
      'tenantCount',
      'concurrencyPerTenant',
      'requestsPerTenant',
      'documents',
      'activeClients',
      'activeProjects',
      'workUnits',
      'concurrentModelCalls',
      'connectedApps',
      'retentionDays',
      'retentionBasisRef',
      'requestTimeoutMs',
      'responseBodyLimitBytes',
      'eventLoopProbeIntervalMs',
      'scenarioTimeoutMs',
    ].map((key) => [key, profile[key]]),
  );
  return {
    schemaVersion: 1,
    kind: 'local-measurement',
    runRef,
    targetOrigin: origin,
    context,
    parameters,
    scenario: { id: profile.scenario, name: scenario.name, verification },
    durationMs: clock.now() - start,
    web: summarize(samples),
    webTtfb: summarize(ttfb),
    eventLoopDelay: observedDurations(delays),
    agentQueueWait,
    tenants: Object.entries(perTenant).map(([label, values]) => ({
      label,
      web: summarize(values),
    })),
    fairness: fairness(perTenant),
    costPerVerifiedOutcome,
    capacityClaim: false,
    limitations: [
      'No production capacity or SLA inferred.',
      'A baseline read run does not execute the other scenarios.',
      'Persona dataset counts are declared inputs; fixture population needs independent evidence.',
    ],
  };
}
