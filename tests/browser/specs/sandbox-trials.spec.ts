import { createOrganization, join, signUp } from '../../helpers/forms';
import { signedTrialVersion } from '../../helpers/sandbox-trial';
import { expect, test } from '../support/fixtures';

test('a native mobile Sandbox form keeps input after refusal and can cancel a queued trial', async ({
  open,
}) => {
  test.skip(process.env.ENSEMUS_SANDBOX_ENABLED !== 'true', 'Needs the Sandbox test-stack switch');
  const owner = await signUp('Generated trial owner');
  const organization = await createOrganization(owner, 'Generated trial company');
  const member = await join(owner, organization, 'Generated trial member');
  const version = await signedTrialVersion(owner, organization);
  const page = await open(owner, { javaScriptEnabled: false, width: 320 });
  await page.goto(`/o/${organization}/skills/versions/${version}`);
  const input = page.getByRole('textbox', { name: 'JSON input', exact: true });
  const classification = page.getByLabel('Input classification', { exact: true });
  await expect(input).toBeVisible();
  await classification.selectOption('public');
  await input.fill('{"example":');
  await page.getByRole('button', { name: 'Run trial', exact: true }).click();
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(input).toHaveValue('{"example":');
  await expect(classification).toHaveValue('public');
  await expect(page.getByText('Enter valid JSON.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await input.fill('{"sample":true}');
  await page.getByRole('button', { name: 'Run trial', exact: true }).click();
  await expect(page).toHaveURL(/\/sandbox\/runs\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Sandbox trial' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel trial', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Status' })).toContainText('Cancelled');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const viewer = await open(member);
  expect((await viewer.goto(page.url()))?.status()).toBe(404);
});
