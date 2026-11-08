import { randomUUID } from 'node:crypto';
import { test, expect } from '../support/fixtures';
import { axeFindings } from '../support/look';
import { publishGeneratedProcess } from '../../helpers/process-run';
import { BASE } from '../../helpers/forms';
test.describe('native workflow execution follows real work', () => {
  test.setTimeout(240000);
  for (const javaScriptEnabled of [true, false])
    test(`starts saved work, follows the real task and requests a stop (${javaScriptEnabled ? 'JavaScript' : 'no JavaScript'})`, async ({
      open,
      world,
    }) => {
      const definition = await publishGeneratedProcess(world.alice, world.organization),
        page = await open(world.alice, { javaScriptEnabled, width: 390 }),
        base = `/o/${world.organization}/studio/runs`,
        title = `Generated workflow run ${randomUUID().slice(0, 8)}`;
      await page.goto(`${base}/new?spec=${definition.specId}`);
      await expect(
        page.getByRole('heading', { name: 'Start an approved workflow', exact: true }),
      ).toBeVisible();
      await page.getByLabel('Name this work', { exact: true }).fill(title);
      await page.getByRole('button', { name: 'Start this workflow', exact: true }).click();
      await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
      await expect(
        page.getByRole('link', { name: 'Open workflow work', exact: true }),
      ).toBeVisible();
      expect(new URL(page.url()).pathname).toMatch(/\/studio\/runs\/[0-9a-f-]{36}$/);
      const runPath = new URL(page.url()).pathname;
      if (javaScriptEnabled) expect(await axeFindings(page)).toEqual([]);
      await expect
        .poll(
          async () => {
            await page.getByRole('link', { name: 'Refresh workflow status', exact: true }).click();
            return page.getByRole('link', { name: 'Open this step’s work', exact: true }).count();
          },
          { timeout: 90000 },
        )
        .toBe(1);
      await page.getByRole('link', { name: 'Open this step’s work', exact: true }).click();
      await expect(
        page.getByRole('heading', { name: 'Prepare the generated report', exact: true }),
      ).toBeVisible();
      await page.goto(runPath);
      await page
        .getByLabel('I want to stop further steps and review any action already in progress.', {
          exact: true,
        })
        .check();
      await page.getByRole('button', { name: 'Request stop', exact: true }).click();
      await expect(
        page.getByRole('status').filter({ hasText: 'Your stop request is recorded' }),
      ).toBeVisible();
      if (javaScriptEnabled) expect(await axeFindings(page)).toEqual([]);
    });
  test('does not let an ordinary employee start definitions and hides another tenant’s run', async ({
    open,
    world,
  }) => {
    const member = await open(world.bob);
    await member.goto(`/o/${world.organization}/studio/runs/new`);
    await expect(
      member.getByRole('heading', { name: 'Page not found', exact: true }),
    ).toBeVisible();
    const definition = await publishGeneratedProcess(world.alice, world.organization),
      owner = await open(world.alice),
      response = await owner.request.post(
        `/api/v1/organizations/${world.organization}/process-runs`,
        {
          headers: { origin: new URL(BASE).origin, 'idempotency-key': randomUUID() },
          data: { spec_id: definition.specId, title: 'Generated private workflow' },
        },
      );
    expect(response.status()).toBe(202);
    const row = await response.json(),
      outsider = await open(world.quiet);
    await outsider.goto(`/o/${world.organization}/studio/runs/${row.id}`);
    await expect(
      outsider.getByRole('heading', { name: 'Page not found', exact: true }),
    ).toBeVisible();
  });
});
