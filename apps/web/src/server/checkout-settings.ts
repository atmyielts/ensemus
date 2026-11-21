import 'server-only';
import type { CheckoutSettings } from '@ensemus/application/saas/checkout';
import { loadSaasConfig } from '@ensemus/config';
import { loadCheckoutConfig } from '@ensemus/config/checkout';
import { getRuntime } from './runtime';

/** Public configuration only. With billing off, nothing is offered. */
export function checkoutSettings(): CheckoutSettings {
  const saas = loadSaasConfig();
  const config = loadCheckoutConfig();
  if (!saas.billingEnabled)
    return { providers: [], payme: null, click: null, paddle: null, publicUrl: '' };
  return {
    providers: config.providers,
    payme: config.payme,
    click: config.click,
    paddle: config.paddle ? { environment: config.paddle.environment } : null,
    publicUrl: getRuntime().config.publicUrl,
  };
}
