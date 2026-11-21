// Sends traces and metrics to the collector an operator named, over OTLP/HTTP (ADR-037 D3). Nothing
// imports this unless telemetry is on, so a default install never loads it and cannot make an outbound
// attempt. Every path to the collector goes through an allowlist here, at the exporter, and not at the call
// sites: Next.js makes its own spans once a provider exists, and those carry the request path, where an
// invitation link keeps its token, and exception events, which carry an error's message.
//
// No propagator is registered, so a client's `traceparent` is not believed: a client cannot choose a trace
// ID or claim a sampling decision. No trace context crosses Temporal (ADR-024): tiers are joined by the IDs
// on their spans, as they are in the logs. The resource names the service and the release, and nothing
// about the host or the process.
import {
  context,
  metrics,
  propagation,
  trace,
  SpanKind,
  type Attributes,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { hrTimeToMilliseconds } from '@opentelemetry/core';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  AggregationType,
  createAllowListAttributesProcessor,
  MeterProvider,
  PeriodicExportingMetricReader,
  type MetricReader,
  type ViewOptions,
} from '@opentelemetry/sdk-metrics';
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  TracerProvider,
  type ReadableSpan,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace';
import { isSafeField, isSafeValue } from './index';
import { forgetInstruments, METRICS } from './metrics';

/** The setting @ensemus/config hands over. Repeated here so this package needs nothing from that one. */
export type TelemetrySettings =
  | { enabled: false }
  | { enabled: true; endpoint: string; sampleRatio: number; metricIntervalMs: number };

export type TelemetryHandle = { forceFlush(): Promise<void>; shutdown(): Promise<void> };

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
// A route pattern from our own source tree, such as /api/v1/organizations/[organizationId]/work-units. It
// holds the name of a segment and never its value, so it is safe; a real path is not, and fails this.
const ROUTE = /^\/[A-Za-z0-9_\-./[\]]{0,200}$/;
const routeOf = (value: unknown) =>
  typeof value === 'string' && ROUTE.test(value) && !value.includes('..') ? value : undefined;
const methodOf = (value: unknown) =>
  typeof value === 'string' && METHODS.has(value) ? value : undefined;
const statusOf = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;

/** The attributes a framework's span may keep, beyond the fields in the logger's allowlist. */
export const SPAN_ONLY_ATTRIBUTES: Readonly<Record<string, (value: unknown) => unknown>> = {
  'http.request.method': methodOf,
  'http.method': methodOf,
  'http.response.status_code': statusOf,
  'http.status_code': statusOf,
  'next.route': routeOf,
  'http.route': routeOf,
  'next.span_type': (value) =>
    typeof value === 'string' && /^[A-Za-z]+\.[A-Za-z]+$/.test(value) ? value : undefined,
};

function redactAttributes(attributes: Attributes): Attributes {
  const kept: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    const check = SPAN_ONLY_ATTRIBUTES[key];
    if (check) {
      const safe = check(value);
      if (safe !== undefined) kept[key] = safe as string | number;
      continue;
    }
    if (!isSafeField(key)) continue;
    if (typeof value === 'number' || typeof value === 'boolean') kept[key] = value;
    else if (typeof value === 'string' && isSafeValue(value)) kept[key] = value;
  }
  return kept;
}

/**
 * A span name that may leave: one that passes the logger's value check, or exactly `<method> <route
 * pattern>` with a pattern that names a segment rather than holding a value. Anything else is replaced.
 */
function redactName(name: string, attributes: Attributes): string {
  if (isSafeValue(name)) return name;
  const match = /^([A-Z]+) (\S+)$/.exec(name);
  const route = routeOf(attributes['next.route']) ?? routeOf(attributes['http.route']);
  if (match && methodOf(match[1]) && route && match[2] === route) return name;
  return 'next.internal';
}

/**
 * A copy of a span holding only what may leave. Anything not known to be safe is dropped. Every event goes,
 * because an exception event carries the error's message, and so do links' attributes and the status
 * message. The input is never changed.
 */
export function redactSpan(span: ReadableSpan): ReadableSpan {
  return {
    name: redactName(span.name, span.attributes),
    kind: span.kind,
    spanContext: () => span.spanContext(),
    ...(span.parentSpanContext ? { parentSpanContext: span.parentSpanContext } : {}),
    startTime: span.startTime,
    endTime: span.endTime,
    status: { code: span.status.code },
    attributes: redactAttributes(span.attributes),
    links: [],
    events: [],
    duration: span.duration,
    ended: span.ended,
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
}

/** Passes spans to `inner` only through `redactSpan`, so no path to the collector goes around it. */
export function createRedactingExporter(inner: SpanExporter): SpanExporter {
  return {
    export: (spans, done) => inner.export(spans.map(redactSpan), done),
    shutdown: () => inner.shutdown(),
    ...(inner.forceFlush ? { forceFlush: () => inner.forceFlush!() } : {}),
  };
}

/**
 * Records the web tier's latency from the span Next.js makes for each request, before anything is
 * redacted, keeping only the method, the status class and the route pattern. A request no route matched is
 * counted as `unmatched`, so a probe for random paths cannot fill the metric with paths.
 */
export function createWebLatencyProcessor(
  record: (durationMs: number, attributes: Attributes) => void,
): SpanProcessor {
  return {
    onStart: () => undefined,
    onEnd: (span) => {
      if (span.kind !== SpanKind.SERVER) return;
      if (span.attributes['next.span_type'] !== 'BaseServer.handleRequest') return;
      const method =
        methodOf(span.attributes['http.request.method']) ??
        methodOf(span.attributes['http.method']) ??
        'other';
      const status =
        statusOf(span.attributes['http.response.status_code']) ??
        statusOf(span.attributes['http.status_code']);
      const route =
        routeOf(span.attributes['next.route']) ?? routeOf(span.attributes['http.route']);
      record(hrTimeToMilliseconds(span.duration), {
        'http.request.method': method,
        'http.response.status_class': status ? `${Math.floor(status / 100)}xx` : 'unknown',
        'http.route': route ?? 'unmatched',
      });
    },
    forceFlush: async () => undefined,
    shutdown: async () => undefined,
  };
}

/**
 * Every metric in METRICS keeps only its own attributes, and every other metric, from a library or anything
 * else, is dropped before it is exported.
 */
export function metricViews(): ViewOptions[] {
  return [
    ...Object.values(METRICS).map((definition) => ({
      instrumentName: definition.name,
      attributesProcessors: [createAllowListAttributesProcessor([...definition.attributes])],
    })),
    // The SDK reuses the first storage for a matching descriptor, so the fallback must follow
    // the named streams or it replaces their aggregation with DROP as well.
    { instrumentName: '*', aggregation: { type: AggregationType.DROP } },
  ];
}

let started: TelemetryHandle | undefined;

/**
 * Registers the providers for this process. `{ enabled: false }` does nothing at all and returns a handle
 * with nothing to flush. Starting twice in one process keeps the first. The exporters go to the endpoint
 * named in the settings and nowhere else. Tests pass their own exporter and reader.
 */
export async function startTelemetry(
  service: string,
  settings: TelemetrySettings,
  options: { release?: string; spanExporter?: SpanExporter; metricReader?: MetricReader } = {},
): Promise<TelemetryHandle> {
  if (!settings.enabled)
    return { forceFlush: async () => undefined, shutdown: async () => undefined };
  if (started) return started;
  const resource = resourceFromAttributes({
    'service.name': isSafeValue(service) ? service : 'ensemus',
    ...(options.release && isSafeValue(options.release)
      ? { 'service.version': options.release }
      : {}),
  });
  const meterProvider = new MeterProvider({
    resource,
    views: metricViews(),
    readers: [
      options.metricReader ??
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({ url: `${settings.endpoint}/v1/metrics` }),
          exportIntervalMillis: settings.metricIntervalMs,
        }),
    ],
  });
  metrics.setGlobalMeterProvider(meterProvider);
  forgetInstruments();
  const latency = meterProvider
    .getMeter('ensemus')
    .createHistogram(METRICS.webRequestDuration.name, {
      unit: METRICS.webRequestDuration.unit,
      description: METRICS.webRequestDuration.description,
    });
  const tracerProvider = new TracerProvider({
    resource,
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(settings.sampleRatio) }),
    spanProcessors: [
      createWebLatencyProcessor((durationMs, attributes) => latency.record(durationMs, attributes)),
      new BatchSpanProcessor({
        exporter: createRedactingExporter(
          options.spanExporter ?? new OTLPTraceExporter({ url: `${settings.endpoint}/v1/traces` }),
        ),
      }),
    ],
  });
  const contextManager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(contextManager);
  trace.setGlobalTracerProvider(tracerProvider);
  // Deliberately none: the API's default propagator injects and extracts nothing.
  propagation.disable();
  started = {
    forceFlush: async () => {
      await Promise.all([tracerProvider.forceFlush(), meterProvider.forceFlush()]);
    },
    shutdown: async () => {
      await Promise.allSettled([tracerProvider.shutdown(), meterProvider.shutdown()]);
      trace.disable();
      metrics.disable();
      context.disable();
      forgetInstruments();
      started = undefined;
    },
  };
  return started;
}
