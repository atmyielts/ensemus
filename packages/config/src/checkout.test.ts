import { describe, expect, it } from 'vitest';
import { loadCheckoutConfig } from './checkout';
import { ConfigError } from './index';

const on = { ENSEMUS_BILLING_ENABLED: 'true', ENSEMUS_MODE: 'cloud' };

describe('loadCheckoutConfig', () => {
  it('offers nothing unless named', () => {
    expect(loadCheckoutConfig({}).providers).toEqual([]);
    expect(loadCheckoutConfig(on)).toMatchObject({
      providers: [],
      payme: null,
      click: null,
      paddle: null,
    });
  });

  it('needs every public identifier for each provider it names, and no key', () => {
    expect(() => loadCheckoutConfig({ ...on, ENSEMUS_CHECKOUT_PROVIDERS: 'payme' })).toThrow(
      ConfigError,
    );
    const config = loadCheckoutConfig({
      ...on,
      ENSEMUS_CHECKOUT_PROVIDERS: 'payme,click,paddle',
      ENSEMUS_PAYME_ENVIRONMENT: 'sandbox',
      ENSEMUS_PAYME_MERCHANT_ID: 'abc123',
      ENSEMUS_CLICK_ENVIRONMENT: 'sandbox',
      ENSEMUS_CLICK_SERVICE_ID: '11',
      ENSEMUS_CLICK_MERCHANT_ID: '22',
      ENSEMUS_PADDLE_ENVIRONMENT: 'sandbox',
      ENSEMUS_PADDLE_TAX_CATEGORY: 'standard',
    });
    expect(config.providers).toEqual(['paddle', 'payme', 'click']);
    expect(config.paddle).toEqual({ environment: 'sandbox', taxCategory: 'standard' });
  });

  it('refuses checkout with billing off, in Sovereign, or a provider named twice', () => {
    const payme = { ENSEMUS_PAYME_ENVIRONMENT: 'live', ENSEMUS_PAYME_MERCHANT_ID: 'abc' };
    expect(() => loadCheckoutConfig({ ENSEMUS_CHECKOUT_PROVIDERS: 'payme', ...payme })).toThrow(
      ConfigError,
    );
    expect(() =>
      loadCheckoutConfig({
        ...on,
        ENSEMUS_MODE: 'sovereign',
        ENSEMUS_CHECKOUT_PROVIDERS: 'payme',
        ...payme,
      }),
    ).toThrow(ConfigError);
    expect(() =>
      loadCheckoutConfig({ ...on, ENSEMUS_CHECKOUT_PROVIDERS: 'payme,payme', ...payme }),
    ).toThrow(ConfigError);
  });

  it('reads an empty setting as unset, as Compose passes one', () => {
    expect(
      loadCheckoutConfig({ ...on, ENSEMUS_CHECKOUT_PROVIDERS: '', ENSEMUS_PAYME_ENVIRONMENT: '' })
        .providers,
    ).toEqual([]);
  });

  it('names the setting and never its value', () => {
    try {
      loadCheckoutConfig({
        ...on,
        ENSEMUS_CHECKOUT_PROVIDERS: 'click',
        ENSEMUS_CLICK_SERVICE_ID: 'secret-ish',
      });
    } catch (error) {
      expect(String(error)).toContain('ENSEMUS_CLICK_SERVICE_ID');
      expect(String(error)).not.toContain('secret-ish');
    }
  });
});
