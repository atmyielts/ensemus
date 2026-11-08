import { randomUUID } from 'node:crypto';
import { expect, test } from '../support/fixtures';
import { createOrganization, join, signUp, submit } from '../../helpers/forms';

test('retention rules and legal holds work without JavaScript', async ({ open, world }) => {
  const page = await open(world.alice, { javaScriptEnabled: false });
  await page.goto(`/o/${world.organization}/account`);
  await page.getByRole('link', { name: /^Data retention\b/ }).click();
  await expect(page.getByRole('heading', { name: 'Data retention', exact: true })).toBeVisible();
  await page.getByLabel('Sign-off reference').fill(randomUUID());
  await page.getByRole('button', { name: 'Save retention rule' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Retention rule saved.' })).toBeVisible();
  await page.getByRole('link', { name: 'Account', exact: true }).click();
  await page.getByRole('link', { name: /^Legal holds\b/ }).click();
  await page.getByLabel('Matter reference').fill(randomUUID());
  await page.getByLabel('Records to preserve').selectOption('organization:');
  await page.getByRole('button', { name: 'Place legal hold' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Legal hold placed.' })).toBeVisible();
  await page.getByText('Release this hold', { exact: true }).click();
  await expect(
    page.getByRole('combobox', { name: 'Reason for releasing this hold', exact: true }),
  ).toHaveValue('');
  await page
    .getByRole('combobox', { name: 'Reason for releasing this hold', exact: true })
    .selectOption({ label: 'Our organization requests release of this hold' });
  await page.getByLabel('I confirm that this hold can be released.', { exact: false }).check();
  await page.getByRole('button', { name: 'Release hold', exact: true }).click();
  await expect(page.getByText('Released', { exact: true })).toBeVisible();
});
test('members cannot discover retention or legal-hold administration', async ({ open, world }) => {
  const page = await open(world.bob);
  await page.goto(`/o/${world.organization}/account`);
  for (const name of [/^Data retention\b/, /^Legal holds\b/])
    await expect(page.getByRole('link', { name })).toHaveCount(0);
  for (const path of ['retention', 'legal-holds'])
    expect((await page.goto(`/o/${world.organization}/account/${path}`))?.status()).toBe(404);
});

test('administrators can discover retention but not owner-only legal holds', async ({ open }) => {
  const owner = await signUp('Generated retention role owner'),
    organization = await createOrganization(owner, 'Generated retention role company'),
    admin = await join(owner, organization, 'Generated retention administrator'),
    people = `/o/${organization}/people`,
    promoted = await submit(
      people,
      owner.jar,
      (form) => form.html.includes(`Save access for ${admin.name}`),
      { role: 'admin' },
    );
  expect(promoted.headers.get('location')).toBe(people);
  const page = await open(admin, { javaScriptEnabled: false });
  await page.goto(`/o/${organization}/account`);
  await expect(page.getByRole('link', { name: /^Legal holds\b/ })).toHaveCount(0);
  await page.getByRole('link', { name: /^Data retention\b/ }).click();
  await expect(page.getByRole('heading', { name: 'Data retention', exact: true })).toBeVisible();
  expect((await page.goto(`/o/${organization}/account/legal-holds`))?.status()).toBe(404);
});
