// What each provider kind can be asked to do, and what its model IDs and keys may look like (ADR-028
// FD-10, FD-11). Pure and with no imports beyond ./ai, so the web tier refuses at the form what the worker
// would refuse at the call, by the same rule.
import type { ModelPurpose, ProviderKind } from './ai';

/**
 * Kinds that speak only a native `/rerank` here. They never take a chat or an embedding call, so a profile
 * of one may be for `rerank` and nothing else.
 */
export const RERANK_ONLY_KINDS: readonly ProviderKind[] = ['cohere_hosted', 'voyage_hosted'];

export function isRerankOnlyKind(kind: ProviderKind): boolean {
  return RERANK_ONLY_KINDS.includes(kind);
}

/** Kinds with an embedding endpoint the embedding adapter speaks. Every other kind refuses `embed`. */
const EMBEDDING_KINDS: readonly ProviderKind[] = [
  'openai_hosted',
  'openai_compatible',
  'local_openai_compatible',
  'gemini_hosted',
];

export function kindServesPurpose(kind: ProviderKind, purpose: ModelPurpose): boolean {
  if (isRerankOnlyKind(kind)) return purpose === 'rerank';
  if (purpose === 'embed') return EMBEDDING_KINDS.includes(kind);
  return true;
}

/**
 * Model IDs that end up in a request path, or that name a provider's own catalogue, have a fixed shape.
 * Gemini puts the ID into the path as `models/<id>` and passes one with a slash through as a whole path,
 * and the Azure package puts a deployment name into the path without encoding it. So no slash, no percent
 * sign and no dot segment: each ID starts with a letter or digit. Bedrock's has an optional `:version`
 * suffix, and an ARN is refused, since it can name another account's resource. Other kinds keep the
 * contract's length rule alone, because their ID only ever goes into a JSON body.
 */
const MODEL_ID_RULES: Partial<Record<ProviderKind, RegExp>> = {
  gemini_hosted: /^[a-z0-9][a-z0-9.-]{0,127}$/,
  azure_openai: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
  bedrock_hosted: /^[a-z0-9][a-z0-9._-]{0,127}(?::[a-z0-9]{1,16}){0,2}$/,
  cohere_hosted: /^[a-z0-9][a-z0-9.-]{0,127}$/,
  voyage_hosted: /^[a-z0-9][a-z0-9.-]{0,127}$/,
};

export function validModelId(kind: ProviderKind, modelId: string): boolean {
  if (typeof modelId !== 'string' || !modelId || modelId.length > 200) return false;
  const rule = MODEL_ID_RULES[kind];
  return rule ? rule.test(modelId) : modelId.trim() === modelId;
}

/**
 * A Bedrock key is either an IAM access key pair, which signs each request (SigV4), or a Bedrock API key,
 * which goes in a bearer header. Either one is sealed as compact JSON, in exactly one of these shapes.
 */
export type BedrockCredential =
  | { kind: 'sigv4'; accessKeyId: string; secretAccessKey: string; sessionToken: string | null }
  | { kind: 'api_key'; apiKey: string };

/** AKIA is a long-term key and ASIA a temporary one, which only works with its session token. */
const ACCESS_KEY_ID = /^(AKIA|ASIA)[A-Z0-9]{16}$/;
const SECRET_ACCESS_KEY = /^[A-Za-z0-9/+]{40}$/;
const SESSION_TOKEN = /^[A-Za-z0-9/+=]{16,6000}$/;
const BEDROCK_API_KEY = /^[A-Za-z0-9+/=._-]{16,6000}$/;

/**
 * Null for anything but one of the two shapes, exactly: no extra field, no wrong type, nothing a header
 * could not carry. Nothing about the text is ever reported, since it is a key.
 */
export function parseBedrockCredential(text: string): BedrockCredential | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  const keys = Object.keys(fields).sort().join(',');
  if (keys === 'apiKey') {
    return typeof fields.apiKey === 'string' && BEDROCK_API_KEY.test(fields.apiKey)
      ? { kind: 'api_key', apiKey: fields.apiKey }
      : null;
  }
  if (
    keys !== 'accessKeyId,secretAccessKey' &&
    keys !== 'accessKeyId,secretAccessKey,sessionToken'
  ) {
    return null;
  }
  const { accessKeyId, secretAccessKey, sessionToken } = fields;
  if (
    typeof accessKeyId !== 'string' ||
    typeof secretAccessKey !== 'string' ||
    !ACCESS_KEY_ID.test(accessKeyId) ||
    !SECRET_ACCESS_KEY.test(secretAccessKey)
  ) {
    return null;
  }
  const temporary = accessKeyId.startsWith('ASIA');
  if (sessionToken === undefined) {
    return temporary ? null : { kind: 'sigv4', accessKeyId, secretAccessKey, sessionToken: null };
  }
  if (!temporary || typeof sessionToken !== 'string' || !SESSION_TOKEN.test(sessionToken)) {
    return null;
  }
  return { kind: 'sigv4', accessKeyId, secretAccessKey, sessionToken };
}

/** What may be sealed as a key for a kind. A header value is printable ASCII with no spaces. */
export function modelKeyShapeHolds(kind: ProviderKind, text: string): boolean {
  if (typeof text !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(text)) return false;
  return kind === 'bedrock_hosted' ? parseBedrockCredential(text) !== null : true;
}
