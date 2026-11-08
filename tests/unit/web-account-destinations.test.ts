import { describe, it, expect } from 'vitest';
import { accountDestinations } from '../../apps/web/src/lib/account-destinations';
const org = '00000000-0000-4000-8000-000000000001';
describe('real account destinations', () => {
  it('offers only reachable owner account routes, including leave and the actual export page', () => {
    expect(accountDestinations(org, 'owner').map((item) => item.href)).toEqual(
      ['billing', 'support', 'exports', 'leave'].map((path) => `/o/${org}/account/${path}`),
    );
    expect(
      accountDestinations(org, 'owner').some((item) => item.href.endsWith('/offboarding')),
    ).toBe(false);
  });
  it('does not advertise owner-only export/leaving to administrators or members', () => {
    expect(accountDestinations(org, 'admin').map((item) => item.label)).toEqual([
      'Billing and subscription',
      'Support',
    ]);
    expect(accountDestinations(org, 'member').map((item) => item.label)).toEqual(['Support']);
  });
  it('defaults unknown roles to no account controls instead of granting account administration', () => {
    expect(accountDestinations(org, 'invented-admin')).toEqual([]);
  });
});
