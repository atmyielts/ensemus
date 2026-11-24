// Hosted checkout (ADR-032 D4a). A customer pays on the provider's own page, and the provider tells us. Two
// providers call us and wait for an answer (Payme, Click); one sends signed webhooks (Paddle). What crosses
// from the connector worker's parser to the rules is only IDs, enums and amounts as strings of digits.

export const CHECKOUT_PROVIDERS = ['paddle', 'payme', 'click'] as const;
export type CheckoutProvider = (typeof CHECKOUT_PROVIDERS)[number];
export const isCheckoutProvider = (value: unknown): value is CheckoutProvider =>
  typeof value === 'string' && (CHECKOUT_PROVIDERS as readonly string[]).includes(value);

/**
 * A connection of this type, in the deployment's own organization, owns a provider's inbound address. It
 * starts with `payment_` so the reviewed payment webhook envelope check (0512) covers it unchanged, and the
 * rest can never equal a charge processor's `payment_<processor>`.
 */
export const CHECKOUT_CONNECTOR_PREFIX = 'payment_checkout_';

/**
 * `opening`: a Paddle transaction is being created. `open`: the customer can pay. `reserved`: the provider
 * started one payment for it and nobody else may. `paid`: the provider took the money. `cancelled`: it can
 * no longer be paid and took nothing. `refunded`: it was paid and the provider gave the money back.
 */
export const CHECKOUT_STATES = [
  'opening',
  'open',
  'reserved',
  'paid',
  'cancelled',
  'refunded',
] as const;
export type CheckoutState = (typeof CHECKOUT_STATES)[number];

export const PAYME_METHODS = [
  'CheckPerformTransaction',
  'CreateTransaction',
  'PerformTransaction',
  'CancelTransaction',
  'CheckTransaction',
  'GetStatement',
] as const;
export type PaymeMethod = (typeof PAYME_METHODS)[number];

/** A JSON-RPC id is echoed back exactly. Bounded so a reply can never grow with it. */
export type JsonRpcId = string | number | null;

/** One verified Payme Merchant API call. Amounts are tiyin as digits. */
export type PaymeCall =
  | {
      provider: 'payme';
      rpcId: JsonRpcId;
      method: 'CheckPerformTransaction';
      amount: string;
      orderRef: string | null;
    }
  | {
      provider: 'payme';
      rpcId: JsonRpcId;
      method: 'CreateTransaction';
      paymeTxnId: string;
      /** Payme's own time for the transaction, in milliseconds. */
      timeMs: string;
      amount: string;
      orderRef: string | null;
    }
  | { provider: 'payme'; rpcId: JsonRpcId; method: 'PerformTransaction'; paymeTxnId: string }
  | {
      provider: 'payme';
      rpcId: JsonRpcId;
      method: 'CancelTransaction';
      paymeTxnId: string;
      reason: number;
    }
  | { provider: 'payme'; rpcId: JsonRpcId; method: 'CheckTransaction'; paymeTxnId: string }
  | { provider: 'payme'; rpcId: JsonRpcId; method: 'GetStatement'; fromMs: string; toMs: string }
  /** Authenticated, but a method this merchant does not offer, or a request that is not valid JSON-RPC. */
  | { provider: 'payme'; rpcId: JsonRpcId; method: 'unsupported' | 'invalid' };

/** One verified Click SHOP API call. `amount` is the exact text Click signed. */
export type ClickCall = {
  provider: 'click';
  action: number;
  clickTransId: string;
  clickPaydocId: string;
  serviceId: string;
  orderRef: string;
  merchantPrepareId: string | null;
  amount: string;
  /** Click's own result for the payment: 0, or a negative code when the customer's payment failed. */
  error: number;
};

export const PADDLE_FACT_KINDS = ['paid', 'cancelled', 'refunded', 'disputed'] as const;
export type PaddleFactKind = (typeof PADDLE_FACT_KINDS)[number];

/** One verified Paddle notification about a transaction. Amounts are the currency's minor unit as digits. */
export type PaddleFact = {
  provider: 'paddle';
  eventId: string;
  kind: PaddleFactKind;
  transactionId: string;
  /** What we put in `custom_data`. Confirmed against our own row, never trusted alone. */
  orderRef: string | null;
  currency: string;
  grandTotalMinor: string;
  taxMinor: string;
  subtotalMinor: string;
  occurredAtSeconds: number;
};

export type CheckoutCallback = PaymeCall | ClickCall | PaddleFact;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Our order reference is the checkout session's ID, lower case, exactly. */
export const isOrderRef = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value);
