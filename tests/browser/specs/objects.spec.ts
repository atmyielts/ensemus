import { randomUUID } from 'node:crypto';
import { expect, test } from '../support/fixtures';
import { axeFindings } from '../support/look';

test.describe('custom record native forms', () => {
  for (const javaScriptEnabled of [true, false])
    test(`defines, validates, edits and privately removes records (${javaScriptEnabled ? 'JavaScript' : 'no JavaScript'})`, async ({
      open,
      world,
    }) => {
      const page = await open(world.alice, { javaScriptEnabled, width: 390 }),
        suffix = randomUUID().replaceAll('-', ''),
        typeName = `Devices ${suffix}`,
        recordName = `Device ${suffix}`;
      await page.goto(`/o/${world.organization}/objects/new`);
      await page.getByLabel('Type name', { exact: true }).fill(typeName);
      await page.getByLabel('Type key', { exact: true }).fill(`devices_${suffix}`);
      const first = page.getByRole('group', { name: 'Field 1', exact: true });
      await first.getByLabel('Label', { exact: true }).fill('Serial');
      await first.getByLabel('Field key', { exact: true }).fill('serial');
      await first.getByLabel('Required', { exact: true }).check();
      await first.getByLabel('Allow filtering', { exact: false }).check();
      await page.getByRole('button', { name: 'Create type', exact: true }).click();
      await expect(page.getByRole('heading', { name: typeName, exact: true })).toBeVisible();
      await page.getByRole('link', { name: 'Create record', exact: true }).click();
      await page.getByLabel('Record name', { exact: true }).fill(recordName);
      await page.getByLabel('Serial (required)', { exact: true }).fill('generated-001');
      await expect(page.getByLabel('Sensitivity', { exact: true })).toHaveValue('restricted');
      await page.getByRole('button', { name: 'Create record', exact: true }).click();
      await expect(page.getByRole('heading', { name: recordName, exact: true })).toBeVisible();
      const recordPath = new URL(page.url()).pathname;
      if (javaScriptEnabled) expect(await axeFindings(page)).toEqual([]);
      const other = await open(world.bob, { javaScriptEnabled });
      await other.goto(recordPath);
      await expect(other.getByRole('heading', { name: recordName, exact: true })).toHaveCount(0);
      await page.getByText('Edit record', { exact: true }).click();
      await page.getByLabel('Serial (required)', { exact: true }).fill('generated-002');
      await page.getByRole('button', { name: 'Save record', exact: true }).click();
      await expect(page.getByRole('definition').filter({ hasText: 'generated-002' })).toBeVisible();
      await page.getByText('Remove this record', { exact: true }).click();
      await page.getByRole('button', { name: 'Remove record', exact: true }).click();
      await expect(page.getByRole('heading', { name: typeName, exact: true })).toBeVisible();
      await page.goto(recordPath);
      await expect(page.getByRole('heading', { name: recordName, exact: true })).toHaveCount(0);
    });
  test('requires write preconditions and denies private record API reads', async ({
    open,
    world,
  }) => {
    const page = await open(world.alice),
      base = `/api/v1/organizations/${world.organization}`,
      suffix = randomUUID().replaceAll('-', '');
    // Reach the proxy before building Origin; no external service or credentials are used.
    await page.goto(`/o/${world.organization}/objects`);
    const headers = { origin: new URL(page.url()).origin, 'idempotency-key': randomUUID() };
    const create = await page.request.post(`${base}/object-types`, {
      headers,
      data: {
        slug: `api_${suffix}`,
        display_name: 'API items',
        classification: 'internal',
        fields: [],
        relations: [],
      },
    });
    expect(create.status()).toBe(201);
    const type = await create.json();
    const recordResponse = await page.request.post(`${base}/object-types/${type.id}/records`, {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: { display_name: 'Private API item', attributes: {}, classification: 'restricted' },
    });
    expect(recordResponse.status()).toBe(201);
    const record = await recordResponse.json();
    const refused = await page.request.patch(`${base}/object-records/${record.id}`, {
      headers,
      data: { display_name: 'Changed' },
    });
    expect(refused.status()).toBe(428);
    const other = await open(world.bob);
    await other.goto(`/o/${world.organization}/objects`);
    expect((await other.request.get(`${base}/object-records/${record.id}`)).status()).toBe(404);
  });
});
