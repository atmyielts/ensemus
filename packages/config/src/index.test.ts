import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadTelemetryConfig, loadWebConfig, readSecret } from './index';

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

describe('loadTelemetryConfig (ADR-037 D3)', () => {
  it('is off when no collector is named, which is the default', () => {
    expect(loadTelemetryConfig({})).toEqual({ enabled: false });
    expect(loadTelemetryConfig({ ENSEMUS_OTEL_ENDPOINT: '' })).toEqual({ enabled: false });
  });

  it('is on with a named collector, and keeps only its origin', () => {
    expect(loadTelemetryConfig({ ENSEMUS_OTEL_ENDPOINT: 'http://otel-collector:4318' })).toEqual({
      enabled: true,
      endpoint: 'http://otel-collector:4318',
      sampleRatio: 1,
      metricIntervalMs: 60_000,
    });
    expect(
      loadTelemetryConfig({
        ENSEMUS_OTEL_ENDPOINT: 'https://collector.example.invalid/',
        ENSEMUS_OTEL_SAMPLE_RATIO: '0.25',
        ENSEMUS_OTEL_METRIC_INTERVAL_SECONDS: '15',
      }),
    ).toEqual({
      enabled: true,
      endpoint: 'https://collector.example.invalid',
      sampleRatio: 0.25,
      metricIntervalMs: 15_000,
    });
  });

  it.each([
    ['not a URL', { ENSEMUS_OTEL_ENDPOINT: 'collector' }],
    ['another scheme', { ENSEMUS_OTEL_ENDPOINT: 'ftp://collector:4318' }],
    ['a credential', { ENSEMUS_OTEL_ENDPOINT: 'http://user:CANARY-PASSWORD@collector:4318' }],
    ['a query', { ENSEMUS_OTEL_ENDPOINT: 'http://collector:4318?token=CANARY-TOKEN' }],
    ['a fragment', { ENSEMUS_OTEL_ENDPOINT: 'http://collector:4318#x' }],
    ['a path', { ENSEMUS_OTEL_ENDPOINT: 'http://collector:4318/v1/traces' }],
    [
      'a ratio above one',
      { ENSEMUS_OTEL_ENDPOINT: 'http://c:4318', ENSEMUS_OTEL_SAMPLE_RATIO: '2' },
    ],
    [
      'a ratio that is no number',
      { ENSEMUS_OTEL_ENDPOINT: 'http://c:4318', ENSEMUS_OTEL_SAMPLE_RATIO: 'x' },
    ],
    [
      'a fast interval',
      { ENSEMUS_OTEL_ENDPOINT: 'http://c:4318', ENSEMUS_OTEL_METRIC_INTERVAL_SECONDS: '1' },
    ],
    ['a ratio with no collector', { ENSEMUS_OTEL_SAMPLE_RATIO: '0.5' }],
    ['an interval with no collector', { ENSEMUS_OTEL_METRIC_INTERVAL_SECONDS: '30' }],
  ])('refuses %s, naming the setting and never the value', (_label, env) => {
    let error: unknown;
    try {
      loadTelemetryConfig(env);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toMatch(/ENSEMUS_OTEL_/);
    expect((error as Error).message).not.toMatch(/CANARY/);
  });
});
