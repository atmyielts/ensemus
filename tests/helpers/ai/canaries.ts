// Canaries, built at runtime, so nothing that looks like a key is ever committed and secret scanners and
// push protection stay quiet. Each one is unique to its call. A test plants one, then searches every
// surface for it. None has a real provider's prefix: the shapes the scan knows are assembled from parts.
import { randomBytes } from 'node:crypto';

const noise = (bytes = 24) => randomBytes(bytes).toString('hex');

/** A tenant canary: a marker registered with the scan, which matches nothing else. */
export const tenantCanary = () => `canary-${noise(16)}`;

/** A throwaway key for a fake model. It unlocks nothing. */
export const throwawayModelKey = () => `test-key-${noise()}`;

/** Key-shaped text for the scan's tests, assembled so the source holds no matching literal. */
export const keyShapedText = () => ['s', 'k', '-', noise()].join('');

/** A PEM block's shape, likewise, with a body that decodes to nothing. */
export function pemShapedText(): string {
  const dashes = '-'.repeat(5);
  const label = ['PRIVATE', 'KEY'].join(' ');
  const body = randomBytes(48).toString('base64');
  return `${dashes}BEGIN ${label}${dashes}\n${body}\n${dashes}END ${label}${dashes}`;
}

/** Whether a dump, a body or a log holds this canary, however it was escaped along the way. */
export function holdsCanary(haystack: string, canary: string): boolean {
  return haystack.includes(canary) || haystack.includes(JSON.stringify(canary).slice(1, -1));
}
