// One canonical, secret-free-in-output configuration receipt shared by auth and operator review.
// Trust flags, row IDs, timestamps and last-use metadata never change this authentication boundary.
import { createHash } from 'node:crypto';
type Boundary = { providerId: string; issuer: string; domain: string; samlConfig: string | null };
function canonical(value: unknown, depth = 0): string {
  if (depth > 32) throw new Error('SSO_CONFIGURATION_INVALID');
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, depth + 1)).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], depth + 1)}`,
      )
      .join(',')}}`;
  throw new Error('SSO_CONFIGURATION_INVALID');
}
export function ssoConfigurationSha256(provider: Boundary): string {
  if (!provider.samlConfig) throw new Error('SSO_CONFIGURATION_INVALID');
  return createHash('sha256')
    .update(
      canonical({
        providerId: provider.providerId,
        issuer: provider.issuer,
        domain: provider.domain,
        samlConfig: JSON.parse(provider.samlConfig) as unknown,
      }),
    )
    .digest('hex');
}
