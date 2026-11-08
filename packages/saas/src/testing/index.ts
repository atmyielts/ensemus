// Test doubles, and never anything else. Lint keeps this out of apps/ and workers/, and no shipped code
// path can reach it. Generated test values only: nothing here looks like a real processor or provider.
// Owned by the payments slice (the processor) and the invoicing slice (the tax port). Implementations go in
// ./fake-processor.ts and ./fake-tax.ts, which this re-exports.
export { createFakePaymentProcessor, type FakeProcessorScript } from './fake-processor';
export { createFakeTaxPort, type FakeTaxScript } from './fake-tax';
