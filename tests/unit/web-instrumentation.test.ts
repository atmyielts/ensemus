// ADR-037 D3: what the web tier does about tracing when the server starts. A default install must not
// even load the SDK, and a bad setting must stop the process without repeating the value. The SDK is a
// double here, because what it sends is tested in packages/telemetry/src/tracing-sdk.test.ts. Whether a
// real image starts with tracing on is for tests/stack/tracing.test.ts, which needs Docker.
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addressesIn,
  emailsIn,
  leaksIn,
  readSink,
  sinkEnd,
  spansIn,
  waitForSpans,
} from '../helpers/otlp-sink';

const ENDPOINT = 'http://collector.invalid:4318/v1/traces';
const SDK = '@ensemus/telemetry/tracing-sdk';
const GUARD = '@ensemus/telemetry/console-guard';

describe('register in instrumentation.ts', () => {
  let steps: string[];
  let startTracing: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    steps = [];
    startTracing = vi.fn(async () => {
      steps.push('start');
      return { shutdown: async () => undefined };
    });
    // vi.doMock and not vi.mock, because a hoisted factory runs once for the whole file, and its result
    // outlives vi.resetModules. Each test here has to see for itself whether the module gets loaded.
    vi.resetModules();
    vi.doMock(SDK, () => {
      steps.push('sdk');
      return { startTracing };
    });
    // The real guard replaces console.error for the whole process, which would outlive the test.
    vi.doMock(GUARD, () => ({ installConsoleGuard: () => steps.push('guard') }));
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('ENSEMUS_OTEL_ENDPOINT', undefined);
    vi.stubEnv('ENSEMUS_OTEL_SAMPLE_RATIO', undefined);
    vi.stubEnv('ENSEMUS_RELEASE', undefined);
  });

  afterEach(() => {
    vi.doUnmock(SDK);
    vi.doUnmock(GUARD);
    vi.unstubAllEnvs();
  });

  const register = async () => (await import('../../apps/web/src/instrumentation')).register();

  describe('with tracing off', () => {
    it.each([
      ['nothing set', undefined],
      ['an empty setting', ''],
    ])('never loads the SDK, with %s', async (_label, endpoint) => {
      vi.stubEnv('ENSEMUS_OTEL_ENDPOINT', endpoint);
      await expect(register()).resolves.toBeUndefined();
      expect(steps).toEqual(['guard']);
      expect(startTracing).not.toHaveBeenCalled();
    });
  });

  describe('with tracing on', () => {
    beforeEach(() => vi.stubEnv('ENSEMUS_OTEL_ENDPOINT', ENDPOINT));

    it('starts it with the endpoint, after the guard, so a failure is logged safely', async () => {
      await register();
      expect(steps).toEqual(['guard', 'sdk', 'start']);
      expect(startTracing).toHaveBeenCalledExactlyOnceWith(
        'web',
        { enabled: true, endpoint: ENDPOINT, sampleRatio: 1 },
        {},
      );
    });

    it('names the release when there is one', async () => {
      vi.stubEnv('ENSEMUS_RELEASE', 'release-1');
      await register();
      expect(startTracing).toHaveBeenCalledWith('web', expect.anything(), { release: 'release-1' });
    });

    it('passes on the sample ratio', async () => {
      vi.stubEnv('ENSEMUS_OTEL_SAMPLE_RATIO', '0.25');
      await register();
      expect(startTracing).toHaveBeenCalledWith(
        'web',
        { enabled: true, endpoint: ENDPOINT, sampleRatio: 0.25 },
        {},
      );
    });

    it('does not hide a failure to start', async () => {
      const failure = new Error('could not start');
      startTracing.mockRejectedValueOnce(failure);
      await expect(register()).rejects.toBe(failure);
    });

    it('adds no signal handler, which could change how the server stops', async () => {
      const count = () => ['SIGTERM', 'SIGINT'].map((signal) => process.listenerCount(signal));
      const before = count();
      await register();
      expect(count()).toEqual(before);
    });
  });

  describe('outside the Node.js runtime', () => {
    it.each([
      ['edge', 'edge'],
      ['nothing', undefined],
    ])('does nothing, with NEXT_RUNTIME %s', async (_label, runtime) => {
      vi.stubEnv('NEXT_RUNTIME', runtime);
      // A bad value too: if the setting were read at all, this would reject.
      vi.stubEnv('ENSEMUS_OTEL_ENDPOINT', 'not a URL');
      await expect(register()).resolves.toBeUndefined();
      expect(steps).toEqual([]);
      expect(startTracing).not.toHaveBeenCalled();
    });
  });

  describe('with a bad setting', () => {
    const canary = `sk-CANARY-${randomUUID()}`;

    /** What `register` rejected with, or a failure if it did not. */
    const rejection = () =>
      register().then(
        () => expect.unreachable('register should have rejected'),
        (reason: unknown) => reason as Error,
      );

    it.each([
      ['ENSEMUS_OTEL_ENDPOINT', 'not a URL', canary],
      ['ENSEMUS_OTEL_ENDPOINT', 'another protocol', `ftp://collector.invalid/${canary}`],
      ['ENSEMUS_OTEL_ENDPOINT', 'a password', `http://someone:${canary}@collector.invalid/`],
      ['ENSEMUS_OTEL_ENDPOINT', 'a query', `http://collector.invalid/?token=${canary}`],
      ['ENSEMUS_OTEL_ENDPOINT', 'a fragment', `http://collector.invalid/#${canary}`],
    ])('rejects %s holding %s, with no value in the error', async (name, _label, value) => {
      vi.stubEnv(name, value);
      const error = await rejection();
      expect(error.name).toBe('ConfigError');
      expect(error.message).toContain(name);
      expect(`${error.message} ${error.stack} ${String(error)}`).not.toContain(canary);
      // The guard is in, so whatever reports this cannot print more than a code, and nothing started.
      expect(steps).toEqual(['guard']);
    });

    it('rejects a sample ratio that makes no sense, with no value in the error', async () => {
      vi.stubEnv('ENSEMUS_OTEL_ENDPOINT', ENDPOINT);
      vi.stubEnv('ENSEMUS_OTEL_SAMPLE_RATIO', canary);
      const error = await rejection();
      expect(error.name).toBe('ConfigError');
      expect(`${error.message} ${error.stack}`).not.toContain(canary);
      expect(steps).toEqual(['guard']);
    });
  });
});

// The stack test passes only if these can tell a leak from no leak. It cannot run here, so what it
// decides is shown to work on what a sink would have written.
describe('reading what a sink wrote', () => {
  const folder = mkdtempSync(join(tmpdir(), 'otlp-sink-'));
  const file = join(folder, 'spans.jsonl');

  const anExport = (service: string, name: string, attributes: Record<string, unknown>) =>
    JSON.stringify({
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
          scopeSpans: [
            {
              spans: [
                {
                  name,
                  status: { code: 1 },
                  attributes: Object.entries(attributes).map(([key, value]) => ({
                    key,
                    value:
                      typeof value === 'number' ? { intValue: value } : { stringValue: value },
                  })),
                },
              ],
            },
          ],
        },
      ],
    });

  afterEach(() => rmSync(file, { force: true }));
  afterAll(() => rmSync(folder, { recursive: true, force: true }));

  it('reads an empty file and a missing one as nothing yet', () => {
    expect(readSink(file)).toBe('');
    expect(sinkEnd(file)).toBe(0);
    writeFileSync(file, '');
    expect(spansIn(readSink(file))).toEqual([]);
  });

  it('finds each span, with its service and attributes', () => {
    writeFileSync(
      file,
      `${anExport('web', 'GET /invite/[token]', { 'next.route': '/invite/[token]', 'http.response.status_code': 200 })}\n`,
    );
    expect(spansIn(readSink(file))).toEqual([
      {
        service: 'web',
        name: 'GET /invite/[token]',
        attributes: { 'next.route': '/invite/[token]', 'http.response.status_code': 200 },
        statusMessage: '',
        eventCount: 0,
        linkAttributeCount: 0,
      },
    ]);
  });

  it('leaves out a line still being written, and refuses a whole line it cannot read', () => {
    writeFileSync(file, `${anExport('web', 'first', {})}\n{"resourceSpans":[{"res`);
    expect(spansIn(readSink(file)).map((span) => span.name)).toEqual(['first']);
    appendFileSync(file, '\n');
    expect(() => spansIn(readSink(file))).toThrow(/not an OTLP JSON export/);
  });

  it('reads only what arrived after a point in the file', () => {
    writeFileSync(file, `${anExport('web', 'before', {})}\n{"partial`);
    const from = sinkEnd(file);
    appendFileSync(file, `":1}\n${anExport('web', 'after', {})}\n`);
    // The point is the end of the last whole line, so a line in progress is read whole, or not at all.
    expect(() => spansIn(readSink(file, from))).not.toThrow();
    expect(spansIn(readSink(file, from)).map((span) => span.name)).toEqual(['after']);
  });

  it('notices a status message, an event and a link attribute', () => {
    const span = {
      name: 'x',
      status: { code: 2, message: 'boom' },
      events: [{ name: 'exception' }],
      links: [{ attributes: [{ key: 'a', value: { stringValue: 'b' } }] }],
    };
    writeFileSync(
      file,
      `${JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [span] }] }] })}\n`,
    );
    expect(spansIn(readSink(file))).toEqual([
      {
        service: undefined,
        name: 'x',
        attributes: {},
        statusMessage: 'boom',
        eventCount: 1,
        linkAttributeCount: 1,
      },
    ]);
  });

  it('stops waiting when the span comes, and says so when it never does', async () => {
    writeFileSync(file, `${anExport('web', 'here', {})}\n`);
    await expect(
      waitForSpans(file, 0, (spans) => spans.some((span) => span.name === 'here'), 50),
    ).resolves.toHaveLength(1);
    await expect(
      waitForSpans(file, 0, (spans) => spans.some((span) => span.name === 'gone'), 50),
    ).rejects.toThrow(/did not arrive/);
  });

  it('finds a planted value, an email and a network address, and nothing in a clean span', () => {
    const planted = `sk-CANARY-${randomUUID()}`;
    const dirty = anExport('web', `GET /invite/${planted}`, {
      'http.url': `https://person@example.invalid/invite/${planted}`,
      'net.peer.ip': '203.0.113.7',
    });
    expect(leaksIn(dirty, [planted, 'absent'])).toEqual([planted]);
    expect(emailsIn(dirty)).toEqual(['person@example.invalid']);
    expect(addressesIn(spansIn(`${dirty}\n`))).toEqual(['203.0.113.7']);

    const clean = anExport('web', 'GET /invite/[token]', { 'next.route': '/invite/[token]' });
    expect(leaksIn(clean, [planted])).toEqual([]);
    expect(emailsIn(clean)).toEqual([]);
    expect(addressesIn(spansIn(`${clean}\n`))).toEqual([]);
  });
});
