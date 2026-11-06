// Sends spans to the collector an operator named (ADR-037 D3). Nothing imports this unless tracing is
// on, so a default install never loads it, and it cannot make an outbound attempt. From OpenTelemetry
// this file imports only types at the top. The SDK comes in through `startTracing`, so being told that
// tracing is off loads nothing either.
import type { Attributes, Link, SpanContext } from '@opentelemetry/api';
import type { ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { isSafeValue, sanitize } from './index';
import type { TracingConfig, TracingHandle } from './tracing';

/** The attributes a span from a framework may keep, beyond the fields in the logger's allowlist. */
export const SPAN_ONLY_ATTRIBUTES: readonly string[] = [
  'http.request.method',
  'http.response.status_code',
  'next.route',
];

const INTERNAL_NAME = 'next.internal';
const ROUTE_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

// A route pattern comes from our source tree, so it holds `[organizationId]`, and never an ID.
const ROUTE_SHAPE = /^\/[A-Za-z0-9._/[\]()-]{0,200}$/;

// ExportResultCode.FAILED. The enum is a runtime value in @opentelemetry/core, which is not loaded yet.
const EXPORT_FAILED: ExportResult = { code: 1 };

const isRoute = (value: unknown): value is string =>
  typeof value === 'string' && ROUTE_SHAPE.test(value);

function isSafeSpanOnlyValue(name: string, value: unknown) {
  if (name === 'next.route') return isRoute(value);
  if (name === 'http.response.status_code') {
    return typeof value === 'number' || typeof value === 'boolean';
  }
  return typeof value === 'string' && isSafeValue(value);
}

function redactAttributes(attributes: Attributes): Attributes {
  const kept = sanitize(attributes).kept as Attributes;
  for (const name of SPAN_ONLY_ATTRIBUTES) {
    const value = attributes[name];
    if (isSafeSpanOnlyValue(name, value)) kept[name] = value;
  }
  return kept;
}

function redactName(name: string, route: unknown) {
  if (isSafeValue(name)) return name;
  const [method = ''] = name.split(' ', 1);
  const isMethodAndRoute =
    ROUTE_METHODS.has(method) && isRoute(route) && name === `${method} ${route}`;
  return isMethodAndRoute ? name : INTERNAL_NAME;
}

/**
 * The IDs and flags of a span context. A trace state goes, though OTLP would send it: it is a list of
 * free-form values that anyone holding the context can add to.
 */
function idsOnly({ traceId, spanId, traceFlags, isRemote }: SpanContext): SpanContext {
  return { traceId, spanId, traceFlags, ...(isRemote === undefined ? {} : { isRemote }) };
}

/**
 * A copy of a span holding only what may leave. Anything not known to be safe is dropped, and every
 * event goes, because an exception event carries the error's message. The input is never changed, since
 * other processors share it. The counts say how much went, as the logger's `droppedFields` does.
 */
export function redactSpan(span: ReadableSpan): ReadableSpan {
  const attributes = redactAttributes(span.attributes);
  const spanContext = idsOnly(span.spanContext());
  const links: Link[] = span.links.map((link) => ({ context: idsOnly(link.context) }));
  return {
    name: redactName(span.name, span.attributes['next.route']),
    kind: span.kind,
    spanContext: () => spanContext,
    ...(span.parentSpanContext ? { parentSpanContext: idsOnly(span.parentSpanContext) } : {}),
    startTime: span.startTime,
    endTime: span.endTime,
    status: { code: span.status.code },
    attributes,
    links,
    events: [],
    duration: span.duration,
    ended: span.ended,
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount:
      span.droppedAttributesCount +
      Object.keys(span.attributes).length -
      Object.keys(attributes).length,
    droppedEventsCount: span.droppedEventsCount + span.events.length,
    droppedLinksCount: span.droppedLinksCount,
  };
}

/**
 * Passes spans to `inner` only through `redactSpan`, so no path to the collector goes around it. A batch
 * that cannot be redacted is not sent, and an exporter that throws becomes a failed export, because this
 * runs in a timer where nobody could catch it. Only the result's code goes back: an error's text can
 * quote what a collector answered.
 */
export function createRedactingExporter(inner: SpanExporter): SpanExporter {
  return {
    export(spans, resultCallback) {
      let answered = false;
      const answer = ({ code }: ExportResult) => {
        if (answered) return;
        answered = true;
        resultCallback({ code });
      };
      try {
        inner.export(spans.map(redactSpan), answer);
      } catch {
        answer(EXPORT_FAILED);
      }
    },
    shutdown: () => inner.shutdown(),
    forceFlush: async () => {
      await inner.forceFlush?.();
    },
  };
}

/** The exporter's own error quotes the address it could not parse, and that must not reach a log. */
async function createOtlpExporter(endpoint: string): Promise<SpanExporter> {
  const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
  try {
    return new OTLPTraceExporter({ url: endpoint });
  } catch {
    throw Object.assign(new Error('Tracing could not start'), { code: 'TRACING_START_FAILED' });
  }
}

async function start(
  service: string,
  config: Extract<TracingConfig, { enabled: true }>,
  options: { release?: string; exporter?: SpanExporter },
): Promise<TracingHandle> {
  const [sdk, { resourceFromAttributes }] = await Promise.all([
    import('@opentelemetry/sdk-trace-node'),
    import('@opentelemetry/resources'),
  ]);
  const exporter = options.exporter ?? (await createOtlpExporter(config.endpoint));
  const { release } = options;
  const provider = new sdk.NodeTracerProvider({
    // Set in full, so that no default adds host or process details. The resource is not redacted later.
    resource: resourceFromAttributes({
      'service.name': service,
      ...(release && isSafeValue(release) ? { 'service.version': release } : {}),
    }),
    sampler: new sdk.ParentBasedSampler({
      root: new sdk.TraceIdRatioBasedSampler(config.sampleRatio),
    }),
    spanProcessors: [new sdk.BatchSpanProcessor(createRedactingExporter(exporter))],
  });
  provider.register({ propagator: null });
  return {
    shutdown: async () => {
      try {
        await provider.shutdown();
      } catch {
        // Spans that could not be sent are lost, which tracing accepts. Stopping must not fail for it.
      }
    },
  };
}

let started: Promise<TracingHandle> | undefined;

/**
 * Registers the provider for this process. `{ enabled: false }` does nothing at all and returns a handle
 * with nothing to flush. Starting twice in one process keeps the first. No propagator is registered: a
 * client's `traceparent` is not believed, and tiers are joined by the IDs on their spans.
 */
export async function startTracing(
  service: string,
  config: TracingConfig,
  options: { release?: string; exporter?: SpanExporter } = {},
): Promise<TracingHandle> {
  if (!config.enabled) return { shutdown: () => Promise.resolve() };
  started ??= start(service, config, options);
  return started;
}
