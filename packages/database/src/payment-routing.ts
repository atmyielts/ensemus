// For workers only (lint blocks the web tier). Finds a tenant from a hash of its processor reference, which is
// the only way a processor's event ever reaches a tenant (ADR-032 D4).
export { withPaymentCustomerTx } from './tenant';
