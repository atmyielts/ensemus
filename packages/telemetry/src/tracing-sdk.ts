// Sends spans to the collector an operator named (ADR-037 D3). Nothing imports this unless tracing is
// on, so a default install never loads it, and it cannot make an outbound attempt.
//
// STUB: the otel-core slice in docs/06-delivery/hx-slices.md fills this in. The signatures are fixed.
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import type { TracingConfig, TracingHandle } from './tracing';

const notImplemented = () =>
  Object.assign(new Error('Not implemented'), { code: 'NOT_IMPLEMENTED' });

/** The attributes a span from a framework may keep, beyond the fields in the logger's allowlist. */
export const SPAN_ONLY_ATTRIBUTES: readonly string[] = [
  'http.request.method',
  'http.response.status_code',
  'next.route',
];

/**
 * A copy of a span holding only what may leave. Anything not known to be safe is dropped, and every
 * event goes, because an exception event carries the error's message. The input is never changed.
 */
export function redactSpan(_span: ReadableSpan): ReadableSpan {
  throw notImplemented();
}

/** Passes spans to `inner` only through `redactSpan`, so no path to the collector goes around it. */
export function createRedactingExporter(_inner: SpanExporter): SpanExporter {
  throw notImplemented();
}

/**
 * Registers the provider for this process. `{ enabled: false }` does nothing at all and returns a handle
 * with nothing to flush. Starting twice in one process keeps the first. No propagator is registered: a
 * client's `traceparent` is not believed, and tiers are joined by the IDs on their spans.
 */
export async function startTracing(
  _service: string,
  _config: TracingConfig,
  _options: { release?: string; exporter?: SpanExporter } = {},
): Promise<TracingHandle> {
  throw notImplemented();
}
