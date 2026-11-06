// Decode only this repository's synthetic, public-key corpus. Never use a deployment codec key here.
import { defaultPayloadConverter, type Payload } from '@temporalio/common';
import { AesGcmPayloadCodec } from '@ensemus/workflows/codec';
import { expect } from 'vitest';
import { REPLAY_KEY } from './corpus';

export type JsonPayload = { metadata?: Record<string, string>; data?: string };

export async function decodeCorpusPayload(json: JsonPayload) {
  expect(Buffer.from(json.metadata?.encoding ?? '', 'base64').toString('utf8')).toBe(
    'binary/encrypted',
  );
  const payload: Payload = {
    metadata: Object.fromEntries(
      Object.entries(json.metadata ?? {}).map(([key, value]) => [
        key,
        Buffer.from(value, 'base64'),
      ]),
    ),
    data: Buffer.from(json.data ?? '', 'base64'),
  };
  const [plain] = await new AesGcmPayloadCodec(REPLAY_KEY).decode([payload]);
  if (!plain) throw new Error('Capture payload absent');
  return defaultPayloadConverter.fromPayload(plain);
}
