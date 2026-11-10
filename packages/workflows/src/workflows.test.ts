// ADR-024 D2: free text cannot enter a workflow payload, and encrypted payloads stay unreadable.
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AesGcmPayloadCodec } from './codec';
import { probeInputSchema } from './schemas';

const key = randomBytes(32).toString('base64');
const CANARY = 'CANARY-should-never-be-readable';
const payload = {
  metadata: { encoding: new TextEncoder().encode('json/plain') },
  data: new TextEncoder().encode(JSON.stringify({ secret: CANARY })),
};

describe('workflow input', () => {
  it('accepts IDs', () => {
    expect(probeInputSchema.safeParse({ probeId: randomUUID() }).success).toBe(true);
  });

  it.each([
    ['free text in an ID field', { probeId: CANARY }],
    ['an extra field', { probeId: randomUUID(), note: CANARY }],
  ])('rejects %s', (_label, input) => {
    expect(probeInputSchema.safeParse(input).success).toBe(false);
  });
});

describe('payload codec', () => {
  const codec = new AesGcmPayloadCodec(key);

  it('round-trips', async () => {
    const [encoded] = await codec.encode([payload]);
    const [decoded] = await codec.decode([encoded!]);
    expect(new TextDecoder().decode(decoded!.data!)).toContain(CANARY);
  });

  it('hides the content', async () => {
    const [encoded] = await codec.encode([payload]);
    expect(Buffer.from(encoded!.data!).toString('latin1')).not.toContain(CANARY);
  });

  it('rejects tampering', async () => {
    const [encoded] = await codec.encode([payload]);
    encoded!.data![20]! ^= 0xff;
    await expect(codec.decode([encoded!])).rejects.toThrow();
  });

  it('cannot be read with another key', async () => {
    const [encoded] = await codec.encode([payload]);
    const other = new AesGcmPayloadCodec(randomBytes(32).toString('base64'));
    await expect(other.decode([encoded!])).rejects.toThrow();
  });

  it('refuses a key of the wrong size', () => {
    expect(() => new AesGcmPayloadCodec('c2hvcnQ=')).toThrow(/32 bytes/);
  });
});
