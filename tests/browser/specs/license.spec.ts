// COMM-03, SOV-02, SOV-04, UX-11: the license page as a person meets it. WRITTEN AND NOT YET RUN: it needs the
// stack, and every M6 slice merged. Installing a real document needs the test trust root, so this file covers
// what holds whichever way that goes, and tests/stack/sovereign-api.test.ts covers what a document changes.
import type { Page } from '@playwright/test';
import { createOrganization, join, signUp } from '../../helpers/forms';
import { expect, test } from '../support/fixtures';
import { axeFindings, sidewaysOverflow, THEMES, WIDTHS } from '../support/look';
import { alertIn } from '../support/notices';
import { makeAdmin } from '../support/people';

const licensePage = (organization: string) => `/o/${organization}/license`;

async function expectNoProblems(page: Page) {
  const problems: Record<string, unknown> = {};
  for (const theme of THEMES) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 800 });
      const findings = await axeFindings(page);
      if (findings.length) problems[`${theme}-${width}`] = findings;
      const overflow = await sidewaysOverflow(page);
      if (overflow > 0) problems[`${theme}-${width} overflow`] = `${overflow}px sideways`;
    }
  }
  expect(problems).toEqual({});
}

/** Presses Tab until the wanted name has focus, and checks a sighted person could tell. */
async function tabTo(page: Page, wanted: RegExp, limit = 60) {
  for (let i = 0; i < limit; i += 1) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      if (!element || element === document.body) return null;
      const style = getComputedStyle(element);
      return {
        name: (
          element.getAttribute('aria-label') ||
          element.closest('label')?.textContent ||
          element.textContent ||
          ''
        ).trim(),
        visible: element.matches(':focus-visible') && style.outlineStyle !== 'none',
      };
    });
    if (!stop) continue;
    expect(stop.visible, `"${stop.name}" shows that it has focus`).toBe(true);
    if (wanted.test(stop.name)) return;
  }
  throw new Error(`Tab never reached ${wanted}`);
}

test.describe('the license page', () => {
  test('an owner reads it, sees where it stands in words, and may install', async ({
    open,
    world,
  }) => {
    const page = await open(world.alice);
    await page.goto(licensePage(world.organization));
    await expect(page.getByRole('heading', { name: 'License and support' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Install a signed document' })).toBeVisible();
    await expect(page.getByLabel('Signed file')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Check and install' })).toBeVisible();
    // Nothing installed is a status, and the software going on is part of what it says.
    await expect(page.getByText('The software keeps running without one.')).toBeVisible();
    await expectNoProblems(page);
  });

  test('never says what the deployment is', async ({ open, world }) => {
    const page = await open(world.alice);
    await page.goto(licensePage(world.organization));
    const words = (await page.locator('body').innerText()).toLowerCase();
    for (const phrase of ['air-gap', 'air gap', 'certified', 'guarantee', 'license expired']) {
      expect(words).not.toContain(phrase);
    }
  });

  test('an admin reads it and installs nothing', async ({ open }) => {
    // An organization of its own, so that a new member changes nothing in the shared one.
    const owner = await signUp('Olive Owner');
    const organization = await createOrganization(owner, 'Read by an admin');
    const admin = await join(owner, organization, 'Ada Admin');
    await makeAdmin(owner, organization, admin);
    const page = await open(admin);
    await page.goto(licensePage(organization));
    await expect(page.getByRole('heading', { name: 'License and support' })).toBeVisible();
    await expect(page.getByText('Only an owner can install a signed document.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Check and install' })).toHaveCount(0);
    // Since the shared navigation model (16e5d81), this page is found under Administration, which the
    // navigation marks as where the admin is, and the Administration index links to it by name.
    await expect(
      page
        .getByRole('navigation', { name: 'Main', exact: true })
        .getByRole('link', { name: 'Administration', exact: true }),
    ).toHaveAttribute('aria-current', 'location');
    await expectNoProblems(page);
    await page.goto(`/o/${organization}/settings`);
    await expect(page.getByRole('link', { name: /^License and support/ })).toHaveAttribute(
      'href',
      licensePage(organization),
    );
  });

  test('a member gets the usual not found, and no link to it', async ({ open, world }) => {
    const page = await open(world.bob);
    const response = await page.goto(licensePage(world.organization));
    expect(response?.status()).toBe(404);
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'License and support' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Export and import' })).toHaveCount(0);
  });

  test('someone outside the organization gets the same as anything else missing', async ({
    open,
    world,
  }) => {
    const page = await open(world.quiet);
    const response = await page.goto(licensePage(world.organization));
    expect(response?.status()).toBe(404);
    await expect(page.getByText('Northwind Studio')).toHaveCount(0);
  });

  test('refusing a file in the form says so, changes nothing, and needs no JavaScript', async ({
    open,
    world,
  }) => {
    const page = await open(world.alice, { javaScriptEnabled: false });
    await page.goto(licensePage(world.organization));
    await page.getByLabel('Or paste what the file holds').fill('this is not a signed file');
    await page.getByRole('button', { name: 'Check and install' }).click();
    await expect(alertIn(page)).toContainText('could not be verified');
    await expect(
      page.getByText('No license is installed for this organization.').first(),
    ).toBeVisible();
  });

  test('can be worked with the keyboard alone', async ({ open, world }) => {
    const page = await open(world.alice);
    await page.goto(licensePage(world.organization));
    await tabTo(page, /Signed file/);
    await tabTo(page, /Or paste what the file holds/);
    await page.keyboard.type('this is not a signed file');
    await tabTo(page, /Check and install/);
    await page.keyboard.press('Enter');
    await expect(alertIn(page)).toContainText('could not be verified');
  });
});
