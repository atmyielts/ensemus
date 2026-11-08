import { describe, expect, it } from 'vitest';
import { paymentExecutionIdentity } from './payment';
const manifest = { processor: 'test_scripted', version: '1.0.0' };
const identity = { version: 'ensemus.payment-execution/v1', processor: manifest.processor, adapterVersion: manifest.version,
  environment: 'generated_test', merchantAccountSha256: 'a'.repeat(64), apiOrigins: ['https://generated.mcp.invalid'] };
describe('stable observed merchant namespace versus original execution identity', () => {
  it('keeps the merchant/environment event namespace across adapter and endpoint rotation', () => {
    const first = paymentExecutionIdentity(identity, manifest);
    const next = paymentExecutionIdentity({ ...identity, adapterVersion: '2.0.0', apiOrigins: ['https://rotated.example.invalid'] }, { ...manifest, version: '2.0.0' });
    expect(first).not.toBeNull(); expect(next).not.toBeNull();
    expect(next?.sha256).not.toBe(first?.sha256);
    expect(next?.accountNamespaceSha256).toBe(first?.accountNamespaceSha256);
  });
  it.each([
    { merchantAccountSha256: 'b'.repeat(64) }, { environment: 'different_generated_environment' },
  ])('does not merge distinct merchant/environment namespaces: %j', (change) => {
    expect(paymentExecutionIdentity({ ...identity, ...change }, manifest)?.accountNamespaceSha256)
      .not.toBe(paymentExecutionIdentity(identity,manifest)?.accountNamespaceSha256);
  });
  it('separates another processor even with otherwise identical observed account facts', () => {
    const other = paymentExecutionIdentity({ ...identity, processor: 'another_test' }, { ...manifest, processor: 'another_test' });
    expect(other?.accountNamespaceSha256).not.toBe(paymentExecutionIdentity(identity,manifest)?.accountNamespaceSha256);
  });
  it.each([
    { ...identity, environment: '' }, { ...identity, merchantAccountSha256: 'unverified label' },
    { ...identity, apiOrigins: ['http://generated.mcp.invalid'] }, { ...identity, extra: 'caller namespace' },
  ])('rejects unsupported/malformed descriptors before they are treated as an identity %j', (value) => {
    expect(paymentExecutionIdentity(value,manifest)).toBeNull();
  });
});
