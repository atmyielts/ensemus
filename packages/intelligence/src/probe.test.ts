// MODEL-01, FD-23: a probe passes only on a real answer from the real path, and fails closed on anything
// else. "Denied before egress" means zero adapter hits and zero keys asked for.
import { randomBytes, randomUUID } from 'node:crypto';
import type { RoutableProfile } from '@ensemus/application/ai-ports';
import { describe, expect, it, vi } from 'vitest';
import { createProfileProber, judgeProbeResult, PROBE_MESSAGES } from './probe';
import { RecordingLender, ScriptedModelAdapter, type ScriptStep } from './testing';
import {
  ADAPTER_FAILURES,
  type CredentialLender,
  type EndpointGuard,
  type VerifiedEndpoint,
} from './types';

// The transport slice owns the real check. This stands for its answer, so each case here can choose it.
const endpointOk = vi.hoisted(() => ({ value: true }));
vi.mock('@ensemus/policy/endpoint', () => ({
  checkEndpoint: (_kind: string, endpointUrl: string) =>
    endpointOk.value
      ? {
          ok: true,
          host: new URL(endpointUrl).hostname,
          port: 8080,
          viaPrivateAllowlist: true,
        }
      : { ok: false, code: 'MODEL_ENDPOINT_NOT_ALLOWED' },
}));

const ORGANIZATION = randomUUID();
const TENANT_CANARY = `tenant-${randomBytes(12).toString('hex')}`;
const target = { organizationId: ORGANIZATION, profileId: randomUUID() };

const profile = (overrides: Partial<RoutableProfile> = {}): RoutableProfile => ({
  id: target.profileId,
  version: 4,
  providerKind: 'local_openai_compatible',
  modelId: 'scripted-test-model',
  alias: TENANT_CANARY,
  endpointUrl: 'http://models.example.invalid:8080/v1',
  secretRef: randomUUID(),
  billingOwner: 'customer',
  destination: 'customer_private_inference',
  region: null,
  capabilities: ['text'],
  limits: { maxInputTokens: 4096, maxOutputTokens: 512 },
  allowedClasses: ['public'],
  allowedPurposes: ['reason'],
  retentionBasis: 'self_hosted',
  contractRef: TENANT_CANARY,
  fallbackProfileIds: [],
  crossBillingApproved: false,
  status: 'probing',
  ...overrides,
});

function harness(
  script: readonly ScriptStep[],
  loaded: RoutableProfile | null = profile(),
  overrides: { guard?: EndpointGuard; credentials?: CredentialLender } = {},
) {
  endpointOk.value = true;
  const adapter = new ScriptedModelAdapter(script);
  const lender = new RecordingLender(randomBytes(16));
  const asked: VerifiedEndpoint[] = [];
  const guard: EndpointGuard = overrides.guard ?? {
    fetchFor: (endpoint) => {
      asked.push(endpoint);
      return fetch;
    },
  };
  const failures: string[] = [];
  const prober = createProfileProber({
    load: async () => loaded,
    adapter,
    guard,
    credentials: overrides.credentials ?? lender,
    privateEndpoints: ['http://models.example.invalid:8080'],
    onFailed: (code) => failures.push(code),
  });
  return { adapter, lender, asked, prober, failures };
}

describe('a probe that passes', () => {
  it('sends one call through the guard, with the lent key', async () => {
    const { adapter, lender, asked, prober } = harness([{ kind: 'final', text: 'ready' }]);
    await expect(prober.probe(target)).resolves.toBe('passed');
    expect(adapter.hits).toBe(1);
    expect(lender.asked).toHaveLength(1);
    expect(lender.asked[0]).toMatchObject({
      organizationId: ORGANIZATION,
      profileId: target.profileId,
      endpointUrl: 'http://models.example.invalid:8080/v1',
      providerKind: 'local_openai_compatible',
    });
    expect(asked).toEqual([
      {
        host: 'models.example.invalid',
        port: 8080,
        protocol: 'http:',
        viaPrivateAllowlist: true,
      },
    ]);
    expect(adapter.calls[0]?.apiKey).toBeInstanceOf(Buffer);
  });

  it('works without a key for a local model that has none, asking the lender for nothing', async () => {
    const { adapter, lender, prober } = harness(
      [{ kind: 'final', text: 'ready' }],
      profile({ secretRef: null }),
    );
    await expect(prober.probe(target)).resolves.toBe('passed');
    expect(lender.asked).toEqual([]);
    expect(adapter.calls[0]?.apiKey).toBeNull();
  });

  it('holds nothing of the tenant’s, offers no tools and asks for little', async () => {
    const { adapter, prober } = harness([{ kind: 'final', text: 'ready' }]);
    await prober.probe(target);
    const call = adapter.calls[0]!;
    expect(call.messages).toEqual(PROBE_MESSAGES);
    expect(JSON.stringify(call.messages)).not.toContain(TENANT_CANARY);
    expect(call.messages.every((message) => message.classification === 'public')).toBe(true);
    expect(call.tools).toEqual([]);
    expect(call.responseSchema).toBeNull();
    expect(call.maxOutputTokens).toBeLessThanOrEqual(16);
  });

  it('asks for no more than the profile allows', async () => {
    const { adapter, prober } = harness(
      [{ kind: 'final', text: 'ready' }],
      profile({ limits: { maxInputTokens: 4096, maxOutputTokens: 4 } }),
    );
    await prober.probe(target);
    expect(adapter.calls[0]?.maxOutputTokens).toBe(4);
  });
});

describe('a probe fails closed', () => {
  it.each(ADAPTER_FAILURES)('on an adapter failure of %s', async (failure) => {
    const { prober, failures } = harness([{ kind: 'failure', failure }]);
    await expect(prober.probe(target)).resolves.toBe('failed');
    expect(failures).toEqual([`ADAPTER_${failure.toUpperCase()}`]);
  });

  it('on a tool call, when no tool was offered', async () => {
    const { prober } = harness([{ kind: 'tool_call', toolId: 'work.read', args: {} }]);
    await expect(prober.probe(target)).resolves.toBe('failed');
  });

  it.each(['', '   \n'])('on an empty answer (%j)', async (text) => {
    const { prober } = harness([{ kind: 'final', text }]);
    await expect(prober.probe(target)).resolves.toBe('failed');
  });

  it('when an adapter throws, which is a bug', async () => {
    const { prober, failures } = harness([{ kind: 'throw' }]);
    await expect(prober.probe(target)).resolves.toBe('failed');
    expect(failures).toEqual(['THREW']);
  });

  it('when the load throws', async () => {
    const prober = createProfileProber({
      load: () => Promise.reject(new Error('database gone')),
      adapter: new ScriptedModelAdapter([]),
      guard: { fetchFor: () => fetch },
      credentials: new RecordingLender(randomBytes(4)),
      privateEndpoints: [],
    });
    await expect(prober.probe(target)).resolves.toBe('failed');
  });

  it('when the key cannot be opened, sending nothing', async () => {
    const credentials: CredentialLender = {
      withKey: () => Promise.reject(new Error('Secret is not available')),
    };
    const { adapter, prober } = harness([{ kind: 'final', text: 'ready' }], profile(), {
      credentials,
    });
    await expect(prober.probe(target)).resolves.toBe('failed');
    expect(adapter.hits).toBe(0);
  });

  it('when the guard refuses, sending nothing', async () => {
    const guard: EndpointGuard = {
      fetchFor: () => {
        throw new Error('refused');
      },
    };
    const { adapter, prober } = harness([{ kind: 'final', text: 'ready' }], profile(), { guard });
    await expect(prober.probe(target)).resolves.toBe('failed');
    expect(adapter.hits).toBe(0);
  });

  it('when the profile is no longer waiting for this, opening no key and sending nothing', async () => {
    const { adapter, lender, prober, failures } = harness([{ kind: 'final', text: 'ready' }], null);
    await expect(prober.probe(target)).resolves.toBe('failed');
    expect(adapter.hits).toBe(0);
    expect(lender.asked).toEqual([]);
    expect(failures).toEqual(['NOT_PROBING']);
  });

  it('when the address is refused, opening no key and sending nothing', async () => {
    const { adapter, lender, prober, failures } = harness([{ kind: 'final', text: 'ready' }]);
    endpointOk.value = false;
    await expect(prober.probe(target)).resolves.toBe('failed');
    expect(adapter.hits).toBe(0);
    expect(lender.asked).toEqual([]);
    expect(failures).toEqual(['ENDPOINT_REFUSED']);
  });

  it.each(['openai_hosted', 'anthropic_hosted', 'openai_compatible'] as const)(
    'when %s has no key, sending nothing',
    async (providerKind) => {
      const { adapter, lender, prober, failures } = harness(
        [{ kind: 'final', text: 'ready' }],
        profile({ providerKind, secretRef: null }),
      );
      await expect(prober.probe(target)).resolves.toBe('failed');
      expect(adapter.hits).toBe(0);
      expect(lender.asked).toEqual([]);
      expect(failures).toEqual(['NO_KEY']);
    },
  );

  it('with an answer or an error that echoes the key, and tells the operator only a code', async () => {
    const key = randomBytes(16);
    const secret = key.toString('hex');
    const prober = (failures: string[]) =>
      createProfileProber({
        load: async () => profile(),
        adapter: {
          generate: async () => {
            throw new Error(`upstream said: ${secret}`);
          },
        },
        guard: { fetchFor: () => fetch },
        credentials: new RecordingLender(key),
        privateEndpoints: [],
        onFailed: (code) => failures.push(code),
      });
    endpointOk.value = true;
    const failures: string[] = [];
    await expect(prober(failures).probe(target)).resolves.toBe('failed');
    expect(JSON.stringify(failures)).not.toContain(secret);
  });
});

describe('judging an answer', () => {
  it('passes only a final answer with words in it', () => {
    expect(judgeProbeResult({ kind: 'final', text: 'ready', usage: null })).toBeNull();
    expect(judgeProbeResult({ kind: 'final', text: ' ', usage: null })).toBe('EMPTY_ANSWER');
    expect(judgeProbeResult({ kind: 'tool_call', toolId: 'x', args: {}, usage: null })).toBe(
      'NOT_A_FINAL_ANSWER',
    );
    expect(
      judgeProbeResult({ kind: 'failure', failure: 'timeout', mayHaveBilled: true, usage: null }),
    ).toBe('ADAPTER_TIMEOUT');
  });
});
