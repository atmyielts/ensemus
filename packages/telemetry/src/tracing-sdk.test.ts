// ADR-037 D3: what leaves is what the exporter's allowlist kept, whatever a framework put on a span, and
// a collector that fails or hangs costs the work nothing. Each canary sits in its own place, and the two
// controls send the same spans with no redaction, so these tests cannot pass by looking in the wrong spot.
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inspect } from 'node:util';
import {
  context,
  createTraceState,
  isSpanContextValid,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  TraceFlags,
  type Context,
  type Tracer,
} from '@opentelemetry/api';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import {
  BatchSpanProcessor,
  InMemorySpanExporter,
  NodeTracerProvider,
} from '@opentelemetry/sdk-trace-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withSpan, type TracingConfig, type TracingHandle } from './tracing';
import type * as TracingSdk from './tracing-sdk';

const PLANTED = {
  badAttributeName: 'sk-CANARY-bad-attribute-name',
  unknownAttribute: 'sk-CANARY-unknown-attribute',
  freeTextUnderSafeName: 'sk-CANARY-free-text-under-safe-name',
  arrayUnderSafeName: 'sk-CANARY-array-under-safe-name',
  httpTarget: 'sk-CANARY-http-target',
  httpUrl: 'sk-CANARY-http-url',
  methodFreeText: 'sk-CANARY-method-free-text',
  routeBadShape: 'sk-CANARY-route-bad-shape',
  statusCodeString: 'sk-CANARY-status-code-string',
  freeTextName: 'sk-CANARY-free-text-name',
  invitePathName: 'sk-CANARY-invite-path-name',
  routedInvitePathName: 'sk-CANARY-routed-invite-path-name',
  statusMessage: 'sk-CANARY-status-message',
  exceptionMessage: 'sk-CANARY-exception-message',
  exceptionStack: 'sk-CANARY-exception-stack',
  linkAttribute: 'sk-CANARY-link-attribute',
  linkTraceState: 'sk-CANARY-link-trace-state',
  parentTraceState: 'sk-CANARY-parent-trace-state',
  eventName: 'sk-CANARY-event-name',
  eventAttribute: 'sk-CANARY-event-attribute',
} as const;

const TRACE_ID = 'a'.repeat(32);
const SPAN_ID = 'b'.repeat(16);
const LINKED_TRACE_ID = 'c'.repeat(32);
const LINKED_SPAN_ID = 'd'.repeat(16);
const ROUTE = '/o/[organizationId]/work';
const ROUTE_NAME = `GET ${ROUTE}`;
const RAW_ID_NAME = 'GET /o/0196f3a2-7c1e-7000-8000-000000000001/work';

/** One batch is 512 spans, and a full batch goes out at once, so this reaches the exporter with no wait. */
const FULL_BATCH = 512;

function plantCanaries(tracer: Tracer) {
  const parent = trace.setSpanContext(ROOT_CONTEXT, {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
    traceState: createTraceState(`vendor=${PLANTED.parentTraceState}`),
  });
  const span = tracer.startSpan(
    `pasted ${PLANTED.freeTextName}`,
    {
      attributes: {
        [`bad.${PLANTED.badAttributeName}`]: 'x',
        apiKey: PLANTED.unknownAttribute,
        status: `failed because ${PLANTED.freeTextUnderSafeName} was rejected`,
        count: [PLANTED.arrayUnderSafeName],
        'http.target': `/invite/${PLANTED.httpTarget}`,
        'http.url': `https://app.example.invalid/invite/${PLANTED.httpUrl}`,
        'http.request.method': `GET ${PLANTED.methodFreeText}`,
        'next.route': `/invite/ ${PLANTED.routeBadShape}`,
        'http.response.status_code': PLANTED.statusCodeString,
      },
      links: [
        {
          context: {
            traceId: LINKED_TRACE_ID,
            spanId: LINKED_SPAN_ID,
            traceFlags: TraceFlags.SAMPLED,
            traceState: createTraceState(`vendor=${PLANTED.linkTraceState}`),
          },
          attributes: { note: PLANTED.linkAttribute },
        },
      ],
    },
    parent,
  );
  span.setStatus({ code: SpanStatusCode.ERROR, message: PLANTED.statusMessage });
  span.recordException({
    name: 'Error',
    message: PLANTED.exceptionMessage,
    stack: `Error\n    at ${PLANTED.exceptionStack}`,
  });
  span.addEvent(PLANTED.eventName, { detail: PLANTED.eventAttribute });
  span.end();
  // An invitation link, as a framework names a span before it knows the route, and after.
  tracer.startSpan(`GET /invite/${PLANTED.invitePathName}`).end();
  tracer
    .startSpan(`GET /invite/${PLANTED.routedInvitePathName}`, {
      attributes: { 'next.route': '/invite/[token]' },
    })
    .end();
}

function plantKept(tracer: Tracer) {
  tracer
    .startSpan('run.step', {
      attributes: {
        runId: 'run-1',
        organizationId: 'org-1',
        workUnitId: 'work-1',
        errorCode: 'E_FAILED',
        durationMs: 12,
      },
    })
    .end();
  tracer
    .startSpan(ROUTE_NAME, {
      attributes: {
        'http.request.method': 'GET',
        'next.route': ROUTE,
        'http.response.status_code': 200,
      },
    })
    .end();
  tracer.startSpan(RAW_ID_NAME, { attributes: { 'next.route': ROUTE } }).end();
}

/** Everything a span holds, by any path, including a trace state's hidden map. */
function serialize(spans: readonly ReadableSpan[]) {
  return inspect(
    spans.map((span) => ({
      ...span,
      name: span.name,
      attributes: span.attributes,
      status: span.status,
      links: span.links,
      events: span.events,
      resource: span.resource.attributes,
      context: span.spanContext(),
      parent: span.parentSpanContext,
    })),
    {
      depth: null,
      showHidden: true,
      customInspect: false,
      maxArrayLength: null,
      maxStringLength: null,
      breakLength: Infinity,
    },
  );
}

function expectNoCanary(received: string) {
  expect(received).not.toContain('sk-CANARY');
  for (const canary of Object.values(PLANTED)) expect(received).not.toContain(canary);
}

function expectEveryCanary(received: string) {
  for (const canary of Object.values(PLANTED)) expect(received).toContain(canary);
}

type WireValue = { stringValue?: string; intValue?: number | string };
type WireAttribute = { key: string; value: WireValue };
type WireSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  attributes: WireAttribute[];
  status: { code?: number; message?: string };
};
type WireBody = {
  resourceSpans: {
    resource: { attributes: WireAttribute[] };
    scopeSpans: { spans: WireSpan[] }[];
  }[];
};

const wireBodies = (bodies: readonly string[]) => bodies.map((b) => JSON.parse(b) as WireBody);
const wireSpans = (bodies: readonly string[]) =>
  wireBodies(bodies).flatMap((body) =>
    body.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((scope) => scope.spans)),
  );
const wireAttribute = (span: WireSpan | undefined, key: string) =>
  span?.attributes.find((attribute) => attribute.key === key)?.value;

type Collector = {
  url: string;
  bodies: string[];
  paths: (string | undefined)[];
};

const closers: (() => Promise<void>)[] = [];

const closeServer = (server: Server) =>
  new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

/** A throwaway collector on loopback. It reads a whole request, and then does what `respond` says. */
async function startCollector(respond: (response: ServerResponse) => void): Promise<Collector> {
  const bodies: string[] = [];
  const paths: (string | undefined)[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('utf8'));
      paths.push(request.url);
      respond(response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => closeServer(server));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/v1/traces`, bodies, paths };
}

const answerOk = (response: ServerResponse) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end('{}');
};
const answer500 = (response: ServerResponse) => {
  response.writeHead(500);
  response.end();
};
const neverAnswer = () => undefined;

/** A port that was just open and now refuses, for a collector that is down. */
async function closedPortUrl() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await closeServer(server);
  return `http://127.0.0.1:${port}/v1/traces`;
}

/** Shutting an in-memory exporter down empties it, and these tests read it after a flush. */
class KeepingExporter extends InMemorySpanExporter {
  override shutdown() {
    return Promise.resolve();
  }
}

const on = (endpoint = 'http://127.0.0.1:9/v1/traces', sampleRatio = 1): TracingConfig => ({
  enabled: true,
  endpoint,
  sampleRatio,
});

function makeSpan(overrides: Partial<ReadableSpan> = {}): ReadableSpan {
  const spanContext = { traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: TraceFlags.SAMPLED };
  return {
    name: 'run.step',
    kind: SpanKind.SERVER,
    spanContext: () => spanContext,
    startTime: [1, 2],
    endTime: [3, 4],
    status: { code: SpanStatusCode.UNSET },
    attributes: {},
    links: [],
    events: [],
    duration: [2, 2],
    ended: true,
    resource: resourceFromAttributes({ 'service.name': 'test' }),
    instrumentationScope: { name: 'ensemus', version: '1' },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
    ...overrides,
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

/** The module keeps the first handle for the life of a process, so each test gets its own process's worth. */
async function loadSdk(): Promise<typeof TracingSdk> {
  vi.resetModules();
  return import('./tracing-sdk');
}

let handles: TracingHandle[] = [];

async function start(
  sdk: typeof TracingSdk,
  config: TracingConfig,
  options: { release?: string; exporter?: SpanExporter } = {},
) {
  const handle = await sdk.startTracing('web', config, options);
  handles.push(handle);
  return handle;
}

const hasProvider = () => trace.getTracer('probe').startSpan('probe').isRecording();

const work = (count: number) =>
  Array.from({ length: count }).reduce<Promise<unknown>>(
    (previous) => previous.then(() => withSpan('test.work', {}, async () => 'done')),
    Promise.resolve(),
  );

beforeEach(() => {
  handles = [];
});

afterEach(async () => {
  await Promise.all(handles.map((handle) => handle.shutdown()));
  await Promise.all(closers.splice(0).map((close) => close()));
  // The provider, the context manager and the propagator are all global.
  trace.disable();
  context.disable();
  propagation.disable();
  vi.doUnmock('@opentelemetry/sdk-trace-node');
  vi.doUnmock('@opentelemetry/exporter-trace-otlp-http');
  vi.doUnmock('@opentelemetry/resources');
  vi.doUnmock('@opentelemetry/core');
  vi.restoreAllMocks();
});

describe('the controls: with no redaction, the planted canaries are visible', () => {
  it('to the serializer, from an in-memory exporter', async () => {
    const memory = new KeepingExporter();
    const provider = new NodeTracerProvider({ spanProcessors: [new BatchSpanProcessor(memory)] });
    plantCanaries(provider.getTracer('control'));
    await provider.forceFlush();
    expectEveryCanary(serialize(memory.getFinishedSpans()));
    await provider.shutdown();
  });

  it('on the wire, through the real exporter', async () => {
    const collector = await startCollector(answerOk);
    const provider = new NodeTracerProvider({
      spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: collector.url }))],
    });
    plantCanaries(provider.getTracer('control'));
    await provider.shutdown();
    expectEveryCanary(collector.bodies.join('\n'));
  });
});

describe('a canary cannot get out', () => {
  it('to an in-memory exporter', async () => {
    const sdk = await loadSdk();
    const memory = new KeepingExporter();
    const handle = await start(sdk, on(), { exporter: memory });
    plantCanaries(trace.getTracer('test'));
    await withSpan(`pasted ${PLANTED.freeTextName}`, { apiKey: PLANTED.unknownAttribute }, () =>
      Promise.reject(new Error(PLANTED.exceptionMessage)),
    ).catch(() => undefined);
    await handle.shutdown();
    expect(memory.getFinishedSpans()).toHaveLength(4);
    expectNoCanary(serialize(memory.getFinishedSpans()));
  });

  it('on the wire, through the real exporter', async () => {
    const collector = await startCollector(answerOk);
    const sdk = await loadSdk();
    const handle = await start(sdk, on(collector.url));
    plantCanaries(trace.getTracer('test'));
    await handle.shutdown();
    expect(wireSpans(collector.bodies)).toHaveLength(3);
    expectNoCanary(collector.bodies.join('\n'));
  });
});

describe('what is kept survives', () => {
  function expectKept(
    named: (name: string) => {
      traceId: string;
      spanId: string;
      attribute: (key: string) => unknown;
    },
    names: string[],
  ) {
    const step = named('run.step');
    expect(step.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(step.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(step.attribute('runId')).toBe('run-1');
    expect(step.attribute('organizationId')).toBe('org-1');
    expect(step.attribute('workUnitId')).toBe('work-1');
    expect(step.attribute('errorCode')).toBe('E_FAILED');
    expect(Number(step.attribute('durationMs'))).toBe(12);
    const route = named(ROUTE_NAME);
    expect(route.attribute('http.request.method')).toBe('GET');
    expect(route.attribute('next.route')).toBe(ROUTE);
    expect(Number(route.attribute('http.response.status_code'))).toBe(200);
    expect(names).not.toContain(RAW_ID_NAME);
    expect(names).toContain('next.internal');
  }

  it('in an in-memory exporter', async () => {
    const sdk = await loadSdk();
    const memory = new KeepingExporter();
    const handle = await start(sdk, on(), { exporter: memory });
    plantKept(trace.getTracer('test'));
    await handle.shutdown();
    const spans = memory.getFinishedSpans();
    expectKept(
      (name) => {
        const span = spans.find((candidate) => candidate.name === name);
        return {
          traceId: span?.spanContext().traceId ?? '',
          spanId: span?.spanContext().spanId ?? '',
          attribute: (key) => span?.attributes[key],
        };
      },
      spans.map((span) => span.name),
    );
  });

  it('on the wire', async () => {
    const collector = await startCollector(answerOk);
    const sdk = await loadSdk();
    const handle = await start(sdk, on(collector.url));
    plantKept(trace.getTracer('test'));
    await handle.shutdown();
    const spans = wireSpans(collector.bodies);
    expectKept(
      (name) => {
        const span = spans.find((candidate) => candidate.name === name);
        return {
          traceId: span?.traceId ?? '',
          spanId: span?.spanId ?? '',
          attribute: (key) => {
            const value = wireAttribute(span, key);
            return value?.stringValue ?? value?.intValue;
          },
        };
      },
      spans.map((span) => span.name),
    );
  });

  it('keeps a failed span and its code, and not the reason', async () => {
    const sdk = await loadSdk();
    const memory = new KeepingExporter();
    const handle = await start(sdk, on(), { exporter: memory });
    const failure = Object.assign(new Error(PLANTED.exceptionMessage), { code: 'E_DENIED' });
    await expect(withSpan('run.step', { runId: 'run-1' }, () => Promise.reject(failure))).rejects.toBe(
      failure,
    );
    await handle.shutdown();
    const [span] = memory.getFinishedSpans();
    expect(span?.status).toEqual({ code: SpanStatusCode.ERROR });
    expect(span?.attributes).toEqual({ runId: 'run-1', errorCode: 'E_DENIED' });
  });
});

describe('redactSpan', () => {
  it.each([
    ['a safe name', 'run.step', ROUTE, 'run.step'],
    ['a method and the route', ROUTE_NAME, ROUTE, ROUTE_NAME],
    ['every method', `OPTIONS ${ROUTE}`, ROUTE, `OPTIONS ${ROUTE}`],
    ['the root route', 'HEAD /', '/', 'HEAD /'],
    ['a raw ID in the path', RAW_ID_NAME, ROUTE, 'next.internal'],
    ['a different route', 'GET /o/[organizationId]/other', ROUTE, 'next.internal'],
    ['no route at all', ROUTE_NAME, undefined, 'next.internal'],
    ['a route of the wrong shape', 'GET /a b', '/a b', 'next.internal'],
    ['a method not on the list', `TRACE ${ROUTE}`, ROUTE, 'next.internal'],
    ['a lower-case method', `get ${ROUTE}`, ROUTE, 'next.internal'],
    ['a second space', `GET  ${ROUTE}`, ROUTE, 'next.internal'],
    ['something after the route', `${ROUTE_NAME} x`, ROUTE, 'next.internal'],
    ['a line break after the route', `${ROUTE_NAME}\n`, ROUTE, 'next.internal'],
    ['free text', 'please use this', ROUTE, 'next.internal'],
    ['an empty name', '', ROUTE, 'next.internal'],
  ])('with %s', async (_label, name, route, expected) => {
    const { redactSpan } = await loadSdk();
    const attributes = route === undefined ? {} : { 'next.route': route };
    expect(redactSpan(makeSpan({ name, attributes })).name).toBe(expected);
  });

  it.each([
    ['a route at the longest shape', 'next.route', `/${'a'.repeat(200)}`, true],
    ['a route one past it', 'next.route', `/${'a'.repeat(201)}`, false],
    ['a route with no leading slash', 'next.route', 'o/[organizationId]', false],
    ['a route with a line break', 'next.route', '/a\n', false],
    ['a route with a query', 'next.route', '/a?token=1', false],
    ['a route that is not text', 'next.route', 7, false],
    ['a route group and a catch-all', 'next.route', '/(app)/[...slug]', true],
    ['a method', 'http.request.method', 'GET', true],
    ['a method with a space', 'http.request.method', 'GET x', false],
    ['a method that is a number', 'http.request.method', 7, false],
    ['a status code', 'http.response.status_code', 404, true],
    ['a status code that is true', 'http.response.status_code', true, true],
    ['a status code as text', 'http.response.status_code', '404', false],
    ['a status code in a list', 'http.response.status_code', [404], false],
    ['a field the logger keeps', 'runId', 'run-1', true],
    ['a field the logger refuses', 'apiKey', 'abc', false],
    ['a safe field holding free text', 'runId', 'not machine shaped', false],
    ['a safe field holding a list', 'count', [1], false],
    ['a name that would be a prototype', '__proto__', 'x', false],
  ])('with %s', async (_label, key, value, kept) => {
    const { redactSpan } = await loadSdk();
    const attributes = Object.fromEntries([[key, value]]) as ReadableSpan['attributes'];
    const redacted = redactSpan(makeSpan({ attributes }));
    expect(Object.entries(redacted.attributes)).toEqual(kept ? [[key, value]] : []);
  });

  it('keeps the status code alone', async () => {
    const { redactSpan } = await loadSdk();
    const status = { code: SpanStatusCode.ERROR, message: PLANTED.statusMessage };
    expect(redactSpan(makeSpan({ status })).status).toEqual({ code: SpanStatusCode.ERROR });
  });

  it('keeps a link to a span and nothing about it', async () => {
    const { redactSpan } = await loadSdk();
    const linked = { traceId: LINKED_TRACE_ID, spanId: LINKED_SPAN_ID, traceFlags: 1 };
    const redacted = redactSpan(
      makeSpan({
        links: [
          {
            context: { ...linked, traceState: createTraceState('vendor=value') },
            attributes: { note: PLANTED.linkAttribute },
          },
        ],
      }),
    );
    expect(redacted.links).toEqual([{ context: linked }]);
  });

  it('keeps the IDs, and drops a trace state, which holds whatever a caller put there', async () => {
    const { redactSpan } = await loadSdk();
    const traceState = createTraceState(`vendor=${PLANTED.parentTraceState}`);
    const own = { traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: 1, traceState };
    const parent = {
      traceId: TRACE_ID,
      spanId: LINKED_SPAN_ID,
      traceFlags: 1,
      isRemote: true,
      traceState,
    };
    const redacted = redactSpan(makeSpan({ spanContext: () => own, parentSpanContext: parent }));
    expect(redacted.spanContext()).toEqual({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: 1 });
    expect(redacted.parentSpanContext).toEqual({
      traceId: TRACE_ID,
      spanId: LINKED_SPAN_ID,
      traceFlags: 1,
      isRemote: true,
    });
  });

  it('leaves out a parent when there is none', async () => {
    const { redactSpan } = await loadSdk();
    expect('parentSpanContext' in redactSpan(makeSpan())).toBe(false);
  });

  it('keeps the resource, the scope, the kind and the times as they were', async () => {
    const { redactSpan } = await loadSdk();
    const input = makeSpan();
    const redacted = redactSpan(input);
    expect(redacted.resource).toBe(input.resource);
    expect(redacted.instrumentationScope).toBe(input.instrumentationScope);
    expect(redacted.kind).toBe(SpanKind.SERVER);
    expect(redacted.startTime).toEqual([1, 2]);
    expect(redacted.endTime).toEqual([3, 4]);
    expect(redacted.duration).toEqual([2, 2]);
    expect(redacted.ended).toBe(true);
  });

  it('says how much it dropped, as the logger does', async () => {
    const { redactSpan } = await loadSdk();
    const redacted = redactSpan(
      makeSpan({
        attributes: { runId: 'run-1', apiKey: 'abc', 'http.target': '/x' },
        events: [{ name: 'exception', time: [1, 1], droppedAttributesCount: 0 }],
        droppedAttributesCount: 1,
        droppedEventsCount: 2,
        droppedLinksCount: 3,
      }),
    );
    expect(redacted.droppedAttributesCount).toBe(3);
    expect(redacted.droppedEventsCount).toBe(3);
    expect(redacted.droppedLinksCount).toBe(3);
    expect(redacted.events).toEqual([]);
  });

  it('never writes to its input, which other processors share', async () => {
    const { redactSpan } = await loadSdk();
    const parts = {
      name: `pasted ${PLANTED.freeTextName}`,
      status: { code: SpanStatusCode.ERROR, message: PLANTED.statusMessage },
      attributes: { runId: 'run-1', apiKey: PLANTED.unknownAttribute },
      links: [
        {
          context: { traceId: LINKED_TRACE_ID, spanId: LINKED_SPAN_ID, traceFlags: 1 },
          attributes: { note: PLANTED.linkAttribute },
        },
      ],
      events: [{ name: PLANTED.eventName, time: [1, 1] as [number, number] }],
    };
    const { resource, ...rest } = makeSpan(parts);
    // Frozen, so that a write throws here, and compared afterwards, so that a copy cannot hide one.
    const input = { resource, ...deepFreeze(rest) };
    const before = inspect(rest, { depth: null });
    const redacted = redactSpan(input);
    expect(inspect(rest, { depth: null })).toBe(before);
    expect(redacted).not.toBe(input);
    expect(redacted.attributes).not.toBe(input.attributes);
    expect(redacted.links).not.toBe(input.links);
    expect(redacted.events).not.toBe(input.events);
    expect(input.attributes).toEqual(parts.attributes);
    expect(input.events).toHaveLength(1);
  });
});

describe('createRedactingExporter', () => {
  const answered = () => {
    const results: ExportResult[] = [];
    return { results, callback: (result: ExportResult) => results.push(result) };
  };

  it('gives the exporter inside only redacted spans', async () => {
    const { createRedactingExporter } = await loadSdk();
    const memory = new InMemorySpanExporter();
    const { results, callback } = answered();
    createRedactingExporter(memory).export(
      [makeSpan({ name: `pasted ${PLANTED.freeTextName}`, attributes: { apiKey: 'abc' } })],
      callback,
    );
    expect(memory.getFinishedSpans().map((span) => span.name)).toEqual(['next.internal']);
    expect(memory.getFinishedSpans()[0]?.attributes).toEqual({});
    expect(results).toEqual([{ code: ExportResultCode.SUCCESS }]);
  });

  it('reports a failure when the exporter inside throws, and throws nothing itself', async () => {
    const { createRedactingExporter } = await loadSdk();
    const { results, callback } = answered();
    const exporter = createRedactingExporter({
      export: () => {
        throw new Error(PLANTED.exceptionMessage);
      },
      shutdown: () => Promise.resolve(),
    });
    expect(() => exporter.export([makeSpan()], callback)).not.toThrow();
    expect(results).toEqual([{ code: ExportResultCode.FAILED }]);
  });

  it('answers once when the exporter inside answers and then throws', async () => {
    const { createRedactingExporter } = await loadSdk();
    const { results, callback } = answered();
    createRedactingExporter({
      export: (_spans, done) => {
        done({ code: ExportResultCode.SUCCESS });
        throw new Error('after answering');
      },
      shutdown: () => Promise.resolve(),
    }).export([makeSpan()], callback);
    expect(results).toEqual([{ code: ExportResultCode.SUCCESS }]);
  });

  it('passes on the result code and not the error, whose text can quote a response', async () => {
    const { createRedactingExporter } = await loadSdk();
    const { results, callback } = answered();
    createRedactingExporter({
      export: (_spans, done) =>
        done({ code: ExportResultCode.FAILED, error: new Error(PLANTED.exceptionMessage) }),
      shutdown: () => Promise.resolve(),
    }).export([makeSpan()], callback);
    expect(results).toEqual([{ code: ExportResultCode.FAILED }]);
  });

  it('sends none of a batch it cannot redact', async () => {
    const { createRedactingExporter } = await loadSdk();
    const memory = new InMemorySpanExporter();
    const { results, callback } = answered();
    const unreadable = Object.defineProperty(makeSpan(), 'attributes', {
      get: () => {
        throw new Error('cannot read');
      },
    });
    createRedactingExporter(memory).export([makeSpan(), unreadable], callback);
    expect(memory.getFinishedSpans()).toEqual([]);
    expect(results).toEqual([{ code: ExportResultCode.FAILED }]);
  });

  it('passes shutdown and flush through, to an exporter with no flush as well', async () => {
    const { createRedactingExporter } = await loadSdk();
    const shutdown = vi.fn(() => Promise.resolve());
    const forceFlush = vi.fn(() => Promise.resolve());
    const exporter = createRedactingExporter({ export: () => undefined, shutdown, forceFlush });
    await exporter.forceFlush?.();
    await exporter.shutdown();
    expect(forceFlush).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
    const noFlush = createRedactingExporter({ export: () => undefined, shutdown });
    await expect(noFlush.forceFlush?.()).resolves.toBeUndefined();
  });
});

describe('startTracing, off', () => {
  it('runs the work, sends nothing and sets no provider', async () => {
    const collector = await startCollector(answerOk);
    const { startTracing } = await loadSdk();
    const handle = await startTracing('web', { enabled: false });
    await expect(withSpan('test.span', { runId: 'run-1' }, async () => 'done')).resolves.toBe(
      'done',
    );
    await expect(handle.shutdown()).resolves.toBeUndefined();
    expect(hasProvider()).toBe(false);
    expect(trace.getTracer('probe').startSpan('probe').spanContext()).not.toSatisfy(
      isSpanContextValid,
    );
    expect(collector.bodies).toEqual([]);
  });

  it('loads none of the SDK', async () => {
    const loaded: string[] = [];
    for (const name of [
      '@opentelemetry/sdk-trace-node',
      '@opentelemetry/exporter-trace-otlp-http',
      '@opentelemetry/resources',
      '@opentelemetry/core',
    ]) {
      vi.doMock(name, () => {
        loaded.push(name);
        return {};
      });
    }
    const { startTracing } = await loadSdk();
    await (await startTracing('web', { enabled: false })).shutdown();
    expect(loaded).toEqual([]);
    // The same mocks do notice when it is on, so the empty list above means something.
    await expect(startTracing('web', on())).rejects.toThrow();
    expect(loaded).toContain('@opentelemetry/sdk-trace-node');
  });

  it('does not take the place of a later start that is on', async () => {
    const sdk = await loadSdk();
    await sdk.startTracing('web', { enabled: false });
    await start(sdk, on(), { exporter: new KeepingExporter() });
    expect(hasProvider()).toBe(true);
  });
});

describe('startTracing, on', () => {
  it('names the service and the release, and nothing about the host', async () => {
    const collector = await startCollector(answerOk);
    const sdk = await loadSdk();
    const handle = await start(sdk, on(collector.url), { release: 'v1.2.3' });
    await withSpan('test.span', {}, async () => undefined);
    await handle.shutdown();
    const [body] = wireBodies(collector.bodies);
    expect(body?.resourceSpans[0]?.resource.attributes).toEqual([
      { key: 'service.name', value: { stringValue: 'web' } },
      { key: 'service.version', value: { stringValue: 'v1.2.3' } },
    ]);
  });

  it.each([
    ['none', {}],
    ['free text', { release: `build of ${PLANTED.unknownAttribute}` }],
  ])('leaves the release out when it is given %s', async (_label, options) => {
    const memory = new KeepingExporter();
    const sdk = await loadSdk();
    const handle = await start(sdk, on(), { ...options, exporter: memory });
    await withSpan('test.span', {}, async () => undefined);
    await handle.shutdown();
    expect(memory.getFinishedSpans()[0]?.resource.attributes).toEqual({ 'service.name': 'web' });
  });

  it('posts to exactly the address the operator named', async () => {
    const collector = await startCollector(answerOk);
    const sdk = await loadSdk();
    const handle = await start(sdk, on(collector.url.replace('/v1/traces', '/collector/spans')));
    await withSpan('test.span', {}, async () => undefined);
    await handle.shutdown();
    expect(collector.paths).toEqual(['/collector/spans']);
  });

  it('rejects an address it cannot use without quoting it, and registers nothing', async () => {
    const sdk = await loadSdk();
    const started = sdk.startTracing('web', on(`not a url ${PLANTED.httpUrl}`));
    const failure: unknown = await started.catch((error: unknown) => error);
    expect(inspect(failure, { depth: null, showHidden: true })).not.toContain('sk-CANARY');
    expect(failure).toMatchObject({ code: 'TRACING_START_FAILED' });
    expect(hasProvider()).toBe(false);
  });

  it('samples at the ratio it was given', async () => {
    const memory = new KeepingExporter();
    const sdk = await loadSdk();
    const handle = await start(sdk, on(undefined, 0), { exporter: memory });
    await work(5);
    await handle.shutdown();
    expect(memory.getFinishedSpans()).toEqual([]);
  });

  it('carries context across awaits, with the async-hooks manager', async () => {
    const memory = new KeepingExporter();
    const sdk = await loadSdk();
    const handle = await start(sdk, on(), { exporter: memory });
    await withSpan('test.outer', {}, async () => {
      await new Promise((resolve) => setImmediate(resolve));
      await withSpan('test.inner', {}, async () => undefined);
    });
    await handle.shutdown();
    const spans = memory.getFinishedSpans();
    const outer = spans.find((span) => span.name === 'test.outer');
    const inner = spans.find((span) => span.name === 'test.inner');
    expect(inner?.parentSpanContext?.spanId).toBe(outer?.spanContext().spanId);
  });

  it('does not believe a traceparent', async () => {
    const memory = new KeepingExporter();
    const sdk = await loadSdk();
    const handle = await start(sdk, on(), { exporter: memory });
    const carrier = { traceparent: `00-${TRACE_ID}-${SPAN_ID}-01` };
    const extracted: Context = propagation.extract(ROOT_CONTEXT, carrier);
    expect(trace.getSpanContext(extracted)).toBeUndefined();
    await context.with(extracted, () => withSpan('test.span', {}, async () => undefined));
    await handle.shutdown();
    const [span] = memory.getFinishedSpans();
    expect(span?.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span?.spanContext().traceId).not.toBe(TRACE_ID);
    expect(span?.parentSpanContext).toBeUndefined();
  });

  it('does not let a traceparent claim a sampling decision', async () => {
    const memory = new KeepingExporter();
    const sdk = await loadSdk();
    const handle = await start(sdk, on(undefined, 0), { exporter: memory });
    const extracted = propagation.extract(ROOT_CONTEXT, {
      traceparent: `00-${TRACE_ID}-${SPAN_ID}-01`,
    });
    await context.with(extracted, () => withSpan('test.span', {}, async () => undefined));
    await handle.shutdown();
    expect(memory.getFinishedSpans()).toEqual([]);
  });

  it('writes no trace context into a carrier going out', async () => {
    const sdk = await loadSdk();
    await start(sdk, on(), { exporter: new KeepingExporter() });
    const carrier: Record<string, string> = {};
    await withSpan('test.span', {}, async () => {
      propagation.inject(context.active(), carrier);
    });
    expect(carrier).toEqual({});
  });

  it('keeps the first when started again', async () => {
    const first = new KeepingExporter();
    const second = new KeepingExporter();
    const sdk = await loadSdk();
    const handle = await start(sdk, on(), { exporter: first });
    await expect(start(sdk, on(), { exporter: second })).resolves.toBe(handle);
    await withSpan('test.span', {}, async () => undefined);
    await handle.shutdown();
    expect(first.getFinishedSpans()).toHaveLength(1);
    expect(second.getFinishedSpans()).toEqual([]);
  });

  it('keeps one when two starts race', async () => {
    const sdk = await loadSdk();
    const [one, two] = await Promise.all([
      start(sdk, on(), { exporter: new KeepingExporter() }),
      start(sdk, on(), { exporter: new KeepingExporter() }),
    ]);
    expect(one).toBe(two);
  });

  it('sends what it holds on shutdown', async () => {
    const memory = new KeepingExporter();
    const sdk = await loadSdk();
    const handle = await start(sdk, on(), { exporter: memory });
    await withSpan('test.span', {}, async () => undefined);
    expect(memory.getFinishedSpans()).toEqual([]);
    await handle.shutdown();
    expect(memory.getFinishedSpans().map((span) => span.name)).toEqual(['test.span']);
  });

  it('can be shut down twice', async () => {
    const sdk = await loadSdk();
    const handle = await start(sdk, on(), { exporter: new KeepingExporter() });
    await handle.shutdown();
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });
});

describe('a failing collector costs the work nothing', () => {
  it('when the exporter throws', async () => {
    const errors = vi.spyOn(console, 'error');
    const sdk = await loadSdk();
    const failing = vi.fn(() => {
      throw new Error(PLANTED.exceptionMessage);
    });
    const handle = await start(sdk, on(), {
      exporter: { export: failing, shutdown: () => Promise.resolve() },
    });
    await work(FULL_BATCH);
    expect(failing).toHaveBeenCalled();
    await expect(withSpan('test.after', {}, async () => 'done')).resolves.toBe('done');
    await expect(handle.shutdown()).resolves.toBeUndefined();
    expect(errors).not.toHaveBeenCalled();
  });

  it('when the exporter never answers', async () => {
    const sdk = await loadSdk();
    const silent = vi.fn();
    await start(sdk, on(), { exporter: { export: silent, shutdown: () => Promise.resolve() } });
    await work(FULL_BATCH);
    expect(silent).toHaveBeenCalled();
    await expect(withSpan('test.after', {}, async () => 'done')).resolves.toBe('done');
    // The batch processor waits 30 seconds for an answer on shutdown, and nothing else is waiting here.
    handles = [];
  });

  it('when the exporter fails to shut down', async () => {
    const sdk = await loadSdk();
    const handle = await start(sdk, on(), {
      exporter: {
        export: (_spans, done) => done({ code: ExportResultCode.SUCCESS }),
        shutdown: () => Promise.reject(new Error(PLANTED.exceptionMessage)),
      },
    });
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });

  it('when the collector answers 500', async () => {
    const collector = await startCollector(answer500);
    const sdk = await loadSdk();
    const handle = await start(sdk, on(collector.url));
    await expect(withSpan('test.span', {}, async () => 'done')).resolves.toBe('done');
    await expect(handle.shutdown()).resolves.toBeUndefined();
    expect(wireSpans(collector.bodies).map((span) => span.name)).toEqual(['test.span']);
  });

  it('when the collector takes the spans and never answers', { timeout: 20_000 }, async () => {
    const collector = await startCollector(neverAnswer);
    const sdk = await loadSdk();
    const handle = await start(sdk, on(collector.url), {
      exporter: new OTLPTraceExporter({ url: collector.url, timeoutMillis: 3_000 }),
    });
    await work(FULL_BATCH);
    await vi.waitFor(() => expect(collector.bodies).toHaveLength(1), { timeout: 2_500 });
    // The export is still waiting on the collector, and this does not wait with it.
    await expect(withSpan('test.after', {}, async () => 'done')).resolves.toBe('done');
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });

  it('when the collector is down', async () => {
    const url = await closedPortUrl();
    const sdk = await loadSdk();
    const handle = await start(sdk, on(url), {
      exporter: new OTLPTraceExporter({ url, timeoutMillis: 300 }),
    });
    await expect(withSpan('test.span', {}, async () => 'done')).resolves.toBe('done');
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });
});
