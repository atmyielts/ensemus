import { randomUUID } from 'node:crypto';
import { expect, test } from '../support/fixtures';

test.describe('company knowledge native forms', () => {
  for (const javaScriptEnabled of [true, false])
    test(`saves a classified source and reports its real processing state (${javaScriptEnabled ? 'JavaScript' : 'no JavaScript'})`, async ({
      open,
      world,
    }) => {
      const page = await open(world.alice, { javaScriptEnabled, width: 390 }),
        title = `Generated knowledge ${randomUUID()}`;
      await page.goto(`/o/${world.organization}/knowledge/new`);
      await page.getByLabel('Source name', { exact: true }).fill(title);
      await expect(
        page
          .getByRole('group', { name: 'Who can see this', exact: true })
          .getByRole('radio', { name: /^Restricted\b/ }),
      ).toBeChecked();
      await page.getByLabel('Document', { exact: true }).setInputFiles({
        name: 'source.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Generated source words for native form acceptance.'),
      });
      await page.getByRole('button', { name: 'Add source', exact: true }).click();
      await expect(page).toHaveURL(/\/knowledge\/sources\/[0-9a-f-]{36}$/);
      await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
      await expect(page.getByText('Not scanned', { exact: true })).toBeVisible();
      await expect(
        page.getByRole('link', { name: 'Download source file', exact: true }),
      ).toBeVisible();
      await expect(page.getByRole('main')).not.toContainText('NOT_IMPLEMENTED');
      const sourcePath = new URL(page.url()).pathname,
        other = await open(world.quiet, { javaScriptEnabled });
      await other.goto(sourcePath);
      await expect(other.getByRole('heading', { name: title, exact: true })).toHaveCount(0);
    });
  test('keeps a question out of URLs and submits its explicit restricted sensitivity', async ({
    open,
    world,
  }) => {
    const page = await open(world.alice),
      question = `Generated private question ${randomUUID()}`;
    await page.goto(`/o/${world.organization}/knowledge/ask`);
    await page.getByLabel('Your question', { exact: true }).fill(question);
    await expect(
      page
        .getByRole('group', { name: 'How private is your question?', exact: true })
        .getByRole('radio', { name: /^Restricted\b/ }),
    ).toBeChecked();
    await page.getByRole('button', { name: 'Ask question', exact: true }).click();
    await expect(page).toHaveURL(/\/knowledge\/answers\/[0-9a-f-]{36}$/);
    expect(page.url()).not.toContain(encodeURIComponent(question));
    await expect(page.getByRole('heading', { name: question, exact: true })).toBeVisible();
    await expect(page.locator('dt:text-is("How private") + dd')).toHaveText('Restricted');
  });
  test('preserves source form text when a wider grant is refused', async ({ open, world }) => {
    const page = await open(world.alice),
      title = `Keep source draft ${randomUUID()}`;
    await page.goto(`/o/${world.organization}/knowledge/new`);
    await page.getByLabel('Source name', { exact: true }).fill(title);
    // A normal restricted selector offers named people only. Forge a wider native form value to
    // exercise the server refusal rather than presenting that ineligible option in the product.
    await page.evaluate(() => {
      const field = document.querySelector<HTMLSelectElement>('select[name="sharing"]');
      if (!field) throw new Error('MISSING_SHARING');
      field.add(new Option('Forged organization grant', 'organization'));
      field.value = 'organization';
    });
    await page.getByLabel('Document', { exact: true }).setInputFiles({
      name: 'source.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Generated restricted source words.'),
    });
    await page.getByRole('button', { name: 'Add source', exact: true }).click();
    await expect(page.getByRole('main').getByRole('alert')).toBeVisible();
    await expect(page.getByLabel('Source name', { exact: true })).toHaveValue(title);
    await expect(
      page
        .getByRole('group', { name: 'Who can see this', exact: true })
        .getByRole('radio', { name: /^Restricted\b/ }),
    ).toBeChecked();
  });
});
