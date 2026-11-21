// The metrics Ensemus emits (ADR-037 D3), and what code calls to record them. Like ./tracing this needs
// only the OpenTelemetry API, which records nothing until ./otel registers a provider, so with telemetry
// off this costs a function call. Each metric has a fixed name, a fixed list of attribute keys and, where
// an alert or dashboard panel reads it, the binding name that panel uses in infrastructure/observability.
// The exporter's views drop any attribute not listed here, and any metric not listed here.
import { metrics, type Attributes } from '@opentelemetry/api';
import { errorCode, isSafeValue } from './index';

export type MetricDefinition = {
  readonly name: string;
  readonly kind: 'histogram' | 'gauge';
  readonly unit: string;
  readonly description: string;
  readonly attributes: readonly string[];
  /** The `binding` an alert rule or dashboard panel names when it reads this metric. */
  readonly binding?: string;
};

export const METRICS = {
  webRequestDuration: {
    name: 'ensemus.web.request.duration',
    kind: 'histogram',
    unit: 'ms',
    description:
      'Time the web tier took to answer a request, by route pattern, method and status class',
    attributes: ['http.request.method', 'http.response.status_class', 'http.route'],
    binding: 'web_latency_histogram',
  },
  activityDuration: {
    name: 'ensemus.activity.duration',
    kind: 'histogram',
    unit: 'ms',
    description: 'Time a Temporal activity ran, by activity type and task queue',
    attributes: ['activityType', 'taskQueue', 'errorCode'],
  },
  activityScheduleToStart: {
    name: 'ensemus.activity.schedule_to_start',
    kind: 'histogram',
    unit: 'ms',
    description: 'Time an activity attempt waited in its task queue before a worker started it',
    attributes: ['activityType', 'taskQueue'],
    binding: 'agent_schedule_to_start_histogram',
  },
  outboxDead: {
    name: 'ensemus.outbox.dead',
    kind: 'gauge',
    unit: '{event}',
    description: 'Outbox events that stopped retrying, across all tenants',
    attributes: [],
    binding: 'outbox_dead_count',
  },
  unknownPayments: {
    name: 'ensemus.payments.unknown',
    kind: 'gauge',
    unit: '{payment}',
    description: 'Payments whose outcome is unknown, across all tenants',
    attributes: [],
    binding: 'unknown_payment_count',
  },
  unmatchedPaymentEvents: {
    name: 'ensemus.payment_events.unmatched',
    kind: 'gauge',
    unit: '{event}',
    description: 'Processor events no billing account matched, across all tenants',
    attributes: [],
    binding: 'unmatched_payment_event_count',
  },
} as const satisfies Record<string, MetricDefinition>;

const meter = () => metrics.getMeter('ensemus');

// Instruments are made on first use, after a provider may have been registered, and kept.
let activityDuration: ReturnType<ReturnType<typeof meter>['createHistogram']> | undefined;
let scheduleToStart: ReturnType<ReturnType<typeof meter>['createHistogram']> | undefined;

/**
 * Drops the instruments made so far. Before a provider is registered the API hands out ones that record
 * nothing, so ./otel calls this once it has registered its own.
 */
export function forgetInstruments(): void {
  activityDuration = undefined;
  scheduleToStart = undefined;
}

const safe = (value: string) => (isSafeValue(value) ? value : 'invalid');

/** One finished activity attempt. Names come from our code and Temporal; an error becomes its code. */
export function recordActivity(input: {
  activityType: string;
  taskQueue: string;
  durationMs: number;
  scheduleToStartMs?: number;
  error?: unknown;
}): void {
  activityDuration ??= meter().createHistogram(METRICS.activityDuration.name, {
    unit: METRICS.activityDuration.unit,
    description: METRICS.activityDuration.description,
  });
  scheduleToStart ??= meter().createHistogram(METRICS.activityScheduleToStart.name, {
    unit: METRICS.activityScheduleToStart.unit,
    description: METRICS.activityScheduleToStart.description,
  });
  const attributes: Attributes = {
    activityType: safe(input.activityType),
    taskQueue: safe(input.taskQueue),
  };
  activityDuration.record(Math.max(0, input.durationMs), {
    ...attributes,
    ...(input.error === undefined ? {} : { errorCode: errorCode(input.error) }),
  });
  if (input.scheduleToStartMs !== undefined && Number.isFinite(input.scheduleToStartMs))
    scheduleToStart.record(Math.max(0, input.scheduleToStartMs), attributes);
}

export type OperationalCounts = {
  deadOutboxEvents: number;
  unknownPayments: number;
  unmatchedPaymentEvents: number;
};

/**
 * Reports the three cross-tenant counts each time the exporter collects. `read` runs then, and a failed
 * read reports nothing for that round rather than a zero that would look like good news. Returns how to
 * stop.
 */
export function observeOperationalCounts(
  read: () => Promise<OperationalCounts>,
  onError: (error: unknown) => void = () => undefined,
): () => void {
  const m = meter();
  const gauge = (definition: MetricDefinition) =>
    m.createObservableGauge(definition.name, {
      unit: definition.unit,
      description: definition.description,
    });
  const dead = gauge(METRICS.outboxDead);
  const unknown = gauge(METRICS.unknownPayments);
  const unmatched = gauge(METRICS.unmatchedPaymentEvents);
  const callback = async (result: {
    observe: (instrument: typeof dead, value: number) => void;
  }) => {
    let counts: OperationalCounts;
    try {
      counts = await read();
    } catch (error) {
      onError(error);
      return;
    }
    const whole = (value: number) => Number.isSafeInteger(value) && value >= 0;
    if (whole(counts.deadOutboxEvents)) result.observe(dead, counts.deadOutboxEvents);
    if (whole(counts.unknownPayments)) result.observe(unknown, counts.unknownPayments);
    if (whole(counts.unmatchedPaymentEvents))
      result.observe(unmatched, counts.unmatchedPaymentEvents);
  };
  m.addBatchObservableCallback(callback, [dead, unknown, unmatched]);
  return () => m.removeBatchObservableCallback(callback, [dead, unknown, unmatched]);
}
