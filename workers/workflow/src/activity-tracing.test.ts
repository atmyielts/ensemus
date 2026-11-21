// ADR-037 D3: what an Activity's span may carry. These watch the spans withSpan really makes, before any
// redaction at the exporter, so a canary that shows up here would have reached it. The provider is read
// through @ensemus/telemetry's own dependencies because lint keeps a worker off OpenTelemetry, and that
// rule is about shipped code: nothing here ships, and it sends nothing anywhere.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { ActivityInterceptorsFactory, ActivityExecuteInput } from '@temporalio/worker';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { activityTracing } from './activity-tracing';

type RecordedSpan = {
  name: string;
  attributes: Record<string, unknown>;
  status: { code: number; message?: string };
  events: unknown[];
};
type Exporter = { getFinishedSpans(): RecordedSpan[]; reset(): void };
type Provider = { forceFlush(): Promise<void>; shutdown(): Promise<void> };

const fromTelemetry = createRequire(
  fileURLToPath(new URL('../../../packages/telemetry/package.json', import.meta.url)),
);
const { trace } = fromTelemetry('@opentelemetry/api') as {
  trace: { setGlobalTracerProvider(provider: Provider): boolean; disable(): void };
};
const { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } = fromTelemetry(
  '@opentelemetry/sdk-trace-base',
) as {
  BasicTracerProvider: new (config: { spanProcessors: unknown[] }) => Provider;
  InMemorySpanExporter: new () => Exporter;
  SimpleSpanProcessor: new (exporter: Exporter) => unknown;
};

const STATUS_ERROR = 2;
const CANARY = 'CANARY-a1b2c3d4';

type ActivityContext = Parameters<ActivityInterceptorsFactory>[0];
const contextFor = (info: Record<string, unknown>) => ({ info }) as unknown as ActivityContext;

const INFO = {
  activityType: 'loadWorkContext',
  workflowExecution: { workflowId: 'work-org-1-unit-1', runId: 'run-1' },
  taskQueue: 'ensemus-platform',
  attempt: 3,
};
const FOUR_FIELDS = {
  activityType: 'loadWorkContext',
  workflowId: 'work-org-1-unit-1',
  taskQueue: 'ensemus-platform',
  attempt: 3,
};

const inputWith = (args: unknown[]) => ({ args, headers: {} }) as ActivityExecuteInput;

/** Runs the interceptor the way the Worker does: the factory per execution, then `execute`. */
function execute(
  input: ActivityExecuteInput,
  next: (input: ActivityExecuteInput) => Promise<unknown>,
  info: Record<string, unknown> = INFO,
) {
  const { inbound } = activityTracing()(contextFor(info));
  return inbound!.execute!(input, next);
}

describe('activityTracing with a provider registered', () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });

  const finished = async () => {
    await provider.forceFlush();
    return exporter.getFinishedSpans();
  };
  /** Everything a span holds that an exporter could send on. */
  const whatLeaves = ({ name, attributes, status, events }: RecordedSpan) =>
    JSON.stringify({ name, attributes, status, events });

  beforeAll(() => {
    expect(trace.setGlobalTracerProvider(provider)).toBe(true);
  });
  beforeEach(() => exporter.reset());
  afterAll(async () => {
    trace.disable();
    await provider.shutdown();
  });

  it('makes one span, named for what it is, with the four fields and nothing else', async () => {
    await execute(inputWith([]), async () => undefined);

    const spans = await finished();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe('activity.execute');
    expect(spans[0]?.attributes).toEqual(FOUR_FIELDS);
  });

  it('keeps no canary from the arguments or the result', async () => {
    const result = { text: CANARY };

    const returned = await execute(inputWith([{ prompt: CANARY }, CANARY]), async () => result);

    expect(returned).toBe(result);
    const spans = await finished();
    expect(spans).toHaveLength(1);
    expect(whatLeaves(spans[0]!)).not.toContain(CANARY);
  });

  it('passes on the same error, and the span holds its code and no message', async () => {
    const failure = Object.assign(new Error(`upstream said ${CANARY}`), {
      code: 'PROVIDER_REFUSED',
    });

    await expect(
      execute(inputWith([]), async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    const spans = await finished();
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.attributes).toEqual({ ...FOUR_FIELDS, errorCode: 'PROVIDER_REFUSED' });
    expect(span.status.code).toBe(STATUS_ERROR);
    expect(span.status.message).toBeUndefined();
    expect(span.events).toEqual([]);
    expect(whatLeaves(span)).not.toContain(CANARY);
  });

  it('refuses free text that arrives under a safe field name', async () => {
    await execute(inputWith([]), async () => undefined, {
      ...INFO,
      activityType: `not an identifier ${CANARY}`,
      taskQueue: `queue with spaces ${CANARY}`,
    });

    const spans = await finished();
    expect(spans[0]?.attributes).toEqual({
      workflowId: FOUR_FIELDS.workflowId,
      attempt: FOUR_FIELDS.attempt,
    });
    expect(whatLeaves(spans[0]!)).not.toContain(CANARY);
  });

  it('still runs an Activity no workflow started, without a workflow ID', async () => {
    const next = vi.fn(async () => 'done');
    const { workflowExecution: _none, ...standalone } = INFO;

    await expect(execute(inputWith([]), next, standalone)).resolves.toBe('done');

    const { workflowId: _absent, ...rest } = FOUR_FIELDS;
    expect((await finished())[0]?.attributes).toEqual(rest);
  });
});

describe('activityTracing with nothing registered, which is the default', () => {
  it('returns what the Activity returned', async () => {
    const result = { ok: true };
    await expect(execute(inputWith([]), async () => result)).resolves.toBe(result);
  });

  it('passes on the same error', async () => {
    const failure = new Error('the original');
    await expect(
      execute(inputWith([]), async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });
});

describe('what reaches the Activity', () => {
  it('calls next once, with the very input it was given', async () => {
    const input = inputWith([{ organizationId: 'org-1' }]);
    const next = vi.fn(async () => undefined);

    await execute(input, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0]).toEqual([input]);
    expect((next.mock.calls[0] as unknown[])[0]).toBe(input);
  });

  it('never reads the arguments', async () => {
    const input = {
      get args(): unknown[] {
        throw new Error('the interceptor read the arguments');
      },
      headers: {},
    } as ActivityExecuteInput;

    await expect(execute(input, async () => 'done')).resolves.toBe('done');
  });
});
