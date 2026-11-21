// The recovered tracing-only entry uses the combined metrics/tracing provider. There is one exporter
// boundary and one provider per process, whichever entry an older caller uses.
import type { SpanExporter } from '@opentelemetry/sdk-trace';
import { SPAN_ONLY_ATTRIBUTES as ATTRIBUTE_RULES, startTelemetry } from './otel';
import type { TracingConfig, TracingHandle } from './tracing';

export { createRedactingExporter, redactSpan } from './otel';
export const SPAN_ONLY_ATTRIBUTES: readonly string[] = Object.keys(ATTRIBUTE_RULES);

export async function startTracing(
  service: string,
  config: TracingConfig,
  options: { release?: string; exporter?: SpanExporter } = {},
): Promise<TracingHandle> {
  return startTelemetry(
    service,
    config.enabled
      ? {
          ...config,
          endpoint: config.endpoint.replace(/\/v1\/traces\/?$/, ''),
          metricIntervalMs: 60_000,
        }
      : config,
    {
      ...(options.release ? { release: options.release } : {}),
      ...(options.exporter ? { spanExporter: options.exporter } : {}),
    },
  );
}
