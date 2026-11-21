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
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace';
import { isSafeValue } from './index';
import { forgetInstruments, METRICS } from './metrics';

/** The setting @ensemus/config hands over. Repeated here so this package needs nothing from that one. */
export type TelemetrySettings =
  | { enabled: false }
  | { enabled: true; endpoint: string; sampleRatio: number; metricIntervalMs: number };

export type TelemetryHandle = { forceFlush(): Promise<void>; shutdown(): Promise<void> };

export { createRedactingExporter, redactSpan, SPAN_ONLY_ATTRIBUTES } from './span-redaction';
import { createRedactingExporter, methodOf, routeOf, statusOf } from './span-redaction';

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
  options: {
    release?: string;
    spanExporter?: SpanExporter;
    metricReader?: MetricReader;
    traceEndpoint?: string;
    metricsEnabled?: boolean;
  } = {},
): Promise<TelemetryHandle> {
  if (!settings.enabled)
    return { forceFlush: async () => undefined, shutdown: async () => undefined };
  if (started) return started;
  let traceEndpoint: string;
  try {
    const base = new URL(settings.endpoint);
    const target = new URL(options.traceEndpoint ?? `${settings.endpoint}/v1/traces`);
    for (const url of [base, target]) {
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error('INVALID_TELEMETRY_ENDPOINT');
    }
    if (
      !Number.isFinite(settings.sampleRatio) ||
      settings.sampleRatio < 0 ||
      settings.sampleRatio > 1 ||
      !Number.isSafeInteger(settings.metricIntervalMs) ||
      settings.metricIntervalMs < 1000
    )
      throw new Error('INVALID_TELEMETRY_SETTINGS');
    traceEndpoint = target.toString();
  } catch {
    throw Object.assign(new Error('Telemetry could not start'), { code: 'TELEMETRY_START_FAILED' });
  }
  const resource = resourceFromAttributes({
    'service.name': isSafeValue(service) ? service : 'ensemus',
    ...(options.release && isSafeValue(options.release)
      ? { 'service.version': options.release }
      : {}),
  });
  const meterProvider = new MeterProvider({
    resource,
    views: metricViews(),
    readers:
      options.metricsEnabled === false
        ? []
        : [
            options.metricReader ??
              new PeriodicExportingMetricReader({
                exporter: new OTLPMetricExporter({ url: `${settings.endpoint}/v1/metrics` }),
                exportIntervalMillis: settings.metricIntervalMs,
                exportTimeoutMillis: Math.min(10_000, settings.metricIntervalMs),
              }),
          ],
  });
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
          options.spanExporter ?? new OTLPTraceExporter({ url: traceEndpoint }),
        ),
      }),
    ],
  });
  metrics.setGlobalMeterProvider(meterProvider);
  forgetInstruments();
  const contextManager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(contextManager);
  trace.setGlobalTracerProvider(tracerProvider);
  // Deliberately none: the API's default propagator injects and extracts nothing.
  propagation.disable();
  let closed = false;
  const handle: TelemetryHandle = {
    forceFlush: async () => {
      if (!closed)
        await Promise.allSettled([tracerProvider.forceFlush(), meterProvider.forceFlush()]);
    },
    shutdown: async () => {
      if (closed) return;
      closed = true;
      await Promise.allSettled([tracerProvider.shutdown(), meterProvider.shutdown()]);
      if (started === handle) {
        trace.disable();
        metrics.disable();
        context.disable();
        forgetInstruments();
        started = undefined;
      }
    },
  };
  started = handle;
  return handle;
}
