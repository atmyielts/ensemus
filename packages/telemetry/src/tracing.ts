// What code calls to mark a span (ADR-037 D3). It needs only the OpenTelemetry API, which does nothing
// until something registers a provider, so with telemetry off, which is the default, this costs a function
// call and nothing can leave. Everything that sends lives in ./otel, which is loaded only when an operator
// has named a collector.
//
// Never import this from workflow code. A workflow's history has to replay, and only IDs cross Temporal
// (ADR-024). Activities, the dispatcher and the web tier may use it.
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { errorCode, isSafeValue, sanitize, type Fields } from './index';

const tracer = () => trace.getTracer('ensemus');

/**
 * Runs `fn` inside a span. The name must be machine-shaped and the fields pass the same allowlist as the
 * logger; anything else is dropped here, and again at the exporter. Refusing a name or a field never stops
 * the work. An error ends the span with its code, never its message, and is passed on unchanged.
 */
export function withSpan<T>(name: string, fields: Fields, fn: () => Promise<T>): Promise<T> {
  const { kept } = sanitize(fields);
  const attributes = Object.fromEntries(
    Object.entries(kept).filter(
      (entry): entry is [string, string | number | boolean] =>
        typeof entry[1] === 'string' ||
        typeof entry[1] === 'number' ||
        typeof entry[1] === 'boolean',
    ),
  );
  return tracer().startActiveSpan(
    isSafeValue(name) ? name : 'invalid_span_name',
    { attributes },
    async (span) => {
      try {
        return await fn();
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.setAttribute('errorCode', errorCode(error));
        throw error;
      } finally {
        span.end();
      }
    },
  );
}
