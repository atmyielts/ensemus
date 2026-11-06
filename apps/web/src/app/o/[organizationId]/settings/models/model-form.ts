// What the model settings forms send and what the pages call things. Pure, so it runs in a unit test, and
// so nothing here can reach a key: the key field is read in one action and nowhere else.
import type { CreateModelProfile, UpdateModelProfile } from '@ensemus/contracts/ai';
import { z } from 'zod';

export const PROVIDER_LABEL: Record<string, string> = {
  openai_hosted: 'OpenAI',
  anthropic_hosted: 'Anthropic',
  openai_compatible: 'Another provider, on a public address',
  local_openai_compatible: 'A model on your own network',
};

/** What a person sees instead of a status name, and the badge's tone. */
export const STATUS_LOOK: Record<string, { label: string; tone: string }> = {
  draft: { label: 'Not tested yet', tone: '' },
  probing: { label: 'Being tested', tone: 'active' },
  probe_failed: { label: 'Test failed', tone: 'bad' },
  active: { label: 'Active', tone: 'done' },
  disabled: { label: 'Turned off', tone: '' },
};

export const RETENTION_LABEL: Record<string, string> = {
  unreviewed: 'Nobody has reviewed their terms',
  contract_recorded: 'Their terms are recorded',
  self_hosted: 'We run this model ourselves',
};

export const CAPABILITY_LABEL: Record<string, string> = {
  text: 'Text',
  tools: 'Tool calls',
  structured_output: 'Structured output',
  vision: 'Images',
  long_context: 'Long documents',
};

export const CLASS_LABEL: Record<string, string> = {
  public: 'Public',
  internal: 'Internal',
  confidential: 'Confidential',
  restricted: 'Restricted',
};

export const PURPOSE_LABEL: Record<string, string> = {
  classify: 'Sorting',
  extract: 'Pulling out details',
  reason: 'Working things out',
  research: 'Research',
  compose: 'Writing',
};

const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
};
const orNull = (value: string) => (value ? value : null);
const strings = (form: FormData, name: string) =>
  form.getAll(name).filter((value): value is string => typeof value === 'string');

/** The fields the create and edit forms share. Anything malformed is the schema's to refuse. */
function sharedFields(form: FormData) {
  return {
    model_id: text(form, 'modelId'),
    alias: text(form, 'alias'),
    endpoint_url: text(form, 'endpointUrl'),
    region: orNull(text(form, 'region')),
    capabilities: strings(form, 'capabilities'),
    limits: {
      max_input_tokens: Number.parseInt(text(form, 'maxInputTokens'), 10),
      max_output_tokens: Number.parseInt(text(form, 'maxOutputTokens'), 10),
    },
    allowed_classes: strings(form, 'allowedClasses'),
    allowed_purposes: strings(form, 'allowedPurposes'),
    retention_basis: text(form, 'retentionBasis'),
    contract_ref: orNull(text(form, 'contractRef')),
    fallback_profile_ids: strings(form, 'fallback'),
  };
}

/**
 * A new profile, as the service expects it, unchecked. Who pays is not on this form: a key a customer
 * enters here is the customer's, and an Ensemus-managed model is not something a tenant can declare.
 */
export function createInputFromForm(form: FormData): CreateModelProfile {
  return {
    ...sharedFields(form),
    provider_kind: text(form, 'providerKind'),
    billing_owner: 'customer',
  } as CreateModelProfile;
}

/** A change to a profile, unchecked. Sending the endpoint when it did not change voids nothing. */
export function updateInputFromForm(form: FormData): UpdateModelProfile {
  return {
    ...sharedFields(form),
    expected_version: Number.parseInt(text(form, 'version'), 10),
  } as UpdateModelProfile;
}

/**
 * The key, once. No spaces or control characters, because it goes into a request header, and a pasted
 * line break would otherwise be a way to add one. Refusal says nothing about what was sent.
 */
export const modelKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(8192)
  .regex(/^[\x21-\x7e]+$/);

/** The body of the credential route, which takes the key once and answers with the view. */
export const modelCredentialRequestSchema = z.strictObject({
  expected_version: z.int().min(1),
  key: z.string().min(1).max(8192),
});

export const activateRequestSchema = z.strictObject({
  expected_version: z.int().min(1),
});

/** Whole micro-dollars per million tokens, with a decimal dollar figure on the form. */
export function usdPerMtokToMicros(value: string): number | null {
  const figure = value.trim();
  if (!/^\d{1,9}(\.\d{1,6})?$/.test(figure)) return null;
  const [whole = '0', fraction = ''] = figure.split('.');
  return Number(whole) * 1_000_000 + Number(fraction.padEnd(6, '0'));
}

/** The other way, for showing a rate. Never through a float, so it says exactly what was entered. */
export function microsToUsd(micros: number): string {
  const whole = Math.floor(micros / 1_000_000);
  const fraction = String(micros % 1_000_000)
    .padStart(6, '0')
    .replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}
