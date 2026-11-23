import { randomUUID } from 'node:crypto';
import { createOrganization, join, signUp } from '../../helpers/forms';
import { contractProblems } from '../../helpers/openapi';
import { expect, test } from '../support/fixtures';
import { axeFindings, sidewaysOverflow } from '../support/look';

test('an owner reads the deployment posture through Administration and the API; members and outsiders are refused', async ({
  open,
}) => {
  const owner = await signUp('Generated deployment owner');
  const organization = await createOrganization(owner, `Deployment ${randomUUID()}`);
  const member = await join(owner, organization, 'Generated deployment member');
  const outsider = await signUp('Generated deployment outsider');
  const base = `/o/${organization}`;
  const api = `/api/v1/organizations/${organization}/tenancy/posture`;
  const page = await open(owner, { width: 375, colorScheme: 'dark' });
  await page.goto(`${base}/settings`);
  await page.getByRole('link', { name: /^Deployment posture/ }).click();
  await expect(page.getByRole('heading', { name: 'Deployment posture', level: 1 })).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Isolation check results' }).getByRole('listitem'),
  ).toHaveCount(9);
  await expect(
    page.getByRole('list', { name: 'Data handling regions' }).getByRole('listitem'),
  ).toHaveCount(6);
  expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(1);
  expect(await axeFindings(page)).toEqual([]);
  const response = await page.request.get(api);
  expect(response.status()).toBe(200);
  expect(response.headers()['cache-control']).toContain('no-store');
  const text = await response.text();
  expect(JSON.parse(text)).toMatchObject({
    tier: 'shared',
    home_region: null,
    isolated: false,
    all_in_region: false,
  });
  expect(
    contractProblems({
      method: 'GET',
      path: api,
      status: response.status(),
      headers: new Headers(response.headers()),
      text,
    }).problems,
  ).toEqual([]);
  const nativeOwnerPage = await open(owner, { javaScriptEnabled: false, width: 320 });
  await nativeOwnerPage.goto(`${base}/deployment`);
  await expect(
    nativeOwnerPage.getByRole('heading', { name: 'Deployment posture', level: 1 }),
  ).toBeVisible();
  expect(await sidewaysOverflow(nativeOwnerPage)).toBeLessThanOrEqual(1);
  const memberPage = await open(member, { javaScriptEnabled: false });
  await memberPage.goto(`${base}/settings`);
  await expect(memberPage.getByRole('link', { name: /^Deployment posture/ })).toHaveCount(0);
  await memberPage.goto(`${base}/deployment`);
  await expect(
    memberPage.getByRole('heading', { name: 'Deployment posture', level: 1 }),
  ).toHaveCount(0);
  expect((await memberPage.request.get(api)).status()).toBe(404);
  const outsiderPage = await open(outsider);
  expect((await outsiderPage.request.get(api)).status()).toBe(404);
});
