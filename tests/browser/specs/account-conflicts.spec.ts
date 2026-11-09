// Authored actual two-tab/native optimistic-conflict journeys. No DOM version forgery, mock DAL,
// automatic merge, persisted browser draft, or forced success state.
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { createOrganization, signUp } from '../../helpers/forms';

const billingForm = (page: Page) =>
  page
    .locator('form')
    .filter({ has: page.getByRole('button', { name: 'Save billing details', exact: true }) });
const replyForm = (page: Page) =>
  page
    .locator('form')
    .filter({ has: page.getByRole('button', { name: 'Add reply', exact: true }) });
async function saveBilling(page: Page, name: string, email: string) {
  await page.getByLabel('Billing name', { exact: true }).fill(name);
  await page.getByLabel('Billing email', { exact: true }).fill(email);
  await page.getByLabel('Country code', { exact: true }).fill('XX');
  await page.getByRole('button', { name: 'Save billing details', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Billing details saved.' }),
  ).toBeVisible();
}

for (const javaScriptEnabled of [true, false]) {
  test(`billing conflicts keep the original draft and version until explicit discard (${javaScriptEnabled ? 'JavaScript' : 'no JavaScript'})`, async ({
    open,
  }) => {
    const owner = await signUp('Generated billing conflict owner'),
      organization = await createOrganization(owner, `Generated billing conflict ${randomUUID()}`),
      path = `/o/${organization}/account/billing`,
      page = await open(owner, { javaScriptEnabled });
    await page.goto(path);
    await saveBilling(page, 'Original billing details', 'original@example.invalid');
    const originalVersion = await billingForm(page).locator('input[name="version"]').inputValue();
    await page.getByLabel('Billing name', { exact: true }).fill('My unsaved billing draft');
    await page.getByLabel('Billing email', { exact: true }).fill('my-draft@example.invalid');
    const newer = await page.context().newPage();
    await newer.goto(path);
    await saveBilling(newer, 'Another editor’s saved details', 'latest@example.invalid');
    const latestVersion = await billingForm(newer).locator('input[name="version"]').inputValue();
    expect(latestVersion).not.toBe(originalVersion);
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.getByRole('button', { name: 'Save billing details', exact: true }).click();
      await expect(page.getByRole('main').getByRole('alert')).toHaveText(
        'Someone else changed this first. Check the latest version and try again.',
      );
      await expect(page.getByLabel('Billing name', { exact: true })).toHaveValue(
        'My unsaved billing draft',
      );
      await expect(page.getByLabel('Billing email', { exact: true })).toHaveValue(
        'my-draft@example.invalid',
      );
      await expect(billingForm(page).locator('input[name="version"]')).toHaveValue(originalVersion);
      await expect(
        page.getByRole('link', { name: 'Reload and discard my draft', exact: true }),
      ).toHaveAttribute('href', path);
    }
    await page.getByRole('link', { name: 'Reload and discard my draft', exact: true }).click();
    await expect(page.getByLabel('Billing name', { exact: true })).toHaveValue(
      'Another editor’s saved details',
    );
    await expect(page.getByLabel('Billing email', { exact: true })).toHaveValue(
      'latest@example.invalid',
    );
    await expect(billingForm(page).locator('input[name="version"]')).toHaveValue(latestVersion);
    await expect(
      page.getByRole('link', { name: 'Reload and discard my draft', exact: true }),
    ).toHaveCount(0);
  });

  test(`support conflicts keep an unsent reply and version until explicit discard (${javaScriptEnabled ? 'JavaScript' : 'no JavaScript'})`, async ({
    open,
  }) => {
    const owner = await signUp('Generated support conflict owner'),
      organization = await createOrganization(owner, `Generated support conflict ${randomUUID()}`),
      page = await open(owner, { javaScriptEnabled });
    await page.goto(`/o/${organization}/account/support`);
    await page.getByLabel('Subject', { exact: true }).fill('Generated conflict conversation');
    await page.getByLabel('Message', { exact: true }).fill('Original generated support request');
    await page.getByRole('button', { name: 'Open support ticket', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Generated conflict conversation', exact: true }),
    ).toBeVisible();
    const path = new URL(page.url()).pathname,
      originalVersion = await replyForm(page).locator('input[name="version"]').inputValue();
    await page
      .getByRole('textbox', { name: 'Your reply', exact: true })
      .fill('My unsent generated reply');
    const newer = await page.context().newPage();
    await newer.goto(path);
    await newer
      .getByRole('textbox', { name: 'Your reply', exact: true })
      .fill('Another tab’s committed reply');
    await newer.getByRole('button', { name: 'Add reply', exact: true }).click();
    await expect(newer.getByRole('status').filter({ hasText: 'Reply added.' })).toBeVisible();
    const latestVersion = await replyForm(newer).locator('input[name="version"]').inputValue();
    expect(latestVersion).not.toBe(originalVersion);
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.getByRole('button', { name: 'Add reply', exact: true }).click();
      await expect(page.getByRole('main').getByRole('alert')).toHaveText(
        'Someone else changed this first. Check the latest version and try again.',
      );
      await expect(page.getByRole('textbox', { name: 'Your reply', exact: true })).toHaveValue(
        'My unsent generated reply',
      );
      await expect(replyForm(page).locator('input[name="version"]')).toHaveValue(originalVersion);
      await expect(
        page.getByRole('link', { name: 'Reload and discard my draft', exact: true }),
      ).toHaveAttribute('href', path);
    }
    await page.getByRole('link', { name: 'Reload and discard my draft', exact: true }).click();
    await expect(page.getByText('Another tab’s committed reply', { exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Your reply', exact: true })).toHaveValue('');
    await expect(replyForm(page).locator('input[name="version"]')).toHaveValue(latestVersion);
    await expect(
      page.getByRole('link', { name: 'Reload and discard my draft', exact: true }),
    ).toHaveCount(0);
  });
}
