// ADR-034: everything here is off until an operator turns it on, and a config error names the setting and never
// its value.
import { generateKeyPairSync, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SANDBOX_DEFAULT_CEILINGS } from '@ensemus/domain/sandbox';
import {
  ConfigError,
  loadReviewKeys,
  loadSandboxCeilings,
  loadSandboxRunnerConfig,
  loadSandboxWorkerConfig,
  loadSkillFeatures,
} from './index';

describe('the features', () => {
  it('are all off by default', () => {
    expect(loadSkillFeatures({})).toEqual({
      skill_catalog: false,
      sandbox: false,
      marketplace: false,
    });
  });

  it('turn on one at a time', () => {
    expect(loadSkillFeatures({ ENSEMUS_SANDBOX_ENABLED: 'true' })).toEqual({
      skill_catalog: false,
      sandbox: true,
      marketplace: false,
    });
  });

  it('refuse anything but true or false', () => {
    expect(() => loadSkillFeatures({ ENSEMUS_MARKETPLACE_ENABLED: 'yes' })).toThrow(ConfigError);
  });
});

describe('the ceilings', () => {
  it('default to the domain defaults', () => {
    expect(loadSandboxCeilings({})).toEqual(SANDBOX_DEFAULT_CEILINGS);
  });

  it('take a setting', () => {
    expect(loadSandboxCeilings({ ENSEMUS_SANDBOX_MAX_MEMORY_MB: '128' }).memoryMb).toBe(128);
  });

  it.each(['0', '-1', '1.5', 'lots', ''])('refuse %j, and name only the setting', (value) => {
    expect(() => loadSandboxCeilings({ ENSEMUS_SANDBOX_MAX_PIDS: value })).toThrow(
      /ENSEMUS_SANDBOX_MAX_PIDS must be/,
    );
  });
});

describe('the review keys', () => {
  const rawKey = () =>
    generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);

  it('are none by default, so nothing can be installed', () => {
    expect(loadReviewKeys({}).size).toBe(0);
    expect(loadReviewKeys({ ENSEMUS_MARKETPLACE_REVIEW_KEYS: ' , ' }).size).toBe(0);
  });

  it('are found by the hash of the key', () => {
    const key = rawKey();
    const keys = loadReviewKeys({ ENSEMUS_MARKETPLACE_REVIEW_KEYS: key.toString('base64') });
    const id = createHash('sha256').update(key).digest('hex');
    expect(keys.get(id)?.equals(key)).toBe(true);
  });

  it.each([
    ['too short', Buffer.alloc(31).toString('base64')],
    ['too long', Buffer.alloc(33).toString('base64')],
    ['not base64', 'not a key!'],
  ])('refuse one that is %s, without quoting it', (_, value) => {
    const load = () => loadReviewKeys({ ENSEMUS_MARKETPLACE_REVIEW_KEYS: value });
    expect(load).toThrow(ConfigError);
    expect(load).not.toThrow(value);
  });
});

describe('the sandbox processes', () => {
  it('give the runner no runtime unless one is named, so it refuses every job', () => {
    expect(loadSandboxRunnerConfig({}).runtimeBinary).toBeNull();
    expect(
      loadSandboxRunnerConfig({ ENSEMUS_SANDBOX_RUNTIME_BINARY: '/usr/bin/runsc' }).runtimeBinary,
    ).toBe('/usr/bin/runsc');
  });

  it('bound what one tenant can run at once', () => {
    expect(loadSandboxWorkerConfig({}).maxConcurrentPerTenant).toBeGreaterThan(0);
    expect(() =>
      loadSandboxWorkerConfig({ ENSEMUS_SANDBOX_MAX_CONCURRENT_PER_TENANT: '0' }),
    ).toThrow(ConfigError);
  });
});
