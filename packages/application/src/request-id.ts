import { createHash } from 'node:crypto';
import { canonicalId } from './ids';

/**
 * The ID something gets from one rendered form. Only this person and this form can arrive at it, so
 * nobody else can aim at a row. It also depends on what was sent: the same form sent twice leads to the
 * same row and creates nothing, and the same form sent with other content is someone who went back and
 * changed it, so that makes a row of its own and what they typed is never dropped.
 */
export function idFromRequest(
  kind: string,
  membershipId: string,
  requestKey: string,
  content: unknown,
) {
  const hex = createHash('sha256')
    .update(JSON.stringify([kind, membershipId, canonicalId(requestKey), content]))
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
