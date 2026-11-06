import { FACT_STATES, GRAPH_NODE_TYPES } from '@ensemus/domain/knowledge';
import { AppError } from '../errors';
import { idSchema } from '../ids';

export function factSubject(value: string): { type: string; id: string; ref: string } {
  if (typeof value !== 'string' || value.length > 80) throw new AppError('INVALID_INPUT');
  const [type, rawId, extra] = value.split(':');
  const parsed = idSchema.safeParse(rawId);
  if (
    extra !== undefined ||
    !type ||
    !(GRAPH_NODE_TYPES as readonly string[]).includes(type) ||
    !parsed.success
  )
    throw new AppError('INVALID_INPUT');
  return { type, id: parsed.data, ref: `${type}:${parsed.data}` };
}

export function factClaim(value: unknown): unknown {
  try {
    const encoded = JSON.stringify(value, (_key, part: unknown) => {
      if (
        ['undefined', 'function', 'symbol', 'bigint'].includes(typeof part) ||
        (typeof part === 'number' && !Number.isFinite(part))
      )
        throw new Error('INVALID_CLAIM');
      return part;
    });
    if (!encoded || Buffer.byteLength(encoded) > 16_000 || encoded.includes('\\u0000'))
      throw new Error('INVALID_CLAIM');
    return JSON.parse(encoded) as unknown;
  } catch {
    throw new AppError('INVALID_INPUT');
  }
}

export function factReason(value: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new AppError('REASON_REQUIRED');
  if (value.length > 2000 || value.includes('\0')) throw new AppError('INVALID_INPUT');
  return value.trim();
}

export function factPage(input: { after?: string; limit?: number; trustState?: string }) {
  const limit = input.limit ?? 25;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50 ||
    (input.trustState !== undefined &&
      !(FACT_STATES as readonly string[]).includes(input.trustState))
  )
    throw new AppError('INVALID_INPUT');
  if (!input.after) return { limit, after: null };
  if (input.after.length > 512) throw new AppError('INVALID_INPUT');
  try {
    const decoded = JSON.parse(Buffer.from(input.after, 'base64url').toString('utf8')) as unknown;
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 2 ||
      typeof decoded[0] !== 'string' ||
      !Number.isFinite(Date.parse(decoded[0]))
    )
      throw new Error('INVALID_CURSOR');
    const id = idSchema.parse(decoded[1]);
    return { limit, after: { at: new Date(decoded[0]), id } };
  } catch {
    throw new AppError('INVALID_INPUT');
  }
}
