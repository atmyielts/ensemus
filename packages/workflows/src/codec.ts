// ADR-024 D2: the second layer. Payloads should only hold IDs, and this encrypts them anyway, so a
// mistake in one field still does not reach Temporal's persistence in readable form.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Payload, PayloadCodec } from '@temporalio/common';
import proto from '@temporalio/proto';

const { temporal } = proto;
const ENCODING = 'binary/encrypted';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

export class AesGcmPayloadCodec implements PayloadCodec {
  readonly #key: Buffer;

  constructor(base64Key: string) {
    this.#key = Buffer.from(base64Key, 'base64');
    if (this.#key.length !== 32) throw new Error('Temporal codec key must be 32 bytes');
  }

  async encode(payloads: Payload[]): Promise<Payload[]> {
    return payloads.map((payload) => {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
      const plain = temporal.api.common.v1.Payload.encode(payload).finish();
      const body = Buffer.concat([cipher.update(plain), cipher.final()]);
      return {
        metadata: { encoding: utf8.encode(ENCODING) },
        data: Buffer.concat([iv, cipher.getAuthTag(), body]),
      };
    });
  }

  async decode(payloads: Payload[]): Promise<Payload[]> {
    return payloads.map((payload) => {
      const encoding = payload.metadata?.encoding;
      if (!encoding || fromUtf8.decode(encoding) !== ENCODING) return payload;
      if (!payload.data) throw new Error('Encrypted payload has no data');
      const data = Buffer.from(payload.data);
      const decipher = createDecipheriv('aes-256-gcm', this.#key, data.subarray(0, IV_BYTES));
      decipher.setAuthTag(data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      const plain = Buffer.concat([
        decipher.update(data.subarray(IV_BYTES + TAG_BYTES)),
        decipher.final(),
      ]);
      return temporal.api.common.v1.Payload.decode(plain) as Payload;
    });
  }
}
