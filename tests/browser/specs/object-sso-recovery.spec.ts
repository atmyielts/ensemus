// Authored real HTTP/native-action journeys with the existing generated SAML provider. No hosted
// provider, direct admission flag, forged interactive identity or persisted private draft fixture.
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { BASE, PASSWORD } from '../../helpers/forms';
import {
  ssoStackFixture as createSsoFixture,
  generatedHttpPerson,
} from '../../helpers/sso-stack-fixture';
import { axeFindings } from '../support/look';
const ssoStackFixture = () => createSsoFixture({ browserProvider: true });
type Fixture = Awaited<ReturnType<typeof ssoStackFixture>>;
const origin = new URL(BASE).origin;
async function generatedProvider(page: Page, f: Fixture) {
  if (!f.browserProvider) throw new Error('GENERATED_BROWSER_PROVIDER_REQUIRED');
  await page.context().addCookies([
    f.browserProvider.configure({
      acsURL: `${BASE}/api/auth/sso/saml2/sp/acs/${f.connection.provider_id}`,
      response: (url) => f.idp.response(url, f.spMetadata, f.member.email),
    }),
  ]);
}
async function verifyInOtherTab(page: Page, f: Fixture) {
  const waiting = page.waitForEvent('popup');
  await page
    .getByRole('link', { name: 'Verify company sign-in in another tab', exact: true })
    .click();
  const verify = await waiting;
  // Existing password members explicitly consent to a native link. Ordinary Continue keeps its
  // unverified-local-email refusal; the test must not silently depend on automatic account linking.
  await verify.getByLabel('Password for this Ensemus account', { exact: true }).fill(PASSWORD);
  await verify
    .getByLabel('I want to connect company sign-in to this Ensemus account.', { exact: true })
    .check();
  await verify.getByRole('button', { name: 'Connect company sign-in', exact: true }).click();
  await expect(
    verify.getByRole('heading', { name: 'Confirm generated company sign-in', exact: true }),
  ).toBeVisible();
  await verify.getByRole('button', { name: 'Continue to Ensemus', exact: true }).click();
  await expect(verify).toHaveURL(new RegExp(`/o/${f.organization}$`));
  return verify;
}
async function schema(owner: Page, f: Fixture) {
  const response = await owner.request.post(
    `/api/v1/organizations/${f.organization}/object-types`,
    {
      headers: { origin, 'idempotency-key': randomUUID() },
      data: {
        slug: `recovery_${randomUUID().replaceAll('-', '')}`,
        display_name: 'Generated recovery records',
        classification: 'internal',
        fields: [
          { key: 'note', label: 'Private note', kind: 'text', required: false, indexed: false },
        ],
        relations: [],
      },
    },
  );
  expect(response.status()).toBe(201);
  return response.json();
}
const retainedVersion = (page: Page) =>
  page
    .locator('form')
    .filter({ has: page.getByRole('button', { name: 'Retry these changes', exact: true }) })
    .locator('input[name="version"]');

test.describe('company sign-in changing while a custom editor is open', () => {
  for (const javaScriptEnabled of [true, false])
    test(`holds only submitted record intent and retries after actual SAML admission (${javaScriptEnabled ? 'JavaScript' : 'no JavaScript'})`, async ({
      open,
    }) => {
      const f = await ssoStackFixture(),
        owner = await open(f.owner),
        page = await open(f.member, { javaScriptEnabled }),
        type = await schema(owner, f),
        api = `/api/v1/organizations/${f.organization}`;
      const created = await page.request.post(`${api}/object-types/${type.id}/records`, {
        headers: { origin, 'idempotency-key': randomUUID() },
        data: {
          display_name: 'Original saved record',
          classification: 'internal',
          attributes: { note: 'Original saved private value' },
        },
      });
      expect(created.status()).toBe(201);
      const record = await created.json(),
        original = `/o/${f.organization}/objects/records/${record.id}`,
        recovery = `/object-editor/${f.organization}/record/${record.id}`;
      await page.goto(original);
      await page.getByText('Edit record', { exact: true }).click();
      const form = page
          .locator('form')
          .filter({ has: page.getByRole('button', { name: 'Save record', exact: true }) }),
        version = await form.locator('input[name="version"]').inputValue();
      await page.getByLabel('Record name', { exact: true }).fill('My submitted record name');
      await page.getByLabel('Private note', { exact: true }).fill('My submitted private note');
      await generatedProvider(page, f);
      await f.requireSso();
      await page.getByRole('button', { name: 'Save record', exact: true }).click();
      await expect(
        page.getByRole('region', { name: 'Company sign-in needed', exact: true }),
      ).toBeVisible();
      await expect(retainedVersion(page)).toHaveValue(version);
      if (!javaScriptEnabled)
        await expect(page).toHaveURL(
          new RegExp(`/object-editor/${f.organization}/record/${record.id}$`),
        );
      await page.getByText('Review the submitted values', { exact: true }).click();
      await expect(page.getByText('My submitted private note', { exact: true })).toBeVisible();
      expect(
        (await (await owner.request.get(`${api}/object-records/${record.id}`)).json()).display_name,
      ).toBe('Original saved record');
      const fresh = await open(f.member, { javaScriptEnabled: false });
      await fresh.goto(recovery);
      await expect(
        fresh.getByRole('region', { name: 'Company sign-in needed', exact: true }),
      ).toBeVisible();
      await expect(
        fresh.getByRole('form', { name: 'Retry submitted changes', exact: true }),
      ).toHaveCount(0);
      await expect(fresh.getByText('My submitted private note', { exact: true })).toHaveCount(0);
      await expect(fresh.getByText('Original saved private value', { exact: true })).toHaveCount(0);
      await expect(fresh.getByLabel('Private note', { exact: true })).toHaveCount(0);
      const foreign = await open(await generatedHttpPerson(f.domain, 'Generated unrelated person'));
      await foreign.goto(recovery);
      await expect(
        foreign.getByRole('heading', { name: 'Page not found', exact: true }),
      ).toBeVisible();
      await verifyInOtherTab(page, f);
      await expect(retainedVersion(page)).toHaveValue(version);
      await page.getByRole('button', { name: 'Retry these changes', exact: true }).click();
      await expect(
        page.getByRole('heading', { name: 'My submitted record name', exact: true }),
      ).toBeVisible();
      const saved = await page.request.get(`${api}/object-records/${record.id}`);
      expect(saved.status()).toBe(200);
      expect(await saved.json()).toMatchObject({
        display_name: 'My submitted record name',
        attributes: { note: 'My submitted private note' },
        version: Number(version) + 1,
      });
      if (javaScriptEnabled) expect(await axeFindings(page)).toEqual([]);
    });
  test('an admitted native retry keeps the old expected version after another person changes the record', async ({
    open,
  }) => {
    const f = await ssoStackFixture(),
      owner = await open(f.owner),
      page = await open(f.member, { javaScriptEnabled: false }),
      type = await schema(owner, f),
      api = `/api/v1/organizations/${f.organization}`;
    const created = await page.request.post(`${api}/object-types/${type.id}/records`, {
      headers: { origin, 'idempotency-key': randomUUID() },
      data: { display_name: 'Original version', classification: 'internal', attributes: {} },
    });
    expect(created.status()).toBe(201);
    const record = await created.json();
    await page.goto(`/o/${f.organization}/objects/records/${record.id}`);
    await page.getByText('Edit record', { exact: true }).click();
    const version = await page.locator('input[name="version"]').first().inputValue();
    await page.getByLabel('Record name', { exact: true }).fill('My stale submitted change');
    await generatedProvider(page, f);
    await f.requireSso();
    await page.getByRole('button', { name: 'Save record', exact: true }).click();
    await expect(retainedVersion(page)).toHaveValue(version);
    const changed = await owner.request.patch(`${api}/object-records/${record.id}`, {
      headers: { origin, 'if-match': created.headers().etag ?? '' },
      data: { display_name: 'Current change by administrator' },
    });
    expect(changed.status()).toBe(200);
    await verifyInOtherTab(page, f);
    await page.getByRole('button', { name: 'Retry these changes', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText(
      'Someone else changed this first. Check the latest version and try again.',
    );
    await expect(page.getByLabel('Record name', { exact: true })).toHaveValue(
      'My stale submitted change',
    );
    await expect(
      page
        .locator('form')
        .filter({ has: page.getByRole('button', { name: 'Save record', exact: true }) })
        .locator('input[name="version"]'),
    ).toHaveValue(version);
    expect(
      (await (await owner.request.get(`${api}/object-records/${record.id}`)).json()).display_name,
    ).toBe('Current change by administrator');
    await page.getByRole('link', { name: 'Reload current version', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Current change by administrator', exact: true }),
    ).toBeVisible();
  });
  for (const javaScriptEnabled of [true, false])
    test(`retries an Add connection intent without creating a type (${javaScriptEnabled ? 'JavaScript' : 'no JavaScript'})`, async ({
      open,
    }) => {
      const f = await ssoStackFixture(),
        owner = await open(f.owner),
        target = await schema(owner, f);
      await owner.goto(`/o/${f.organization}/people`);
      await owner.getByLabel(`Access for ${f.member.name}`, { exact: true }).selectOption('admin');
      await owner
        .getByRole('button', { name: `Save access for ${f.member.name}`, exact: true })
        .click();
      await expect(owner.getByLabel(`Access for ${f.member.name}`, { exact: true })).toHaveValue(
        'admin',
      );
      const page = await open(f.member, { javaScriptEnabled });
      await page.goto(`/o/${f.organization}/objects/new`);
      await page.getByLabel('Type name', { exact: true }).fill('My held new type');
      await page
        .getByRole('combobox', { name: 'Minimum sensitivity', exact: true })
        .selectOption('internal');
      await page
        .getByRole('group', { name: 'Field 1', exact: true })
        .getByLabel('Label', { exact: true })
        .fill('Pending first field');
      const key = await page.locator('input[name="requestKey"]').inputValue();
      await generatedProvider(page, f);
      await f.requireSso();
      await page.getByRole('button', { name: 'Add a connection', exact: true }).click();
      await expect(
        page.getByRole('button', { name: 'Retry adding the connection', exact: true }),
      ).toBeVisible();
      await expect(page.locator('input[name="requestKey"]')).toHaveValue(key);
      await expect(page.locator('input[name="intent"]')).toHaveValue('add-relation');
      await verifyInOtherTab(page, f);
      await page.getByRole('button', { name: 'Retry adding the connection', exact: true }).click();
      await expect(page.getByRole('group', { name: 'Relation 1', exact: true })).toBeVisible();
      await expect(page.getByLabel('Type name', { exact: true })).toHaveValue('My held new type');
      await expect(page.locator('input[name="requestKey"]')).toHaveValue(key);
      const listing = await owner.request.get(
        `/api/v1/organizations/${f.organization}/object-types`,
      );
      expect(listing.status()).toBe(200);
      expect((await listing.json()).items).toHaveLength(1);
      const connection = page.getByRole('group', { name: 'Relation 1', exact: true });
      await connection.getByLabel('Relation label', { exact: true }).fill('Connected records');
      await connection
        .getByRole('combobox', { name: 'Related type', exact: true })
        .selectOption(target.slug);
      await connection.getByRole('combobox', { name: 'How many', exact: true }).selectOption('one');
      await page.getByRole('button', { name: 'Add another field', exact: true }).click();
      await expect(
        connection.getByRole('combobox', { name: 'Related type', exact: true }),
      ).toHaveValue(target.slug);
      await expect(connection.getByRole('combobox', { name: 'How many', exact: true })).toHaveValue(
        'one',
      );
      await page
        .getByRole('group', { name: 'Field 2', exact: true })
        .getByLabel('Label', { exact: true })
        .fill('Second field');
      await page.getByRole('button', { name: 'Create type', exact: true }).click();
      await expect(
        page.getByRole('heading', { name: 'My held new type', exact: true }),
      ).toBeVisible();
    });
});
