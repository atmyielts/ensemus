// Owned by the transport slice (SEC-11). What an endpoint may look like, before any DNS or socket, so the
// web tier can refuse a bad address at the form and the worker can refuse it again (ADR-028 FD-10).
import type { ProviderKind } from '@ensemus/domain/ai';

/** An operator's setting, read by the caller. Tenants can never add to it. */
export type EndpointSettings = {
  /** From `ENSEMUS_PRIVATE_MODEL_ENDPOINTS`. Origins that may be private or plain HTTP. */
  privateEndpoints: readonly string[];
};

export type EndpointCheck =
  | { ok: true; host: string; port: number; viaPrivateAllowlist: boolean }
  | { ok: false; code: 'MODEL_ENDPOINT_NOT_ALLOWED' };

/**
 * Hosted kinds have a fixed host list in code. `openai_compatible` needs an HTTPS public address, and
 * `local_openai_compatible` must be on the operator's list. This stub refuses every address.
 */
export function checkEndpoint(
  _kind: ProviderKind,
  _endpointUrl: string,
  _settings: EndpointSettings,
): EndpointCheck {
  return { ok: false, code: 'MODEL_ENDPOINT_NOT_ALLOWED' };
}
