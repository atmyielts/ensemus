// Generated factors only. This implementation is test-side RFC6238/HMAC-SHA1, not shipped auth code.
import { createHmac } from 'node:crypto';
export function totpCode(secret: string, now = Date.now()) {
  let bits = '';
  for (const letter of secret.toUpperCase().replaceAll('=', '')) {
    const value = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(letter);
    if (value < 0) throw new Error('TEST_TOTP_SECRET_INVALID');
    bits += value.toString(2).padStart(5, '0');
  }
  const key = Buffer.from(
    Array.from({ length: Math.floor(bits.length / 8) }, (_, index) =>
      Number.parseInt(bits.slice(index * 8, index * 8 + 8), 2),
    ),
  );
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30000)));
  const digest = createHmac('sha1', key).update(counter).digest(),
    offset = digest[digest.length - 1]! & 15;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
}
export function totpFromUri(uri: string, now = Date.now()) {
  const secret = new URL(uri).searchParams.get('secret');
  if (!secret) throw new Error('TEST_TOTP_URI_INVALID');
  return totpCode(secret, now);
}

/** Positive fixtures sometimes need the previous code so the next real challenge uses a different
 * code. Do not start that HTTP verification at its final boundary: it could become two periods old
 * while the real server checks it. Wait for the actual clock; no auth time/state is overridden. */
export async function previousTotpFromUri(uri: string) {
  const remaining = 30000 - (Date.now() % 30000);
  if (remaining < 5000) await new Promise<void>((resolve) => setTimeout(resolve, remaining + 50));
  return totpFromUri(uri, Date.now() - 30000);
}
