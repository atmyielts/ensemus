// What every ModelAdapter has to do, double or real (ADR-028). The transport slice runs this over the real
// adapters against the fake model server, so the double cannot drift from what the real ones do.
import type { AdapterCall, AdapterResult, ModelAdapter } from '@ensemus/intelligence';
import { describe, expect, it } from 'vitest';

export const testCall = (overrides: Partial<AdapterCall> = {}): AdapterCall => ({
  providerKind: 'local_openai_compatible',
  modelId: 'contract-model',
  endpointUrl: 'http://127.0.0.1:1/v1',
  messages: [
    { role: 'policy', partId: 'p1', text: 'Follow policy.', classification: 'internal' },
    { role: 'task', partId: 't1', text: 'Say something short.', classification: 'internal' },
  ],
  tools: [],
  responseSchema: null,
  maxOutputTokens: 16,
  timeoutMs: 5_000,
  fetch: () => Promise.reject(new Error('This contract never reaches a network')),
  apiKey: null,
  ...overrides,
});

export type AdapterScenario =
  | 'answers_text'
  | 'proposes_tool'
  | 'hangs_until_aborted'
  | 'fails_rate_limited';

/** `make` returns an adapter set up to behave as the scenario says on its next call. */
export function describeModelAdapterContract(
  name: string,
  make: (scenario: AdapterScenario) => ModelAdapter | Promise<ModelAdapter>,
) {
  const generate = async (scenario: AdapterScenario, signal = new AbortController().signal) =>
    (await make(scenario)).generate(testCall(), signal);

  const isTyped = (result: AdapterResult) =>
    ['final', 'tool_call', 'failure'].includes(result.kind);

  describe(`ModelAdapter contract: ${name}`, () => {
    it('answers with text as a final result', async () => {
      const result = await generate('answers_text');
      expect(result.kind).toBe('final');
    });

    it('reports a tool call without trusting or running it', async () => {
      const result = await generate('proposes_tool');
      expect(result.kind).toBe('tool_call');
    });

    it('aborts when asked, as a typed failure and not a throw', async () => {
      const controller = new AbortController();
      const pending = generate('hangs_until_aborted', controller.signal);
      setTimeout(() => controller.abort(), 10);
      const result = await pending;
      expect(result).toMatchObject({ kind: 'failure', failure: 'cancelled' });
    });

    it('reports a provider failure as a code, with no provider text', async () => {
      const result = await generate('fails_rate_limited');
      expect(isTyped(result)).toBe(true);
      expect(result).toMatchObject({ kind: 'failure', failure: 'rate_limited' });
      expect(Object.keys(result).sort()).toEqual(['failure', 'kind', 'mayHaveBilled', 'usage']);
    });
  });
}
