import { createOrganization, join, signUp } from '../../helpers/forms';
import { signedTrialVersion } from '../../helpers/sandbox-trial';
import { expect, test, type Open } from '../support/fixtures';

test.skip(process.env.ENSEMUS_SANDBOX_ENABLED !== 'true', 'Needs the Sandbox test-stack switch');

async function openNativeTrial(open: Open) {
  const owner = await signUp('Generated trial owner');
  const organization = await createOrganization(owner, 'Generated trial company');
  const version = await signedTrialVersion(owner, organization);
  const page = await open(owner, { javaScriptEnabled: false, width: 320 });
  const path = `/o/${organization}/skills/versions/${version}`;
  await page.goto(path);
  return { owner, organization, page, path };
}

test('a native mobile Sandbox form keeps input after refusal', async ({ open }) => {
  const { page, path } = await openNativeTrial(open);
  const input = page.getByRole('textbox', { name: 'JSON input', exact: true });
  const classification = page.getByLabel('Input classification', { exact: true });
  await expect(input).toBeVisible();
  await classification.selectOption('public');
  await input.fill('{"example":');
  const [response] = await Promise.all([
    page.waitForResponse(
      (reply) => reply.request().method() === 'POST' && new URL(reply.url()).pathname === path,
      { timeout: 20_000 },
    ),
    page.getByRole('button', { name: 'Run trial', exact: true }).click(),
  ]);
  expect(response.ok()).toBe(true);
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(input).toHaveValue('{"example":');
  await expect(classification).toHaveValue('public');
  await expect(page.getByText('Enter valid JSON.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('a native mobile operator queues and cancels a private Sandbox trial', async ({ open }) => {
  const { owner, organization, page } = await openNativeTrial(open);
  const member = await join(owner, organization, 'Generated trial member');
  await page.getByLabel('Input classification', { exact: true }).selectOption('public');
  await page.getByLabel('JSON input', { exact: true }).fill('{"sample":true}');
  await page.getByRole('button', { name: 'Run trial', exact: true }).click();
  await expect(page).toHaveURL(/\/sandbox\/runs\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Sandbox trial' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Status' })).toContainText('Queued');
  await page.getByRole('button', { name: 'Cancel trial', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Status' })).toContainText('Cancelled');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const viewer = await open(member, { javaScriptEnabled: false, width: 320 });
  expect((await viewer.goto(page.url()))?.status()).toBe(404);
});
