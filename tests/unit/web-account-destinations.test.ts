import { describe, it, expect } from 'vitest';
import { accountDestinations } from '../../apps/web/src/lib/account-destinations';
import { ACCOUNT_REASON_CHOICES } from '../../apps/web/src/lib/account-reasons';
import { cancelOffboardingSchema,releaseLegalHoldSchema } from '@ensemus/contracts/saas';
const org = '00000000-0000-4000-8000-000000000001';
describe('real account destinations', () => {
  it('offers only reachable owner account routes, including leave and the actual export page', () => {
    expect(accountDestinations(org, 'owner').map((item) => item.href)).toEqual(
      ['billing', 'support', 'exports', 'retention', 'legal-holds', 'leave'].map((path) => `/o/${org}/account/${path}`),
    );
    expect(
      accountDestinations(org, 'owner').some((item) => item.href.endsWith('/offboarding')),
    ).toBe(false);
  });
  it('does not advertise owner-only export/leaving to administrators or members', () => {
    expect(accountDestinations(org, 'admin').map((item) => item.label)).toEqual([
      'Billing and subscription',
      'Support',
      'Data retention',
    ]);
    expect(accountDestinations(org, 'member').map((item) => item.label)).toEqual(['Support']);
  });
  it('defaults unknown roles to no account controls instead of granting account administration', () => {
    expect(accountDestinations(org, 'invented-admin')).toEqual([]);
  });
  it('uses existing valid customer-request audit codes for the plain-language choices',()=>{
    for(const choice of ACCOUNT_REASON_CHOICES.cancel_offboarding) {
      expect(cancelOffboardingSchema.safeParse({reason_code:choice.code}).success).toBe(true);
      expect(choice.code).toBe('CUSTOMER_REQUEST');
    }
    for(const choice of ACCOUNT_REASON_CHOICES.release_hold) {
      expect(releaseLegalHoldSchema.safeParse({reason_code:choice.code}).success).toBe(true);
      expect(choice.code).toBe('CUSTOMER_REQUEST');
    }
    expect(cancelOffboardingSchema.safeParse({reason_code:''}).success).toBe(false);
    expect(releaseLegalHoldSchema.safeParse({reason_code:''}).success).toBe(false);
  });
});
