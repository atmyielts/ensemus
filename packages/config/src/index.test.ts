import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  loadTelemetryConfig,
  loadEvaluationSigningSettings,
  loadEvaluationTrustSettings,
  loadWebConfig,
  readSecret,
} from './index';

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

describe('loadEvaluationTrustSettings', () => {
  const key = 'A'.repeat(43);

  it('trusts nothing and keeps reports a week when nothing is set', () => {
    expect(loadEvaluationTrustSettings({})).toEqual({ publicKeys: [], maxAgeHours: 168 });
  });

  it('reads two keys at once, which is how a key is rotated', () => {
    expect(
      loadEvaluationTrustSettings({
        ENSEMUS_EVALUATION_PUBLIC_KEYS: ` ci-2026:${key}, ci-2027:${'B'.repeat(43)} `,
        ENSEMUS_EVALUATION_REPORT_MAX_AGE_HOURS: '24',
      }),
    ).toEqual({
      publicKeys: [
        { keyId: 'ci-2026', publicKey: key },
        { keyId: 'ci-2027', publicKey: 'B'.repeat(43) },
      ],
      maxAgeHours: 24,
    });
  });

  it('reads them from a mounted file first, one per line or comma', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'cfg-')), 'keys');
    writeFileSync(file, `ci-2026:${key}\nci-2027:${'C'.repeat(43)}\n`);
    expect(
      loadEvaluationTrustSettings({
        ENSEMUS_EVALUATION_PUBLIC_KEYS_FILE: file,
        ENSEMUS_EVALUATION_PUBLIC_KEYS: `other:${'D'.repeat(43)}`,
      }).publicKeys.map((entry) => entry.keyId),
    ).toEqual(['ci-2026', 'ci-2027']);
  });

  it.each([
    ['no key id', `:${key}`],
    ['a key of the wrong length', 'ci:abc'],
    ['a third part', `ci:${key}:extra`],
    ['the same id twice', `ci:${key},ci:${key}`],
    ['an upper-case id', `CI:${key}`],
  ])('refuses %s, naming the setting and never the value', (_label, value) => {
    expect(() => loadEvaluationTrustSettings({ ENSEMUS_EVALUATION_PUBLIC_KEYS: value })).toThrow(
      new ConfigError('Invalid ENSEMUS_EVALUATION_PUBLIC_KEYS'),
    );
  });

  it.each(['0', '-1', '1.5', 'week', '9000'])('refuses a max age of %s', (value) => {
    expect(() =>
      loadEvaluationTrustSettings({ ENSEMUS_EVALUATION_REPORT_MAX_AGE_HOURS: value }),
    ).toThrow(/ENSEMUS_EVALUATION_REPORT_MAX_AGE_HOURS/);
  });
});

describe('loadEvaluationSigningSettings', () => {
  it('is off when no key id is set', () => {
    expect(loadEvaluationSigningSettings({})).toBeNull();
  });

  it('reads the key like any other secret', () => {
    expect(
      loadEvaluationSigningSettings({
        ENSEMUS_EVALUATION_SIGNING_KEY_ID: 'ci-2026',
        ENSEMUS_EVALUATION_SIGNING_KEY: 'pem',
      }),
    ).toEqual({ keyId: 'ci-2026', privateKeyPem: 'pem' });
  });

  it('refuses a key id without its key, and a malformed id', () => {
    expect(() =>
      loadEvaluationSigningSettings({ ENSEMUS_EVALUATION_SIGNING_KEY_ID: 'ci-2026' }),
    ).toThrow(ConfigError);
    expect(() =>
      loadEvaluationSigningSettings({
        ENSEMUS_EVALUATION_SIGNING_KEY_ID: 'Has Spaces',
        ENSEMUS_EVALUATION_SIGNING_KEY: 'pem',
      }),
    ).toThrow(ConfigError);
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
