import { describe, expect, it } from 'vitest';
import { HOSTED_PROVIDER_KINDS, MODEL_PURPOSES, PROVIDER_KINDS } from './ai';
import {
  isRerankOnlyKind,
  kindServesPurpose,
  modelKeyShapeHolds,
  parseBedrockCredential,
  validModelId,
} from './ai-providers';

// Built at run time, so no file holds anything shaped like a real key.
const keyId = (prefix: 'AKIA' | 'ASIA') => `${prefix}${'TESTONLY'}${'00000000'}`;
const secret = 'T'.repeat(20) + 'e/s+t'.repeat(4);
const token = 'U2Vzc2lvblRva2VuRm9yVGVzdHM='.repeat(4);
const pair = (fields: Record<string, unknown>) => JSON.stringify(fields);

describe('provider kinds', () => {
  it('every new kind sends to a provider of its own, so it needs the review interlock', () => {
    for (const kind of [
      'gemini_hosted',
      'azure_openai',
      'bedrock_hosted',
      'cohere_hosted',
      'voyage_hosted',
    ] as const) {
      expect(PROVIDER_KINDS).toContain(kind);
      expect(HOSTED_PROVIDER_KINDS).toContain(kind);
    }
  });

  it('a rerank-only kind serves rerank and nothing else', () => {
    for (const kind of ['cohere_hosted', 'voyage_hosted'] as const) {
      expect(isRerankOnlyKind(kind)).toBe(true);
      for (const purpose of MODEL_PURPOSES) {
        expect(kindServesPurpose(kind, purpose)).toBe(purpose === 'rerank');
      }
    }
  });

  it('only kinds with an embedding endpoint here serve embed', () => {
    const embeds = PROVIDER_KINDS.filter((kind) => kindServesPurpose(kind, 'embed'));
    expect(embeds.sort()).toEqual(
      ['gemini_hosted', 'local_openai_compatible', 'openai_compatible', 'openai_hosted'].sort(),
    );
    expect(kindServesPurpose('azure_openai', 'reason')).toBe(true);
    expect(kindServesPurpose('bedrock_hosted', 'rerank')).toBe(true);
  });
});

describe('model IDs', () => {
  it('takes the shapes each provider documents', () => {
    expect(validModelId('gemini_hosted', 'gemini-2.5-flash')).toBe(true);
    expect(validModelId('gemini_hosted', 'gemini-embedding-001')).toBe(true);
    expect(validModelId('azure_openai', 'my-gpt-4.1_deployment')).toBe(true);
    expect(validModelId('bedrock_hosted', 'anthropic.claude-3-5-sonnet-20240620-v1:0')).toBe(true);
    expect(validModelId('bedrock_hosted', 'us.amazon.nova-pro-v1:0')).toBe(true);
    expect(validModelId('cohere_hosted', 'rerank-v3.5')).toBe(true);
    expect(validModelId('voyage_hosted', 'rerank-2.5-lite')).toBe(true);
    expect(validModelId('openai_compatible', 'org/Model Name')).toBe(true);
  });

  it.each([
    ['gemini_hosted', 'tunedModels/someone-elses'],
    ['gemini_hosted', '../files/x'],
    ['gemini_hosted', 'gemini%2F..'],
    ['gemini_hosted', 'Gemini-Pro'],
    ['gemini_hosted', 'gemini:generateContent'],
    ['azure_openai', '..'],
    ['azure_openai', '.hidden'],
    ['azure_openai', 'dep/../../other'],
    ['azure_openai', 'dep?api-version=1'],
    ['azure_openai', 'dep#x'],
    ['azure_openai', 'dep name'],
    ['azure_openai', 'd'.repeat(65)],
    ['bedrock_hosted', 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/x'],
    ['bedrock_hosted', 'model/../converse'],
    ['bedrock_hosted', 'model:a:b:c'],
    ['cohere_hosted', 'rerank v3'],
    ['voyage_hosted', ''],
    ['openai_compatible', ' padded '],
  ] as const)('refuses %s model ID %j', (kind, id) => {
    expect(validModelId(kind, id)).toBe(false);
  });
});

describe('Bedrock credentials', () => {
  it('takes a long-term key pair, a temporary one with its token, or an API key', () => {
    expect(
      parseBedrockCredential(pair({ accessKeyId: keyId('AKIA'), secretAccessKey: secret })),
    ).toEqual({
      kind: 'sigv4',
      accessKeyId: keyId('AKIA'),
      secretAccessKey: secret,
      sessionToken: null,
    });
    expect(
      parseBedrockCredential(
        pair({ accessKeyId: keyId('ASIA'), secretAccessKey: secret, sessionToken: token }),
      ),
    ).toMatchObject({ kind: 'sigv4', sessionToken: token });
    expect(
      parseBedrockCredential(pair({ apiKey: 'ABSK' + 'QmVkcm9ja0FQSUtleQ=='.repeat(3) })),
    ).toMatchObject({ kind: 'api_key' });
  });

  it.each([
    ['not JSON', 'AKIA-and-a-secret'],
    ['an array', '[]'],
    ['null', 'null'],
    ['a string', '"key"'],
    ['an extra field', pair({ accessKeyId: keyId('AKIA'), secretAccessKey: secret, region: 'x' })],
    ['a missing secret', pair({ accessKeyId: keyId('AKIA') })],
    [
      'both shapes at once',
      pair({ accessKeyId: keyId('AKIA'), secretAccessKey: secret, apiKey: 'a'.repeat(20) }),
    ],
    [
      'a temporary key with no token',
      pair({ accessKeyId: keyId('ASIA'), secretAccessKey: secret }),
    ],
    [
      'a long-term key with a token',
      pair({ accessKeyId: keyId('AKIA'), secretAccessKey: secret, sessionToken: token }),
    ],
    ['a short secret', pair({ accessKeyId: keyId('AKIA'), secretAccessKey: 'short' })],
    [
      'a lowercase key ID',
      pair({ accessKeyId: keyId('AKIA').toLowerCase(), secretAccessKey: secret }),
    ],
    ['a number for the secret', pair({ accessKeyId: keyId('AKIA'), secretAccessKey: 40 })],
    ['a header break in the API key', pair({ apiKey: `${'a'.repeat(20)}\r\nx-evil: 1` })],
    ['a prototype key', '{"__proto__":{"accessKeyId":"x"}}'],
  ])('refuses %s', (_label, text) => {
    expect(parseBedrockCredential(text)).toBeNull();
  });

  it('checks the shape at capture for Bedrock, and only printable text for the other kinds', () => {
    const good = pair({ accessKeyId: keyId('AKIA'), secretAccessKey: secret });
    expect(modelKeyShapeHolds('bedrock_hosted', good)).toBe(true);
    expect(modelKeyShapeHolds('bedrock_hosted', 'a-plain-api-key-value')).toBe(false);
    expect(modelKeyShapeHolds('gemini_hosted', 'a-plain-api-key-value')).toBe(true);
    expect(modelKeyShapeHolds('azure_openai', 'has space')).toBe(false);
    expect(modelKeyShapeHolds('cohere_hosted', '')).toBe(false);
    // Pretty-printed JSON has spaces, which a header cannot carry, so a key is pasted compact.
    expect(modelKeyShapeHolds('bedrock_hosted', JSON.stringify(JSON.parse(good), null, 1))).toBe(
      false,
    );
  });
});
