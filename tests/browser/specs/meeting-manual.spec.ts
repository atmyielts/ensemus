import { join } from 'node:path';
import { repoRoot } from '../../helpers/stack';
import { randomUUID } from 'node:crypto';
import { createOrganization, signUp } from '../../helpers/forms';
import { expect, test } from '../support/fixtures';
for (const javascript of [true, false])
  test(`manual meeting notes and withdrawal with scripts ${javascript ? 'on' : 'off'}`, async ({
    open,
  }) => {
    const owner = await signUp('Generated meeting browser organizer'),
      org = await createOrganization(owner, 'Generated meeting browser company');
    const page = await open(owner, {
      javaScriptEnabled: javascript,
      width: javascript ? 1280 : 320,
    });
    await page.goto(`/o/${org}/meetings`);
    await page
      .locator('summary')
      .filter({ hasText: /^Meeting settings$/ })
      .click();
    await page.getByLabel('Allow new meetings').check();
    await page.getByLabel('Notice reference', { exact: false }).fill('generated-browser-notice');
    await page.getByRole('button', { name: 'Save meeting settings', exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Meeting settings saved.' }),
    ).toBeVisible();
    await page
      .locator('summary')
      .filter({ hasText: /^New meeting$/ })
      .click();
    const title = 'Generated meeting ' + randomUUID();
    await page.getByLabel('Meeting title', { exact: true }).fill('   ');
    await page.getByLabel('Occurred at (UTC)', { exact: true }).fill('2026-11-23T10:00');
    await page.getByRole('button', { name: 'Create meeting', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create meeting', exact: true })).toBeEnabled();
    await expect(page.getByLabel('Occurred at (UTC)', { exact: true })).toHaveValue(
      '2026-11-23T10:00',
    );
    await page.getByLabel('Meeting title', { exact: true }).fill(title);
    await page.getByRole('button', { name: 'Create meeting', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${org}/meetings/[0-9a-f-]{36}$`));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
    await expect(
      page.getByText('Everyone listed must agree before notes can be stored.', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'I agree', exact: true }).click();
    await page
      .locator('summary')
      .filter({ hasText: /^Add notes$/ })
      .click();
    const notes = 'Generated private browser notes ' + randomUUID();
    await page.getByLabel('Meeting notes', { exact: true }).fill(notes);
    await page.getByRole('button', { name: 'Store notes', exact: true }).click();
    await expect(page.locator('.whitespace-pre-wrap').filter({ hasText: notes })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await page.screenshot({
      path: join(
        repoRoot,
        `output/playwright/meeting-${javascript ? 'desktop' : 'mobile'}-20261123.png`,
      ),
      fullPage: true,
    });
    const withdraw = page.locator('details.confirm').filter({ hasText: 'Withdraw consent' });
    await withdraw.locator('summary').click();
    await withdraw.locator('input[name="confirm"]').check();
    await withdraw.getByRole('button', { name: /^Withdraw and remove notes:/ }).click();
    await expect(page.getByText('Notes removed.', { exact: true })).toBeVisible();
    await expect(page.getByText(notes, { exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Removed');
  });
