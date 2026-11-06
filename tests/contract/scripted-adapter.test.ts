// Keeps the double honest: it passes the same suite the real adapters have to.
import { ScriptedModelAdapter } from '@ensemus/intelligence/testing';
import { describe, expect, it } from 'vitest';
import { describeModelAdapterContract, testCall } from './model-adapter.contract';

describeModelAdapterContract('ScriptedModelAdapter', (scenario) => {
  switch (scenario) {
    case 'answers_text':
      return new ScriptedModelAdapter([{ kind: 'final', text: 'Short.' }]);
    case 'proposes_tool':
      return new ScriptedModelAdapter([{ kind: 'tool_call', toolId: 'work.read', args: {} }]);
    case 'hangs_until_aborted':
      return new ScriptedModelAdapter([{ kind: 'hang' }]);
    case 'fails_rate_limited':
      return new ScriptedModelAdapter([{ kind: 'failure', failure: 'rate_limited' }]);
  }
});

describe('ScriptedModelAdapter', () => {
  it('counts every call, which is what "denied before egress" asserts on', async () => {
    const adapter = new ScriptedModelAdapter([{ kind: 'final', text: 'One.' }]);
    expect(adapter.hits).toBe(0);
    await adapter.generate(testCall(), new AbortController().signal);
    expect(adapter.hits).toBe(1);
  });

  it('refuses to run off its script, so a test cannot pass by accident', async () => {
    const adapter = new ScriptedModelAdapter([]);
    await expect(adapter.generate(testCall(), new AbortController().signal)).rejects.toThrow(
      'script ran out',
    );
  });
});
