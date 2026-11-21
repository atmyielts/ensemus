// Pure exporter boundary: importing this while telemetry is off loads no OpenTelemetry SDK.
import type { Attributes, SpanContext } from '@opentelemetry/api';
import type { ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';
import { isSafeField, isSafeValue } from './index';

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
// A route pattern from our own source tree, such as /api/v1/organizations/[organizationId]/work-units. It
// holds the name of a segment and never its value, so it is safe; a real path is not, and fails this.
const ROUTE = /^\/[A-Za-z0-9_\-./[\]()]{0,200}$/;
export const routeOf = (value: unknown) =>
  typeof value === 'string' &&
  ROUTE.test(value) &&
  value
    .split('/')
    .every(
      (part) =>
        !part.includes('..') ||
        /^\[\.\.\.[A-Za-z_][A-Za-z0-9_]*\]$/.test(part) ||
        /^\[\[\.\.\.[A-Za-z_][A-Za-z0-9_]*\]\]$/.test(part),
    )
    ? value
    : undefined;
export const methodOf = (value: unknown) =>
  typeof value === 'string' && METHODS.has(value) ? value : undefined;
export const statusOf = (value: unknown) =>
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
    const check = Object.hasOwn(SPAN_ONLY_ATTRIBUTES, key) ? SPAN_ONLY_ATTRIBUTES[key] : undefined;
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
function idsOnly({ traceId, spanId, traceFlags, isRemote }: SpanContext): SpanContext {
  if (
    !/^[0-9a-f]{32}$/.test(traceId) ||
    !/^[0-9a-f]{16}$/.test(spanId) ||
    !Number.isInteger(traceFlags)
  )
    throw new Error('SPAN_CONTEXT_REFUSED');
  return { traceId, spanId, traceFlags, ...(isRemote === undefined ? {} : { isRemote }) };
}
export function redactSpan(span: ReadableSpan): ReadableSpan {
  // The provider supplies a resource containing only these two fields. Refuse an unexpected or
  // unresolved resource rather than trusting host detection or a mutable asynchronous attribute.
  if (
    span.resource.asyncAttributesPending ||
    Object.entries(span.resource.attributes).some(
      ([key, value]) =>
        !['service.name', 'service.version'].includes(key) ||
        typeof value !== 'string' ||
        !isSafeValue(value),
    )
  )
    throw new Error('SPAN_RESOURCE_REFUSED');
  const attributes = redactAttributes(span.attributes);
  const spanContext = idsOnly(span.spanContext());
  const scope = span.instrumentationScope;
  const safeScope =
    isSafeValue(scope.name) &&
    (!scope.version || isSafeValue(scope.version)) &&
    Object.keys(scope).every((key) => ['name', 'version'].includes(key))
      ? scope
      : {
          name: isSafeValue(scope.name) ? scope.name : 'ensemus',
          ...(scope.version && isSafeValue(scope.version) ? { version: scope.version } : {}),
        };
  return {
    name: redactName(span.name, span.attributes),
    kind: span.kind,
    spanContext: () => spanContext,
    ...(span.parentSpanContext ? { parentSpanContext: idsOnly(span.parentSpanContext) } : {}),
    startTime: span.startTime,
    endTime: span.endTime,
    status: { code: span.status.code },
    attributes,
    links: span.links.map((link) => ({ context: idsOnly(link.context) })),
    events: [],
    duration: span.duration,
    ended: span.ended,
    resource: span.resource,
    instrumentationScope: safeScope,
    droppedAttributesCount:
      span.droppedAttributesCount +
      Object.keys(span.attributes).length -
      Object.keys(attributes).length,
    droppedEventsCount: span.droppedEventsCount + span.events.length,
    droppedLinksCount: span.droppedLinksCount,
  };
}

/** Passes spans to `inner` only through `redactSpan`, so no path to the collector goes around it. */
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
        answer({ code: 1 });
      }
    },
    shutdown: async () => {
      await inner.shutdown();
    },
    forceFlush: async () => {
      await inner.forceFlush?.();
    },
  };
}
