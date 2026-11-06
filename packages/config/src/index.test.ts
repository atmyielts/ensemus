import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadTracingConfig, loadWebConfig, readSecret } from './index';

describe('loadTracingConfig (ADR-037 D3)', () => {
  const ENDPOINT = 'http://collector.internal:4318/v1/traces';

  it('is off unless an operator names a collector', () => {
    expect(loadTracingConfig({})).toEqual({ enabled: false });
  });

  it('reads a collector, and keeps every trace unless told otherwise', () => {
    expect(loadTracingConfig({ ENSEMUS_OTEL_ENDPOINT: ENDPOINT })).toEqual({
      enabled: true,
      endpoint: ENDPOINT,
      sampleRatio: 1,
    });
    expect(
      loadTracingConfig({ ENSEMUS_OTEL_ENDPOINT: ENDPOINT, ENSEMUS_OTEL_SAMPLE_RATIO: '0.25' }),
    ).toMatchObject({ sampleRatio: 0.25 });
  });

  it.each([
    ['not a URL', 'collector'],
    ['another protocol', 'ftp://collector.internal/v1/traces'],
    ['a username', 'http://someone@collector.internal/v1/traces'],
    ['a password', 'http://someone:sk-CANARY@collector.internal/v1/traces'],
    ['a query', 'http://collector.internal/v1/traces?token=sk-CANARY'],
    ['a fragment', 'http://collector.internal/v1/traces#sk-CANARY'],
  ])('refuses %s, and does not repeat the value', (_label, value) => {
    const load = () => loadTracingConfig({ ENSEMUS_OTEL_ENDPOINT: value });
    expect(load).toThrow(ConfigError);
    expect(load).not.toThrow(/CANARY/);
  });

  it.each(['-0.1', '1.1', 'half'])('refuses a sample ratio of %s', (ratio) => {
    expect(() =>
      loadTracingConfig({ ENSEMUS_OTEL_ENDPOINT: ENDPOINT, ENSEMUS_OTEL_SAMPLE_RATIO: ratio }),
    ).toThrow(ConfigError);
  });

  it('refuses a sample ratio with nowhere to send, which looks on and is not', () => {
    expect(() => loadTracingConfig({ ENSEMUS_OTEL_SAMPLE_RATIO: '0.5' })).toThrow(ConfigError);
  });
});

describe('readSecret', () => {
  it('prefers the mounted file', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'cfg-')), 'secret');
    writeFileSync(file, 'from-file\n');
    expect(readSecret('X', { X_FILE: file, X: 'from-env' })).toBe('from-file');
  });

  it('fails when the secret is missing', () => {
    expect(() => readSecret('X', {})).toThrow(ConfigError);
  });
});

describe('loadWebConfig', () => {
  const valid = { ENSEMUS_MODE: 'sovereign', ENSEMUS_PUBLIC_URL: 'https://e.example' };

  it('parses valid settings and defaults signup to off', () => {
    expect(loadWebConfig(valid)).toEqual({
      mode: 'sovereign',
      publicUrl: 'https://e.example',
      allowSignup: false,
      connectorsEnabled: false,
    });
  });

  it('turns connectors on only when asked', () => {
    expect(loadWebConfig({ ...valid, ENSEMUS_CONNECTORS_ENABLED: 'true' }).connectorsEnabled).toBe(
      true,
    );
    expect(() => loadWebConfig({ ...valid, ENSEMUS_CONNECTORS_ENABLED: 'yes' })).toThrow(
      /ENSEMUS_CONNECTORS_ENABLED/,
    );
  });

  it('names the bad field but never its value', () => {
    const run = () => loadWebConfig({ ...valid, ENSEMUS_MODE: 'do-not-echo-me' });
    expect(run).toThrow(/ENSEMUS_MODE/);
    expect(run).not.toThrow(/do-not-echo-me/);
  });
});
