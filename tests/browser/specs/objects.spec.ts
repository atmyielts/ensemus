import { randomUUID } from 'node:crypto';
import { expect, test } from '../support/fixtures';
import { axeFindings } from '../support/look';
import { PASSWORD, createOrganization, signUp } from '../../helpers/forms';
import { totpCode } from '../../helpers/totp';

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
      const first = page.getByRole('group', { name: 'Field 1', exact: true });
      await first.getByLabel('Label', { exact: true }).fill('Serial');
      await first.getByLabel('Required', { exact: true }).check();
      await first.getByLabel('Allow filtering', { exact: false }).check();
      const requestKey = await page.locator('input[name="requestKey"]').inputValue();
      await expect(page.getByRole('group', { name: /^Field \d+$/ })).toHaveCount(1);
      await page.getByRole('button', { name: 'Add another field', exact: true }).click();
      await expect(first.getByLabel('Label', { exact: true })).toHaveValue('Serial');
      await expect(first.getByLabel('Required', { exact: true })).toBeChecked();
      await expect(page.locator('input[name="requestKey"]')).toHaveValue(requestKey);
      await expect(page.getByRole('group', { name: /^Field \d+$/ })).toHaveCount(2);
      const second = page.getByRole('group', { name: 'Field 2', exact: true });
      await second.getByLabel('Label', { exact: true }).fill('Count');
      await second
        .getByRole('combobox', { name: 'Field type', exact: true })
        .selectOption('number');
      await page.getByRole('button', { name: 'Create record type', exact: true }).click();
      await expect(page.getByRole('heading', { name: typeName, exact: true })).toBeVisible();
      await page.getByRole('link', { name: 'Create record', exact: true }).click();
      await page.getByLabel('Record name', { exact: true }).fill(recordName);
      await page.getByLabel('Serial (required)', { exact: true }).fill('generated-001');
      await page.getByLabel('Count', { exact: true }).fill('0');
      await expect(
        page
          .getByRole('group', { name: 'Who can see this', exact: true })
          .getByRole('radio', { name: /^Restricted\b/ }),
      ).toBeChecked();
      await page.getByRole('button', { name: 'Create record', exact: true }).click();
      await expect(page.getByRole('heading', { name: recordName, exact: true })).toBeVisible();
      await expect(page.getByRole('definition').filter({ hasText: /^0$/ })).toBeVisible();
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
  for (const javaScriptEnabled of [true, false])
    test(`keeps a conflicting record draft until explicit reload (${javaScriptEnabled ? 'JavaScript' : 'no JavaScript'})`, async ({
      open,
    }) => {
      const person = await signUp('Generated record conflict owner'),
        organization = await createOrganization(person, 'Generated record conflict company'),
        page = await open(person, { javaScriptEnabled }),
        base = `/api/v1/organizations/${organization}`;
      await page.goto(`/o/${organization}/objects`);
      const headers = { origin: new URL(page.url()).origin, 'idempotency-key': randomUUID() };
      const createdType = await page.request.post(`${base}/object-types`, {
        headers,
        data: {
          slug: `conflict_${randomUUID().replaceAll('-', '')}`,
          display_name: 'Conflict records',
          classification: 'internal',
          fields: [],
          relations: [],
        },
      });
      expect(createdType.status()).toBe(201);
      const type = await createdType.json();
      const created = await page.request.post(`${base}/object-types/${type.id}/records`, {
        headers: { ...headers, 'idempotency-key': randomUUID() },
        data: { display_name: 'Original record', classification: 'internal', attributes: {} },
      });
      expect(created.status()).toBe(201);
      const record = await created.json();
      await page.goto(`/o/${organization}/objects/records/${record.id}`);
      await page.getByText('Edit record', { exact: true }).click();
      const form = page
        .locator('form')
        .filter({ has: page.getByRole('button', { name: 'Save record', exact: true }) });
      const originalVersion = await form.locator('input[name="version"]').inputValue();
      await page.getByLabel('Record name', { exact: true }).fill('My unsaved record');
      const changed = await page.request.patch(`${base}/object-records/${record.id}`, {
        headers: { ...headers, 'if-match': created.headers()['etag'] ?? '' },
        data: { display_name: 'A newer saved record' },
      });
      expect(changed.status()).toBe(200);
      for (let attempt = 0; attempt < 2; attempt++) {
        await page.getByRole('button', { name: 'Save record', exact: true }).click();
        await expect(page.getByRole('main').getByRole('alert')).toHaveText(
          'Someone else changed this first. Check the latest version and try again.',
        );
        await expect(page.getByLabel('Record name', { exact: true })).toHaveValue(
          'My unsaved record',
        );
        await expect(form.locator('input[name="version"]')).toHaveValue(originalVersion);
      }
      const current = await page.request.get(`${base}/object-records/${record.id}`);
      expect((await current.json()).display_name).toBe('A newer saved record');
      await page.getByRole('link', { name: 'Reload current version', exact: true }).click();
      await expect(
        page.getByRole('heading', { name: 'A newer saved record', exact: true }),
      ).toBeVisible();
      await page.getByText('Edit record', { exact: true }).click();
      await expect(page.getByLabel('Record name', { exact: true })).toHaveValue(
        'A newer saved record',
      );
      await expect(form.locator('input[name="version"]')).not.toHaveValue(originalVersion);
    });
  test('keeps typed record values while identity is verified in another tab without JavaScript', async ({
    open,
  }) => {
    const person = await signUp('Generated record identity owner'),
      organization = await createOrganization(person, 'Generated record identity company'),
      page = await open(person, { javaScriptEnabled: false }),
      base = `/api/v1/organizations/${organization}`;
    await page.goto(`/o/${organization}/objects`);
    const headers = { origin: new URL(page.url()).origin, 'idempotency-key': randomUUID() };
    const createdType = await page.request.post(`${base}/object-types`, {
      headers,
      data: {
        slug: `identity_${randomUUID().replaceAll('-', '')}`,
        display_name: 'Identity records',
        classification: 'internal',
        fields: [],
        relations: [],
      },
    });
    expect(createdType.status()).toBe(201);
    const type = await createdType.json();
    const created = await page.request.post(`${base}/object-types/${type.id}/records`, {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: {
        display_name: 'Original protected record',
        classification: 'confidential',
        attributes: {},
      },
    });
    expect(created.status()).toBe(201);
    const record = await created.json();
    await page.goto(`/o/${organization}/objects/records/${record.id}`);
    await page.getByText('Edit record', { exact: true }).click();
    const form = page
        .locator('form')
        .filter({ has: page.getByRole('button', { name: 'Save record', exact: true }) }),
      originalVersion = await form.locator('input[name="version"]').inputValue();
    await page.getByLabel('Record name', { exact: true }).fill('My retained record name');
    await page
      .getByRole('group', { name: 'Who can see this', exact: true })
      .getByRole('radio', { name: /^Internal\b/ })
      .check();
    await page.getByRole('button', { name: 'Save record', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText(
      'Confirm it is you with your authenticator app, then try again.',
    );
    await expect(page.getByLabel('Record name', { exact: true })).toHaveValue(
      'My retained record name',
    );
    await expect(
      page
        .getByRole('group', { name: 'Who can see this', exact: true })
        .getByRole('radio', { name: /^Internal\b/ }),
    ).toBeChecked();
    await expect(form.locator('input[name="version"]')).toHaveValue(originalVersion);
    const unchanged = await page.request.get(`${base}/object-records/${record.id}`);
    expect(await unchanged.json()).toMatchObject({
      display_name: 'Original protected record',
      classification: 'confidential',
    });
    const popup = page.waitForEvent('popup');
    await page.getByRole('link', { name: 'Verify identity in another tab', exact: true }).click();
    const verify = await popup;
    await verify.getByRole('link', { name: 'Set up authenticator app', exact: true }).click();
    await verify.getByLabel('Password, if you use one', { exact: true }).fill(PASSWORD);
    await verify.getByRole('button', { name: 'Set up authenticator app', exact: true }).click();
    const uri = await verify
        .getByRole('link', { name: 'Open in an authenticator app on this device' })
        .getAttribute('href'),
      secret = new URL(uri!).searchParams.get('secret')!;
    await verify
      .locator('form')
      .filter({ has: verify.getByRole('button', { name: 'Confirm and turn on', exact: true }) })
      .getByLabel('Verification code', { exact: true })
      .fill(totpCode(secret, Date.now() - 30000));
    await verify.getByRole('button', { name: 'Confirm and turn on', exact: true }).click();
    await expect(
      verify.getByRole('main').getByRole('status').filter({ hasText: 'Two-step sign-in is on.' }),
    ).toHaveText('Two-step sign-in is on.');
    await expect(page.getByLabel('Record name', { exact: true })).toHaveValue(
      'My retained record name',
    );
    await expect(form.locator('input[name="version"]')).toHaveValue(originalVersion);
    await page.getByRole('button', { name: 'Save record', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'My retained record name', exact: true }),
    ).toBeVisible();
    expect(
      await (await page.request.get(`${base}/object-records/${record.id}`)).json(),
    ).toMatchObject({ display_name: 'My retained record name', classification: 'internal' });
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
    const memberCreated = await other.request.post(`${base}/object-types/${type.id}/records`, {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: {
        display_name: 'Member-owned restricted record',
        attributes: {},
        classification: 'restricted',
      },
    });
    expect(memberCreated.status()).toBe(201);
    const memberRecord = await memberCreated.json();
    const memberLowering = await other.request.patch(`${base}/object-records/${memberRecord.id}`, {
      headers: { ...headers, 'if-match': memberCreated.headers()['etag'] ?? '' },
      data: { classification: 'internal' },
    });
    expect(memberLowering.status()).toBe(403);
    expect((await memberLowering.json()).code).toBe('FORBIDDEN');
    await other.goto(`/o/${world.organization}/objects/records/${memberRecord.id}`);
    await other.getByText('Edit record', { exact: true }).click();
    await expect(
      other
        .getByRole('group', { name: 'Who can see this', exact: true })
        .getByRole('radio', { name: /^Internal\b/ }),
    ).toHaveCount(0);
    await expect(
      other
        .getByRole('group', { name: 'Who can see this', exact: true })
        .getByRole('radio', { name: /^Restricted\b/ }),
    ).toBeChecked();
    expect((await page.request.get(`${base}/object-records/${memberRecord.id}`)).status()).toBe(
      404,
    );
  });
});
