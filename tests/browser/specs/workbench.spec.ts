// The real server-rendered queue and shadcn enhancements share the same authorized routes.
import { randomUUID } from 'node:crypto';
import { createOrganization, signUp, type Person } from '../../helpers/forms';
import { expect, test } from '../support/fixtures';
import { createWork, workPath } from '../support/world';

let person: Person;
let organization: string;
let work: string;
const title = `Workbench ${randomUUID()}`;
test.beforeAll(async () => {
  person = await signUp('Workbench Reader');
  organization = await createOrganization(person, `Workbench ${randomUUID()}`);
  work = await createWork(person, organization, { title, classification: 'restricted' });
});

test('a work selection, its full details and the native search link work without scripts', async ({
  open,
}) => {
  const page = await open(person, { javaScriptEnabled: false, width: 320 });
  await page.goto(`/o/${organization}`);
  await page.locator('.queue-row').filter({ hasText: title }).click();
  const preview = page.getByRole('complementary', { name: 'Selected work' });
  await expect(preview).toContainText(title);
  await expect(preview.getByRole('link', { name: 'Open work details' })).toHaveAttribute(
    'href',
    workPath(organization, work),
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await preview.getByRole('link', { name: 'Close work preview' }).click();
  await expect(preview).toHaveCount(0);
  await page.getByRole('link', { name: /^Search/ }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${organization}/search$`));
});

test('search uses a keyboard dialog, restores focus and submits the actual search form', async ({
  open,
}) => {
  const page = await open(person);
  await page.goto(`/o/${organization}`);
  await page.getByRole('button', { name: 'Switch to dark theme' }).waitFor();
  await page.keyboard.press('Control+k');
  const dialog = page.getByRole('dialog', { name: 'Search the company' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('searchbox', { name: 'Search' }).fill(title);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('link', { name: /^Search/ })).toBeFocused();
  await page.keyboard.press('Enter');
  await dialog.getByRole('searchbox', { name: 'Search' }).fill(title);
  await dialog.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/search\\?q=`));
  await expect(page.getByRole('main')).toContainText(title);
});

test('the explicit theme preference persists after navigation and reload', async ({ open }) => {
  const page = await open(person);
  await page.goto(`/o/${organization}`);
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await page.getByRole('button', { name: 'Switch to dark theme' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Switch to light theme' })).toBeVisible();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.getByRole('button', { name: 'Switch to light theme' }).click();
  await expect(page.locator('html')).not.toHaveClass(/dark/);
});
