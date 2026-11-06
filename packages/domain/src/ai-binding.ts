// How a model key is bound to the endpoint it may go to (ADR-028 FD-10). It is apart from ai.ts because
// it needs node:crypto, and workflow code imports ai.ts.
import { createHash } from 'node:crypto';

/** The endpoint's digest: scheme, host, port and path, lowercased and with no trailing slash. */
export function endpointDigest(endpointUrl: string): string {
  const url = new URL(endpointUrl);
  const path = url.pathname.replace(/\/+$/, '');
  const canonical = `${url.protocol}//${url.host}${path}`.toLowerCase();
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * A sealed model key's `purpose`, which is inside the AES-GCM additional data. So a key sealed for one
 * profile and endpoint fails authentication under any other, whatever a tampered row says. Web uses
 * this when sealing and the worker when opening, so SecretBroker needs no change.
 */
export function modelKeyPurpose(profileId: string, endpointUrl: string): string {
  return `model_key:${profileId.toLowerCase()}:${endpointDigest(endpointUrl)}`;
}

/** SHA-256 of a stored payload, which is what default traces may carry instead of its content. */
export function contentSha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
