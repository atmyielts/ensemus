import { describe, expect, it } from 'vitest';
import { generationInputBytes, generationRequestHash } from './adapters';
import { mainResultHash } from './main-input-snapshot';

const call = {
  providerKind: 'local_openai_compatible' as const,
  endpointUrl: 'http://model.example.invalid/v1',
  modelId: 'test-model',
  messages: [
    { role: 'task' as const, partId: 'work', text: 'A task', classification: 'internal' as const },
  ],
  tools: [
    { id: 'agent.delegate', version: '1', description: 'Delegate', parameters: { type: 'object' } },
  ],
  responseSchema: null,
  maxOutputTokens: 40,
  timeoutMs: 5000,
};

describe('trusted main-model input and response identity', () => {
  it('binds the actual rendered request, tools, schema, endpoint and provider options', () => {
    const original = generationRequestHash(call);
    expect(original).toMatch(/^[0-9a-f]{64}$/);
    expect(generationRequestHash({ ...call })).toBe(original);
    for (const changed of [
      { ...call, messages: [{ ...call.messages[0]!, text: 'Changed' }] },
      { ...call, tools: [{ ...call.tools[0]!, version: '2' }] },
      { ...call, tools: [{ ...call.tools[0]!, parameters: { type: 'string' } }] },
      { ...call, responseSchema: { type: 'object' } },
      { ...call, maxOutputTokens: 41 },
      { ...call, modelId: 'another-model' },
      { ...call, endpointUrl: 'http://another.example.invalid/v1' },
      { ...call, timeoutMs: 5001 },
    ])
      expect(generationRequestHash(changed)).not.toBe(original);
  });

  it('does not change the existing provider-neutral admission byte count', () => {
    const bytes = generationInputBytes(call);
    generationRequestHash(call);
    expect(generationInputBytes(call)).toBe(bytes);
    // Tool protocol versions are trusted provenance, not extra provider text/token spend.
    expect(generationInputBytes({ ...call, tools: [{ ...call.tools[0]!, version: '2' }] })).toBe(
      bytes,
    );
  });

  it('matches exact JSON proposal serialization and separates tool identity and final text', () => {
    const args = { title: 'Child task', tools: ['work.read'] };
    const tool = mainResultHash({ kind: 'tool_call', toolId: 'agent.delegate', args, usage: null });
    expect(tool.kind).toBe('tool_call');
    expect(tool.toolId).toBe('agent.delegate');
    expect(tool.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(
      mainResultHash({ kind: 'tool_call', toolId: 'work.read', args, usage: null }),
    ).not.toEqual(tool);
    expect(
      mainResultHash({
        kind: 'tool_call',
        toolId: 'agent.delegate',
        args: { ...args, title: 'Other' },
        usage: null,
      }).payloadHash,
    ).not.toBe(tool.payloadHash);
    expect(mainResultHash({ kind: 'final', text: 'Child task', usage: null }).kind).toBe('final');
  });
});
