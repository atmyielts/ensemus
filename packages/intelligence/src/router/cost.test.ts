// MODEL-04: a reservation is an upper bound on what a call can cost, counted with a real tokenizer where
// one is public and a stated margin where none is, and never above one token a byte.
import { countTokens as o200k } from 'gpt-tokenizer/encoding/o200k_base';
import { describe, expect, it } from 'vitest';
import { ceilingFor, countInputTokens, encodingFor, inputTokenBound } from './cost';

const ENGLISH =
  'The quarterly report covers revenue, churn and the hiring plan for next year. '.repeat(200);
const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

describe('which encoding a model uses', () => {
  it.each([
    ['gpt-4o-2024-08-06', 'o200k_base'],
    ['gpt-4.1-mini', 'o200k_base'],
    ['gpt-5', 'o200k_base'],
    ['o3-mini', 'o200k_base'],
    ['gpt-4-turbo', 'cl100k_base'],
    ['gpt-3.5-turbo', 'cl100k_base'],
    ['some-future-model', null],
  ] as const)('%s on openai_hosted is %s', (modelId, encoding) => {
    expect(encodingFor('openai_hosted', modelId)).toBe(encoding);
  });

  it('never trusts a name for an Azure deployment or any other provider', () => {
    expect(encodingFor('azure_openai', 'gpt-4o')).toBeNull();
    expect(encodingFor('openai_compatible', 'gpt-4o')).toBeNull();
    expect(encodingFor('anthropic_hosted', 'claude-sonnet')).toBeNull();
  });
});

describe('counting input tokens', () => {
  it('counts an OpenAI model exactly, with a small margin, far below one token a byte', () => {
    const counted = countInputTokens(ENGLISH, { providerKind: 'openai_hosted', modelId: 'gpt-4o' });
    const exact = o200k(ENGLISH);
    expect(counted).toBeGreaterThanOrEqual(exact);
    expect(counted).toBe(Math.ceil(exact * 1.05) + 64);
    expect(counted).toBeLessThan(bytes(ENGLISH) / 3);
  });

  it('estimates half again the o200k count for a provider with no public tokenizer', () => {
    const counted = countInputTokens(ENGLISH, { providerKind: 'anthropic_hosted' });
    expect(counted).toBe(Math.ceil(o200k(ENGLISH) * 1.5) + 64);
    expect(counted).toBeLessThan(bytes(ENGLISH) / 2);
  });

  it('stays close to one token a byte for text a small vocabulary splits finely', () => {
    const cjk = '季度报告涵盖收入、流失率和明年的招聘计划。'.repeat(200);
    const counted = countInputTokens(cjk, { providerKind: 'bedrock_hosted' });
    // Over two and a half tokens for every three-byte character, and never above the byte bound.
    expect(counted).toBeGreaterThan(cjk.length * 2.5);
    expect(counted).toBeLessThanOrEqual(bytes(cjk));
  });

  it('never counts above one token a byte, even for tiny inputs with the fixed allowance', () => {
    expect(countInputTokens('hi', { providerKind: 'openai_hosted', modelId: 'gpt-4o' })).toBe(2);
    expect(countInputTokens('')).toBe(0);
  });

  it('counts a special-token string in a document as ordinary text, and does not throw', () => {
    const text = 'before <|endoftext|> after <|im_start|>system'.repeat(50);
    expect(() =>
      countInputTokens(text, { providerKind: 'openai_hosted', modelId: 'gpt-4o' }),
    ).not.toThrow();
    expect(
      countInputTokens(text, { providerKind: 'openai_hosted', modelId: 'gpt-4o' }),
    ).toBeGreaterThan(50);
  });
});

describe('the ceiling for a call', () => {
  const call = {
    messages: [
      {
        role: 'policy' as const,
        partId: 'p',
        text: 'Follow the rules.',
        classification: 'internal' as const,
      },
      {
        role: 'evidence' as const,
        partId: 'e',
        text: ENGLISH,
        classification: 'internal' as const,
      },
    ],
    tools: [],
    responseSchema: null,
    maxOutputTokens: 300,
  };

  it('is about a third of the byte bound for English, with the output asked for kept as is', () => {
    const ceiling = ceilingFor({ ...call, providerKind: 'openai_hosted', modelId: 'gpt-4o' });
    expect(ceiling.outputTokens).toBe(300);
    expect(ceiling.inputTokens).toBeLessThan(inputTokenBound(call) / 3);
  });

  it('covers every word the provider reads, so the count is never below the text alone', () => {
    const ceiling = ceilingFor({ ...call, providerKind: 'openai_hosted', modelId: 'gpt-4o' });
    expect(ceiling.inputTokens).toBeGreaterThan(o200k(ENGLISH));
  });
});
