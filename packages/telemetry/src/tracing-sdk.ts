// Compatibility entry for the tracing-only endpoint. Active processes use ./otel for traces and metrics.
import type { SpanExporter } from '@opentelemetry/sdk-trace';
import { SPAN_ONLY_ATTRIBUTES as ATTRIBUTE_RULES } from './span-redaction';
import type { TracingConfig, TracingHandle } from './tracing';
export { createRedactingExporter, redactSpan } from './span-redaction';
export const SPAN_ONLY_ATTRIBUTES: readonly string[] = Object.keys(ATTRIBUTE_RULES);
export async function startTracing(
  service: string,
  config: TracingConfig,
  options: { release?: string; exporter?: SpanExporter } = {},
): Promise<TracingHandle> {
  if (!config.enabled) return { shutdown: async () => undefined };
  try {
    const { startTelemetry } = await import('./otel');
    const target = new URL(config.endpoint);
    return await startTelemetry(
      service,
      { ...config, endpoint: target.origin, metricIntervalMs: 60_000 },
      {
        ...(options.release ? { release: options.release } : {}),
        ...(options.exporter ? { spanExporter: options.exporter } : {}),
        traceEndpoint: config.endpoint,
        metricsEnabled: false,
      },
    );
  } catch {
    throw Object.assign(new Error('Tracing could not start'), { code: 'TRACING_START_FAILED' });
  }
}
