// ADR-037 D3: what leaves when an operator names a collector, and that nothing does when nobody has. The
// exporters here are in-memory doubles handed to startTelemetry, so the same allowlist and views run as in
// production, and every value that must not leave is a canary searched for in the whole export.
import { context, metrics, propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { afterEach, describe, expect, it } from 'vitest';
import { observeOperationalCounts, recordActivity } from './metrics';
import { startTelemetry, type TelemetryHandle } from './otel';
import { withSpan } from './tracing';

const ON = {
  enabled: true as const,
  endpoint: 'http://collector.invalid:4318',
  sampleRatio: 1,
  metricIntervalMs: 60_000,
};
const CANARY = 'CANARY-7f3e';

let handle: TelemetryHandle | undefined;
afterEach(async () => {
  await handle?.shutdown();
  handle = undefined;
});

async function started() {
  const spans = new InMemorySpanExporter();
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 3_600_000,
  });
  handle = await startTelemetry('test-service', ON, {
    release: 'release-1',
    spanExporter: spans,
    metricReader: reader,
  });
  const flush = async () => {
    await handle!.forceFlush();
    return {
      spans: spans.getFinishedSpans(),
      metrics: metricExporter.getMetrics(),
    };
  };
  return { flush };
}

const points = (exports: ResourceMetrics[], name: string) =>
  exports
    .flatMap((r) => r.scopeMetrics)
    .flatMap((s) => s.metrics)
    .filter((m) => m.descriptor.name === name)
    .flatMap((m) => m.dataPoints);
const names = (exports: ResourceMetrics[]) =>
  new Set(
    exports
      .flatMap((r) => r.scopeMetrics)
      .flatMap((s) => s.metrics)
      .map((m) => m.descriptor.name),
  );

describe('with telemetry off', () => {
  it('registers nothing, so a span records nothing and there is nothing to flush', async () => {
    handle = await startTelemetry('test-service', { enabled: false });
    const span = trace.getTracer('x').startSpan('probe');
    expect(span.isRecording()).toBe(false);
    span.end();
    await expect(handle.forceFlush()).resolves.toBeUndefined();
  });

  it('lets withSpan return and throw exactly as the work does', async () => {
    await expect(withSpan('test.span', { count: 1 }, async () => 'done')).resolves.toBe('done');
    const failure = new Error('the original');
    await expect(
      withSpan('test.span', {}, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    await expect(withSpan('not a safe name', { apiKey: CANARY }, async () => 1)).resolves.toBe(1);
  });
});

describe('with a collector named', () => {
  it('sends a span with only allowlisted fields, a safe name and no error message', async () => {
    const { flush } = await started();
    await withSpan(
      'dispatcher.deliver',
      { eventType: 'work.created', count: 2, apiKey: CANARY },
      async () => undefined,
    ).catch(() => undefined);
    await withSpan('a name with ' + CANARY, { workUnitId: `free text ${CANARY}` }, async () => {
      throw Object.assign(new Error(`SQL said ${CANARY}`), { code: 'EN001' });
    }).catch(() => undefined);
    const { spans } = await flush();
    expect(spans.map((s) => s.name)).toEqual(['dispatcher.deliver', 'invalid_span_name']);
    expect(spans[0]!.attributes).toEqual({ eventType: 'work.created', count: 2 });
    expect(spans[1]!.attributes).toEqual({ errorCode: 'EN001' });
    expect(spans[1]!.status).toEqual({ code: SpanStatusCode.ERROR });
    expect(
      JSON.stringify(spans, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}` : v)),
    ).not.toContain(CANARY);
    expect(spans[0]!.resource.attributes).toMatchObject({
      'service.name': 'test-service',
      'service.version': 'release-1',
    });
  });

  it('keeps a framework span to its method, status and route pattern, with no events or path', async () => {
    const { flush } = await started();
    const span = trace.getTracer('next.js').startSpan(`GET /invite/${CANARY}`, {
      kind: SpanKind.SERVER,
      attributes: {
        'next.span_type': 'BaseServer.handleRequest',
        'http.method': 'GET',
        'http.status_code': 200,
        'http.target': `/invite/${CANARY}`,
        'http.url': `https://example.invalid/invite/${CANARY}`,
        'next.route': '/invite/[token]',
        'user_agent.original': CANARY,
      },
    });
    span.recordException(new Error(`message with ${CANARY}`));
    span.setStatus({ code: SpanStatusCode.ERROR, message: CANARY });
    span.end();
    const routed = trace.getTracer('next.js').startSpan('GET /invite/[token]', {
      attributes: { 'next.route': '/invite/[token]', 'http.route': `/x/${CANARY} y` },
    });
    routed.end();
    const { spans, metrics: exported } = await flush();
    expect(spans.map((s) => s.name)).toEqual(['next.internal', 'GET /invite/[token]']);
    expect(spans[0]!.attributes).toEqual({
      'next.span_type': 'BaseServer.handleRequest',
      'http.method': 'GET',
      'http.status_code': 200,
      'next.route': '/invite/[token]',
    });
    expect(spans[0]!.events).toEqual([]);
    expect(spans[0]!.status).toEqual({ code: SpanStatusCode.ERROR });
    expect(JSON.stringify(spans)).not.toContain(CANARY);
    // The web latency metric, from the same span, before anything was dropped.
    const latency = points(exported, 'ensemus.web.request.duration');
    expect(latency).toHaveLength(1);
    expect(latency[0]!.attributes).toEqual({
      'http.request.method': 'GET',
      'http.response.status_class': '2xx',
      'http.route': '/invite/[token]',
    });
  });

  it('records activity time and queue wait, keeping only each metric own attributes', async () => {
    const { flush } = await started();
    recordActivity({
      activityType: 'runAgentStep',
      taskQueue: 'ensemus-agent',
      durationMs: 12,
      scheduleToStartMs: 30,
    });
    recordActivity({
      activityType: 'runAgentStep',
      taskQueue: 'ensemus-agent',
      durationMs: 5,
      error: Object.assign(new Error(CANARY), { code: 'TIMEOUT' }),
    });
    metrics
      .getMeter('library')
      .createHistogram('ensemus.activity.duration')
      .record(1, { activityType: 'x', taskQueue: 'y', apiKey: CANARY });
    metrics.getMeter('library').createCounter('library.requests').add(1, { url: CANARY });
    const { metrics: exported } = await flush();
    expect(names(exported).has('library.requests')).toBe(false);
    const durations = points(exported, 'ensemus.activity.duration');
    expect(durations.map((p) => p.attributes)).toEqual(
      expect.arrayContaining([
        { activityType: 'runAgentStep', taskQueue: 'ensemus-agent' },
        { activityType: 'runAgentStep', taskQueue: 'ensemus-agent', errorCode: 'TIMEOUT' },
        { activityType: 'x', taskQueue: 'y' },
      ]),
    );
    expect(points(exported, 'ensemus.activity.schedule_to_start')).toHaveLength(1);
    expect(JSON.stringify(exported)).not.toContain(CANARY);
  });

  it('reports the operational counts, and nothing for a round whose read failed', async () => {
    const { flush } = await started();
    let fail = false;
    const errors: unknown[] = [];
    const stop = observeOperationalCounts(
      async () => {
        if (fail) throw new Error(CANARY);
        return { deadOutboxEvents: 2, unknownPayments: 1, unmatchedPaymentEvents: 0 };
      },
      (error) => errors.push(error),
    );
    const first = await flush();
    expect(points(first.metrics, 'ensemus.outbox.dead').map((p) => p.value)).toEqual([2]);
    expect(points(first.metrics, 'ensemus.payments.unknown').map((p) => p.value)).toEqual([1]);
    expect(points(first.metrics, 'ensemus.payment_events.unmatched').map((p) => p.value)).toEqual([
      0,
    ]);
    stop();
    fail = true;
    observeOperationalCounts(
      async () => {
        throw new Error(CANARY);
      },
      (error) => errors.push(error),
    );
    expect(errors).toEqual([]);
  });

  it('believes no trace context from a client, and puts none in a request', async () => {
    await started();
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier);
    expect(carrier).toEqual({});
    const extracted = propagation.extract(context.active(), {
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    });
    expect(trace.getSpanContext(extracted)).toBeUndefined();
  });

  it('starts once per process and stops cleanly', async () => {
    const { flush } = await started();
    const again = await startTelemetry('another', ON);
    expect(again).toBe(handle);
    await flush();
    await handle!.shutdown();
    handle = undefined;
    const span = trace.getTracer('x').startSpan('after');
    expect(span.isRecording()).toBe(false);
    span.end();
  });
});
