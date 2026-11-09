import { randomUUID } from 'node:crypto';
import { BASE } from '../../helpers/forms';
import { expect, test } from '../support/fixtures';
import { axeFindings } from '../support/look';
test.describe('private outcome and company setup native forms', () => {
  for (const javaScriptEnabled of [true, false])
    test(`reviews edits and creates exact Work (${javaScriptEnabled ? 'JavaScript' : 'no JavaScript'})`, async ({
      open,
      world,
    }) => {
      const page = await open(world.bob, { javaScriptEnabled, width: 390 }),
        base = `/o/${world.organization}`;
      await page.goto(`${base}/compose`);
      await page
        .getByLabel('What outcome do you want?', { exact: true })
        .fill('Prepare a report by Friday');
      await page.getByLabel('Today where you are', { exact: true }).fill('2026-11-06');
      await page.getByRole('button', { name: 'Review a private preview', exact: true }).click();
      await expect(
        page.getByRole('heading', { name: 'Review your outcome', exact: true }),
      ).toBeVisible();
      const path = new URL(page.url()).pathname;
      await expect(
        page.getByText('File attached; a person checks the requested name and content.', {
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.getByLabel('Due date (optional)', { exact: true })).toHaveValue(
        '2026-11-13',
      );
      await page.getByLabel('Work title', { exact: true }).fill('Reviewed source-backed report');
      await page
        .getByRole('button', { name: 'Save changes and review again', exact: true })
        .click();
      await expect(
        page.getByRole('heading', { name: 'Reviewed source-backed report', exact: true }),
      ).toBeVisible();
      const owner = await open(world.alice, { javaScriptEnabled });
      await owner.goto(path);
      await expect(
        owner.getByRole('heading', { name: 'Page not found', exact: true }),
      ).toBeVisible();
      await page
        .getByLabel(
          'I have reviewed the saved owner, sensitivity, date and success requirements.',
          { exact: true },
        )
        .check();
      await page.getByRole('button', { name: 'Confirm and create Work', exact: true }).click();
      // The saved preview already shows this title as a heading, so the heading alone cannot say the
      // Work page has arrived. The address does, and the heading is then the Work's own.
      await expect(page).toHaveURL(/\/work\/[0-9a-f-]+$/);
      await expect(
        page.getByRole('heading', { name: 'Reviewed source-backed report', exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText(/a person checks the requested name and content/).first(),
      ).toBeVisible();
      await page.goto(path);
      await expect(page.getByRole('link', { name: 'Open the Work', exact: true })).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Confirm and create Work', exact: true }),
      ).toHaveCount(0);
    });
  test('keeps setup owner-managed, requests a real pure rehearsal and has accessible mobile forms', async ({
    open,
    world,
  }) => {
    const page = await open(world.alice, { width: 390 }),
      base = `/o/${world.organization}`;
    await page.goto(`${base}/get-started`);
    await expect(
      page.getByRole('heading', { name: 'Set up your company', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(
        'Adding a profile or source does not qualify a provider or prove an external connection.',
        { exact: false },
      ),
    ).toBeVisible();
    expect(await axeFindings(page)).toEqual([]);
    await page.getByRole('button', { name: 'Run the first rehearsal', exact: true }).click();
    await expect(
      page.getByRole('link', { name: 'Read the rehearsal report', exact: true }),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Read the rehearsal report', exact: true }).click();
    await expect(page.getByRole('heading').first()).toBeVisible();
    const member = await open(world.bob);
    await member.goto(`${base}/get-started`);
    await expect(
      member.getByText('An organization owner or administrator manages company setup.', {
        exact: false,
      }),
    ).toBeVisible();
    await expect(
      member.getByRole('button', { name: 'Run the first rehearsal', exact: true }),
    ).toHaveCount(0);
    await page.goto(`${base}/compose`);
    expect(await axeFindings(page)).toEqual([]);
    await page
      .getByLabel('What outcome do you want?', { exact: true })
      .fill('Prepare a private report');
    await page.getByRole('button', { name: 'Review a private preview', exact: true }).click();
    expect(await axeFindings(page)).toEqual([]);
  });
  test('does not confirm a stale saved preview through the public API', async ({ open, world }) => {
    const page = await open(world.bob),
      base = `/api/v1/organizations/${world.organization}/outcome-drafts`,
      origin = new URL(BASE).origin;
    const created = await page.request.post(base, {
      headers: { origin, 'idempotency-key': randomUUID() },
      data: { objective: 'Prepare a report', today: '2026-11-06' },
    });
    expect(created.status()).toBe(201);
    const draft = await created.json();
    const saved = await page.request.patch(`${base}/${draft.id}`, {
      headers: { origin, 'if-match': created.headers().etag ?? '' },
      data: { ...draft.preview, title: 'Someone edited this preview' },
    });
    expect(saved.status()).toBe(200);
    const stale = await page.request.post(`${base}/${draft.id}/authorization`, {
      headers: { origin, 'if-match': created.headers().etag ?? '' },
      data: { preview_sha256: draft.preview_sha256 },
    });
    expect(stale.status()).toBe(409);
    expect((await stale.json()).code).toBe('OUTCOME_CHANGED');
  });
});
