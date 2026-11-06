// What code calls to mark a span (ADR-037 D3). It needs only the OpenTelemetry API, which does nothing
// until something registers a provider, so with tracing off, which is the default, this costs a function
// call and nothing can leave. Everything that sends a span lives in ./tracing-sdk, and is loaded only
// when an operator has named a collector.
//
// Never import this from workflow code. A workflow's history has to replay, and only IDs cross Temporal
// (ADR-024). Activities, the dispatcher and the web tier may use it.
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { errorCode, isSafeValue, sanitize, type Fields } from './index';

/** Whether traces go anywhere, as `loadTracingConfig` in @ensemus/config reads it. */
export type TracingConfig =
  { enabled: false } | { enabled: true; endpoint: string; sampleRatio: number };

/** Lets a process send what it still holds before it stops. */
export type TracingHandle = { shutdown(): Promise<void> };

const TRACER = 'ensemus';
const INVALID_NAME = 'invalid_span_name';

/**
 * Runs `fn` inside a span. The name must be a fixed one from our own code, and fields go through the
 * same allowlist as the logger, so a value that may not be logged may not be traced. A failure adds its
 * code alone: an error's message can quote SQL or a prompt, so it is never recorded, and what `fn` threw
 * reaches the caller unchanged.
 */
export function withSpan<T>(name: string, fields: Fields, fn: () => Promise<T>): Promise<T> {
  const attributes = sanitize(fields).kept as Record<string, string | number | boolean>;
  return trace
    .getTracer(TRACER)
    .startActiveSpan(isSafeValue(name) ? name : INVALID_NAME, { attributes }, async (span) => {
      try {
        return await fn();
      } catch (error) {
        span.setAttribute('errorCode', errorCode(error));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
}
