import { randomUUID } from 'node:crypto';
import { expect, test } from '../support/fixtures';
import { axeFindings } from '../support/look';
import { alertIn } from '../support/notices';
import { BASE } from '../../helpers/forms';

test.describe('native workflow authoring against actual compiler and review services', () => {
  for (const javaScriptEnabled of [true, false])
    test(`authors a human workflow, rehearses and requests frozen review (${javaScriptEnabled ? 'JavaScript' : 'no JavaScript'})`, async ({
      open,
      world,
    }) => {
      const page = await open(world.alice, { javaScriptEnabled, width: 390 }),
        base = `/o/${world.organization}/studio`,
        name = `Generated workflow ${randomUUID().slice(0, 8)}`;
      await page.goto(`${base}/workflows/new`);
      await page.getByLabel('Workflow name', { exact: true }).fill(name);
      await page
        .getByRole('group', { name: 'Who can see this', exact: true })
        .getByRole('radio', { name: /^Internal\b/ })
        .check();
      await page.getByRole('button', { name: 'Create workflow draft', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Edit workflow', exact: true })).toBeVisible();
      const add = page.getByRole('region', { name: 'Add a point', exact: true });
      await add.getByLabel('Point name', { exact: true }).fill('Gather evidence for a person');
      await add.getByRole('button', { name: 'Add this point', exact: true }).click();
      await expect(
        page.getByRole('status').filter({ hasText: 'The change was saved' }),
      ).toBeVisible();
      await page.getByRole('link', { name: 'Review the saved workflow', exact: true }).click();
      await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
      if (javaScriptEnabled) expect(await axeFindings(page)).toEqual([]);
      await page.getByRole('button', { name: 'Run the workflow rehearsal', exact: true }).click();
      await expect(
        page.getByRole('heading', { name: 'Rehearsal report', exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText('This was a practice run with made-up examples.', { exact: false }),
      ).toBeVisible();
      await expect
        .poll(
          async () => {
            await page.reload();
            return page.getByRole('heading', { name: 'The rehearsal passed', exact: true }).count();
          },
          { timeout: 60_000 },
        )
        .toBe(1);
      await page.getByRole('link', { name: 'Workflow draft', exact: true }).click();
      await page.getByLabel('Named reviewer', { exact: true }).selectOption({ index: 0 });
      await page
        .getByRole('button', { name: 'Request review of this workflow', exact: true })
        .click();
      await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
      await expect(
        page.getByRole('heading', { name: 'Frozen definition', exact: true }),
      ).toBeVisible();
      await expect(page.getByText('Gather evidence for a person', { exact: true })).toBeVisible();
      if (javaScriptEnabled) expect(await axeFindings(page)).toEqual([]);
    });
  test('refuses a non-builder and a different administrator reading an owner-only restricted draft', async ({
    open,
    world,
  }) => {
    const member = await open(world.bob),
      base = `/o/${world.organization}/studio/workflows`;
    await member.goto(base);
    await expect(
      member.getByRole('heading', { name: 'Page not found', exact: true }),
    ).toBeVisible();
    const owner = await open(world.alice),
      created = await owner.request.post(
        `/api/v1/organizations/${world.organization}/studio/process-drafts`,
        {
          headers: { origin: new URL(BASE).origin, 'idempotency-key': randomUUID() },
          data: { name: 'Private generated workflow', classification: 'restricted' },
        },
      );
    expect(created.status()).toBe(201);
    const draft = await created.json(),
      admin = await open(world.carol);
    await admin.goto(`${base}/${draft.id}`);
    await expect(admin.getByRole('heading', { name: 'Page not found', exact: true })).toBeVisible();
  });
  test('preserves stale form intent without overwriting a newer saved definition', async ({
    open,
    world,
  }) => {
    const page = await open(world.alice),
      base = `/o/${world.organization}/studio/workflows`;
    await page.goto(`${base}/new`);
    await page
      .getByLabel('Workflow name', { exact: true })
      .fill('Generated version conflict workflow');
    await page.getByRole('button', { name: 'Create workflow draft', exact: true }).click();
    // The click does not wait for the create redirect. Reading the URL before it lands sent the second
    // tab to /new, which has no "Save workflow details" button, and the test waited out its timeout.
    await page.waitForURL(/\/studio\/workflows\/[0-9a-f-]{36}\/edit$/);
    await expect(page.getByRole('heading', { name: 'Edit workflow', exact: true })).toBeVisible();
    const editPath = new URL(page.url()).pathname,
      other = await open(world.alice);
    await other.goto(editPath);
    await expect(other.getByRole('heading', { name: 'Edit workflow', exact: true })).toBeVisible();
    await page.getByLabel('Workflow name', { exact: true }).fill('First saved revision');
    await page.getByRole('button', { name: 'Save workflow details', exact: true }).click();
    // The first save must have landed before the second tab submits its now-stale revision.
    await expect(
      page.getByRole('heading', { name: 'First saved revision', exact: true }),
    ).toBeVisible();
    await other.getByLabel('Workflow name', { exact: true }).fill('Stale proposed revision');
    await other.getByRole('button', { name: 'Save workflow details', exact: true }).click();
    // The page's own refusal, in main: Next's route announcer is a second, empty alert outside it.
    await expect(alertIn(other)).toContainText(/changed|updated|refresh|again/i);
    await expect(other.getByLabel('Workflow name', { exact: true })).toHaveValue(
      'Stale proposed revision',
    );
    await other.reload();
    await expect(other.getByLabel('Workflow name', { exact: true })).toHaveValue(
      'First saved revision',
    );
  });
});
