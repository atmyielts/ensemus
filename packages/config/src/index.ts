import { readFileSync } from 'node:fs';
import { z } from 'zod';

export const commercialModes = ['cloud', 'byom', 'sovereign'] as const;
export type CommercialMode = (typeof commercialModes)[number];

/** A config error names the setting, never its value. */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

/**
 * Reads a secret from NAME_FILE (a mounted secret) or NAME. Secrets are read at runtime only, so
 * images never contain them. Files win over plain variables.
 */
export function readSecret(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const file = env[`${name}_FILE`];
  if (file) {
    const value = readFileSync(file, 'utf8').trim();
    if (!value) throw new ConfigError(`${name}_FILE points to an empty file`);
    return value;
  }
  const value = env[name];
  if (!value) throw new ConfigError(`Missing required secret ${name} or ${name}_FILE`);
  return value;
}

const publicUrl = z.url().refine((u) => !u.endsWith('/'), 'must not end with a slash');

const webSchema = z.object({
  ENSEMUS_MODE: z.enum(commercialModes),
  ENSEMUS_PUBLIC_URL: publicUrl,
  ENSEMUS_ALLOW_SIGNUP: z.enum(['true', 'false']).default('false'),
  // Off unless the connector worker is running. Off means no connection can be made, and the webhook
  // address answers as if it does not exist, so nothing waits for a worker that is not there (ADR-027).
  ENSEMUS_CONNECTORS_ENABLED: z.enum(['true', 'false']).default('false'),
});

const uuidValue = z.uuid();
const whole = z.coerce.number().int().positive();

const saasSchema = z
  .object({
    ENSEMUS_MODE: z.enum(commercialModes).optional(),
    // Off unless named. Sovereign can never turn it on: nothing there phones home or bills (ADR-032 D1).
    ENSEMUS_BILLING_ENABLED: z.enum(['true', 'false']).default('false'),
    ENSEMUS_BILLING_ORGANIZATION_ID: uuidValue.optional(),
    ENSEMUS_BILLING_CONNECTION_ID: uuidValue.optional(),
    ENSEMUS_PAYMENT_PROCESSOR: z
      .string()
      .regex(/^[a-z][a-z0-9_]{1,63}$/)
      .optional(),
    // Off unless named, and then a limit is required, since there is no default length (ADR-032 D8).
    ENSEMUS_BREAK_GLASS_ENABLED: z.enum(['true', 'false']).default('false'),
    ENSEMUS_BREAK_GLASS_MAX_MINUTES: whole.optional(),
  })
  .refine((c) => !(c.ENSEMUS_BILLING_ENABLED === 'true' && c.ENSEMUS_MODE === 'sovereign'), {
    path: ['ENSEMUS_BILLING_ENABLED'],
  })
  .refine(
    (c) =>
      c.ENSEMUS_BREAK_GLASS_ENABLED !== 'true' || c.ENSEMUS_BREAK_GLASS_MAX_MINUTES !== undefined,
    { path: ['ENSEMUS_BREAK_GLASS_MAX_MINUTES'] },
  );

/** The hosted service's settings, for the web tier and the workers alike (ADR-032). */
export function loadSaasConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = saasSchema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new ConfigError(`Invalid hosted service configuration: ${fields}`);
  }
  const c = parsed.data;
  return {
    billingEnabled: c.ENSEMUS_BILLING_ENABLED === 'true',
    billingOrganizationId: c.ENSEMUS_BILLING_ORGANIZATION_ID ?? null,
    billingConnectionId: c.ENSEMUS_BILLING_CONNECTION_ID ?? null,
    paymentProcessor: c.ENSEMUS_PAYMENT_PROCESSOR ?? null,
    breakGlass:
      c.ENSEMUS_BREAK_GLASS_ENABLED === 'true' && c.ENSEMUS_BREAK_GLASS_MAX_MINUTES !== undefined
        ? { enabled: true as const, maxMinutes: c.ENSEMUS_BREAK_GLASS_MAX_MINUTES }
        : { enabled: false as const },
  };
}

export function loadWebConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = webSchema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new ConfigError(`Invalid web configuration: ${fields}`);
  }
  return {
    mode: parsed.data.ENSEMUS_MODE,
    publicUrl: parsed.data.ENSEMUS_PUBLIC_URL,
    allowSignup: parsed.data.ENSEMUS_ALLOW_SIGNUP === 'true',
    connectorsEnabled: parsed.data.ENSEMUS_CONNECTORS_ENABLED === 'true',
  };
}
