// Hosted checkout settings (ADR-032 D4a). Plain configuration for the web tier and the connector worker:
// which providers this server offers, their environment and their public merchant identifiers. Keys are
// never here: they are mounted secret files the connector worker or the setup command reads. Off unless
// named, and never with billing off or in Sovereign, where nothing bills or phones home.
import { z } from 'zod';
import { ConfigError } from './index';

const PROVIDERS = ['paddle', 'payme', 'click'] as const;
type Provider = (typeof PROVIDERS)[number];
const environment = z.enum(['sandbox', 'live']);

const schema = z
  .object({
    ENSEMUS_MODE: z.string().optional(),
    ENSEMUS_BILLING_ENABLED: z.enum(['true', 'false']).default('false'),
    ENSEMUS_CHECKOUT_PROVIDERS: z
      .string()
      .regex(/^((paddle|payme|click)(,(paddle|payme|click)){0,2})?$/)
      .default(''),
    ENSEMUS_PAYME_ENVIRONMENT: environment.optional(),
    ENSEMUS_PAYME_MERCHANT_ID: z
      .string()
      .regex(/^[A-Za-z0-9]{1,64}$/)
      .optional(),
    ENSEMUS_CLICK_ENVIRONMENT: environment.optional(),
    ENSEMUS_CLICK_SERVICE_ID: z
      .string()
      .regex(/^[0-9]{1,20}$/)
      .optional(),
    ENSEMUS_CLICK_MERCHANT_ID: z
      .string()
      .regex(/^[0-9]{1,20}$/)
      .optional(),
    ENSEMUS_PADDLE_ENVIRONMENT: environment.optional(),
    // Paddle's tax category for what Ensemus sells. A tax decision, so there is no default.
    ENSEMUS_PADDLE_TAX_CATEGORY: z
      .string()
      .regex(/^[a-z][a-z-]{1,62}$/)
      .optional(),
    // How long the web tier waits for the connector worker's answer to Payme or Click. A technical
    // bound on one request, not a commitment to anyone; neither provider publishes its own limit.
    ENSEMUS_CHECKOUT_REPLY_WAIT_MS: z.coerce.number().int().min(1000).max(25000).default(8000),
  })
  .superRefine((c, issues) => {
    const named = new Set(
      c.ENSEMUS_CHECKOUT_PROVIDERS ? c.ENSEMUS_CHECKOUT_PROVIDERS.split(',') : [],
    );
    if (
      named.size !==
      (c.ENSEMUS_CHECKOUT_PROVIDERS ? c.ENSEMUS_CHECKOUT_PROVIDERS.split(',').length : 0)
    )
      issues.addIssue({
        code: 'custom',
        path: ['ENSEMUS_CHECKOUT_PROVIDERS'],
        message: 'repeated',
      });
    if (!named.size) return;
    if (c.ENSEMUS_BILLING_ENABLED !== 'true' || c.ENSEMUS_MODE === 'sovereign')
      issues.addIssue({
        code: 'custom',
        path: ['ENSEMUS_CHECKOUT_PROVIDERS'],
        message: 'billing off',
      });
    const need = (provider: Provider, keys: (keyof typeof c)[]) => {
      if (!named.has(provider)) return;
      for (const key of keys)
        if (c[key] === undefined)
          issues.addIssue({ code: 'custom', path: [key], message: 'required' });
    };
    need('payme', ['ENSEMUS_PAYME_ENVIRONMENT', 'ENSEMUS_PAYME_MERCHANT_ID']);
    need('click', [
      'ENSEMUS_CLICK_ENVIRONMENT',
      'ENSEMUS_CLICK_SERVICE_ID',
      'ENSEMUS_CLICK_MERCHANT_ID',
    ]);
    need('paddle', ['ENSEMUS_PADDLE_ENVIRONMENT', 'ENSEMUS_PADDLE_TAX_CATEGORY']);
  });

export type CheckoutConfig = {
  providers: readonly Provider[];
  replyWaitMs: number;
  payme: { environment: 'sandbox' | 'live'; merchantId: string } | null;
  click: { environment: 'sandbox' | 'live'; serviceId: string; merchantId: string } | null;
  paddle: { environment: 'sandbox' | 'live'; taxCategory: string } | null;
};

/** Names the setting that is wrong, never its value. */
export function loadCheckoutConfig(env: NodeJS.ProcessEnv = process.env): CheckoutConfig {
  // Compose passes an unset setting as an empty string, which means the same as leaving it out.
  const parsed = schema.safeParse(
    Object.fromEntries(Object.entries(env).filter(([, value]) => value !== '')),
  );
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new ConfigError(`Invalid checkout configuration: ${fields}`);
  }
  const c = parsed.data;
  const providers = PROVIDERS.filter((p) => c.ENSEMUS_CHECKOUT_PROVIDERS.split(',').includes(p));
  return {
    providers,
    replyWaitMs: c.ENSEMUS_CHECKOUT_REPLY_WAIT_MS,
    payme: providers.includes('payme')
      ? { environment: c.ENSEMUS_PAYME_ENVIRONMENT!, merchantId: c.ENSEMUS_PAYME_MERCHANT_ID! }
      : null,
    click: providers.includes('click')
      ? {
          environment: c.ENSEMUS_CLICK_ENVIRONMENT!,
          serviceId: c.ENSEMUS_CLICK_SERVICE_ID!,
          merchantId: c.ENSEMUS_CLICK_MERCHANT_ID!,
        }
      : null,
    paddle: providers.includes('paddle')
      ? { environment: c.ENSEMUS_PADDLE_ENVIRONMENT!, taxCategory: c.ENSEMUS_PADDLE_TAX_CATEGORY! }
      : null,
  };
}
