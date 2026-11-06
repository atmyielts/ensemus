// RFC7643/7644 subset. Pure parsing and bounded, per-replica admission; no database or session.
export const SCIM_USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCIM_PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
export const SCIM_ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';
export const SCIM_LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export function bearer(headers: Headers): string | null {
  const authorization = headers.get('authorization');
  if (!authorization || authorization.length > 256) return null;
  const match = /^Bearer (ens_scim_[A-Za-z0-9_-]{43})$/i.exec(authorization);
  return match?.[1] ?? null;
}
export function listQuery(
  url: URL,
): { startIndex: number; count: number; filterUserName?: string } | null {
  if ([...url.searchParams.keys()].some((key) => !['startIndex', 'count', 'filter'].includes(key)))
    return null;
  if (['startIndex', 'count', 'filter'].some((key) => url.searchParams.getAll(key).length > 1))
    return null;
  const start = url.searchParams.get('startIndex') ?? '1',
    size = url.searchParams.get('count') ?? '100';
  if (!/^[0-9]{1,9}$/.test(start) || !/^[0-9]{1,3}$/.test(size)) return null;
  const startIndex = Number(start),
    count = Number(size);
  if (startIndex < 1 || count > 100) return null;
  const filter = url.searchParams.get('filter');
  if (filter === null) return { startIndex, count };
  if ([...filter].some((character) => character.charCodeAt(0) < 32)) return null;
  const match = /^userName eq "([^"\\\s]{1,320})"$/i.exec(filter);
  if (!match || !/^[^\s@]+@[^\s@]+$/.test(match[1]!)) return null;
  return { startIndex, count, filterUserName: match[1]! };
}
export function patchActive(value: unknown): boolean | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (
    Object.keys(body).some((key) => !['schemas', 'Operations'].includes(key)) ||
    !Array.isArray(body.schemas) ||
    body.schemas.length !== 1 ||
    body.schemas[0] !== SCIM_PATCH ||
    !Array.isArray(body.Operations) ||
    body.Operations.length !== 1
  )
    return null;
  const operation = body.Operations[0] as unknown;
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) return null;
  const op = operation as Record<string, unknown>;
  if (
    Object.keys(op).some((key) => !['op', 'path', 'value'].includes(key)) ||
    typeof op.op !== 'string' ||
    !['replace', 'add'].includes(op.op.toLowerCase())
  )
    return null;
  if (typeof op.path === 'string' && op.path.toLowerCase() === 'active')
    return typeof op.value === 'boolean' ? op.value : null;
  if (op.path !== undefined || !op.value || typeof op.value !== 'object' || Array.isArray(op.value))
    return null;
  const fields = op.value as Record<string, unknown>;
  return Object.keys(fields).length === 1 && typeof fields.active === 'boolean'
    ? fields.active
    : null;
}
export function createScimLimiter(
  options: { max?: number; windowMs?: number; maxKeys?: number } = {},
) {
  const max = options.max ?? 60,
    windowMs = options.windowMs ?? 60000,
    maxKeys = options.maxKeys ?? 10000;
  const windows = new Map<string, { started: number; count: number }>();
  return {
    admit(key: string, now = Date.now()): boolean {
      let entry = windows.get(key);
      if (entry && now < entry.started) return false;
      if (entry && now - entry.started < windowMs) {
        if (entry.count >= max) return false;
        entry.count++;
        return true;
      }
      if (windows.size >= maxKeys) {
        for (const [known, window] of windows)
          if (now - window.started >= windowMs) windows.delete(known);
        if (windows.size >= maxKeys) return false;
      }
      entry = { started: now, count: 1 };
      windows.set(key, entry);
      return true;
    },
    size: () => windows.size,
  };
}
