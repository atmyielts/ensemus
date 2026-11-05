import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadWebConfig, readSecret } from './index.js';

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
    });
  });

  it('names the bad field but never its value', () => {
    const run = () => loadWebConfig({ ...valid, ENSEMUS_MODE: 'do-not-echo-me' });
    expect(run).toThrow(/ENSEMUS_MODE/);
    expect(run).not.toThrow(/do-not-echo-me/);
  });
});
