// Internal handoff from the native auth verifier, never an identity assembled from a request body.
// Only the auth entry point exports its constructor; tenant/application exports expose the type.
const verified: unique symbol = Symbol('NativeVerifiedInteractiveIdentity');
const issued = new WeakSet<object>();
export const interactiveIdentity: unique symbol = Symbol('InteractiveTenantIdentity');
export type VerifiedInteractiveIdentity = Readonly<{
  userId: string;
  sessionId: string;
  [verified]: true;
}>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function createVerifiedInteractiveIdentity(input: {
  userId: string;
  sessionId: string;
}): VerifiedInteractiveIdentity {
  if (!uuid.test(input.userId) || !uuid.test(input.sessionId))
    throw new Error('INVALID_VERIFIED_SESSION_IDENTITY');
  const identity = Object.freeze({
    userId: input.userId.toLowerCase(),
    sessionId: input.sessionId.toLowerCase(),
    [verified]: true as const,
  });
  issued.add(identity);
  return identity;
}
export function isVerifiedInteractiveIdentity(
  value: unknown,
): value is VerifiedInteractiveIdentity {
  return !!value && typeof value === 'object' && issued.has(value);
}
