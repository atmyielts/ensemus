// ID-05: the way back from confirming a second factor comes from the address bar, so it is untrusted. Run
// here, because the web app has no test runner of its own.
import { describe, expect, it } from 'vitest';
import {
  safeStepUpReturn,
  stepUpPath,
  safeAccountStepUpReturn,
  accountStepUpPath,
  accountEnrollmentPath,
} from '../../apps/web/src/lib/step-up';

const ORG = '6f1c2c6e-1111-4111-8111-111111111111';
const OTHER = '6f1c2c6e-2222-4222-8222-222222222222';
const HOME = `/o/${ORG}`;

describe('the way back from a second factor', () => {
  it('keeps a path inside this organization', () => {
    expect(safeStepUpReturn(ORG, `${HOME}/studio/agents`)).toBe(`${HOME}/studio/agents`);
    expect(safeStepUpReturn(ORG, HOME)).toBe(HOME);
  });

  it.each([
    'https://evil.example/',
    '//evil.example',
    '/\\evil.example',
    `/o/${OTHER}/studio`,
    `${HOME}/../${OTHER}`,
    `${HOME}/studio?x=1`,
    `${HOME}x`,
    '',
    null,
    undefined,
    42,
  ])('sends %s home', (value) => {
    expect(safeStepUpReturn(ORG, value)).toBe(HOME);
  });

  it('encodes what it puts in the address', () => {
    expect(stepUpPath(ORG, `${HOME}/packs`)).toBe(
      `${HOME}/security/confirm?next=${encodeURIComponent(`${HOME}/packs`)}`,
    );
  });
});

describe('account-only second-factor returns', () => {
  const account = `${HOME}/account`;
  it.each([
    '',
    'billing',
    'credits',
    'invoices',
    'exports',
    'support',
    'leave',
    'retention',
    'legal-holds',
    'break-glass',
    `support/${OTHER}`,
    `invoices/${OTHER}`,
    `invoices/${OTHER}/pay`,
  ])('keeps the actual account destination %s', (suffix) => {
    const destination = suffix ? `${account}/${suffix}` : account;
    expect(safeAccountStepUpReturn(ORG, destination)).toBe(destination);
  });
  it.each([
    `${HOME}/work`,
    `${HOME}/data`,
    `${HOME}/security`,
    `${account}/confirm`,
    `${account}/two-factor`,
    `${account}/new-page`,
    `${account}/support/not-an-id`,
    `${account}/support/${OTHER}/messages`,
    `${account}/leave?body=private`,
    `${account}/leave#draft`,
    `${account}/../work`,
    `/o/${OTHER}/account/leave`,
    '//evil.invalid',
    'https://evil.invalid',
    `${account}/%2e%2e/work`,
    `${account}/billing/`,
    `${account}/`,
    null,
    undefined,
  ])('refuses non-allowlisted return %s', (value) => {
    expect(safeAccountStepUpReturn(ORG, value)).toBe(account);
  });
  it('refuses repeated return query values rather than choosing one', () => {
    expect(safeAccountStepUpReturn(ORG, [`${account}/leave`])).toBe(account);
  });
  it('pins both recovery URLs to the account surface', () => {
    expect(accountStepUpPath(ORG, `${HOME}/data`)).toBe(
      `${account}/confirm?next=${encodeURIComponent(account)}`,
    );
    expect(accountEnrollmentPath(ORG, `${account}/leave`)).toBe(
      `${account}/two-factor?next=${encodeURIComponent(`${account}/leave`)}`,
    );
  });
});
