// Actual native/HTTP export path, authored but not run at this source checkpoint. Ready means the
// real outbox/worker and M6 manifest proof completed; this test never edits export status or bytes.
import { generateKeyPairSync } from 'node:crypto';
import { expect, test } from '../support/fixtures';
import { createOrganization, join, signUp, BASE } from '../../helpers/forms';
import { setGeneratedAccountStanding } from '../../helpers/account-export';
import { axeFindings, sidewaysOverflow } from '../support/look';
/**
 * An account destination's link. Its accessible name is its label followed by its description (the whole
 * row is the link, see DestinationList), so it is found by how the name starts, never by the label alone.
 * No account label starts another, so the start is enough to tell them apart.
 */
const destination = (label: string) => ({ name: new RegExp(`^${label}`) });
const pair = () => {
  const keys = generateKeyPairSync('x25519');
  return {
    publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
};
test.describe('real account exports in paused service', () => {
  for (const javaScriptEnabled of [true, false])
    test(`a suspended owner requests and downloads an actual encrypted export (${javaScriptEnabled ? 'JavaScript' : 'no JavaScript'})`, async ({
      open,
    }) => {
      const owner = await signUp('Generated account export owner'),
        organization = await createOrganization(owner, 'Generated account export company'),
        member = await join(owner, organization, 'Generated account export member'),
        page = await open(owner, { javaScriptEnabled, width: 390 }),
        api = `/api/v1/organizations/${organization}`,
        keys = pair();
      await setGeneratedAccountStanding(organization, 'suspended');
      await page.goto(`/o/${organization}/account`);
      await expect(
        page.getByRole('heading', { name: 'Your organization is suspended', exact: true }),
      ).toBeVisible();
      await page.getByRole('link', destination('Export your data')).click();
      await expect(
        page.getByRole('heading', { name: 'Export your data', exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole('heading', { name: 'Import an archive', exact: true }),
      ).toHaveCount(0);
      await page.getByLabel('Public key', { exact: true }).fill(keys.privateKey);
      await page.getByRole('button', { name: 'Ask for an export', exact: true }).click();
      await expect(
        page.getByRole('alert').filter({ hasText: 'That looks like a private key' }),
      ).toBeVisible();
      await expect(page.getByLabel('Public key', { exact: true })).toHaveValue('');
      await page.getByLabel('Public key', { exact: true }).fill(keys.publicKey);
      await page.getByRole('button', { name: 'Ask for an export', exact: true }).click();
      await expect(
        page.getByRole('status').filter({ hasText: 'Your export has been asked for.' }),
      ).toBeVisible();
      const listed = await page.request.get(`${api}/exports`);
      expect(listed.status()).toBe(200);
      const rows = (await listed.json()).items;
      expect(rows).toHaveLength(1);
      const id = rows[0].id;
      await expect
        .poll(
          async () => {
            const response = await page.request.get(`${api}/exports/${id}`);
            expect(response.status()).toBe(200);
            const body = await response.json();
            if (body.status === 'failed')
              throw new Error(`GENERATED_REAL_EXPORT_FAILED:${body.failure_code ?? 'UNKNOWN'}`);
            return body.status;
          },
          { timeout: 180_000 },
        )
        .toBe('ready');
      await page.getByRole('link', { name: 'Refresh exports', exact: true }).click();
      const waiting = page.waitForEvent('download');
      await page.getByRole('link', { name: 'Download archive', exact: true }).click();
      const download = await waiting;
      expect(await download.failure()).toBeNull();
      expect(download.suggestedFilename()).toBe(`ensemus-export-${id}.tar`);
      for (const path of ['work-units', 'imports']) {
        const response =
          path === 'imports'
            ? await page.request.post(`${api}/${path}`, {
                headers: { origin: new URL(BASE).origin },
              })
            : await page.request.get(`${api}/${path}`);
        expect(response.status()).toBe(403);
        expect((await response.json()).code).toBe('TENANT_SUSPENDED');
      }
      await page.goto(`/o/${organization}/data`);
      await expect(page).toHaveURL(new RegExp(`/o/${organization}/account$`));
      const employee = await open(member, { javaScriptEnabled });
      await employee.goto(`/o/${organization}/account`);
      // The control first: the member does see the account page, with what a member may use.
      await expect(
        employee.getByRole('heading', { name: 'Your organization is suspended', exact: true }),
      ).toBeVisible();
      await expect(employee.getByRole('link', destination('Export your data'))).toHaveCount(0);
      await expect(employee.getByRole('link', destination('Leave Ensemus'))).toHaveCount(0);
      expect((await employee.goto(`/o/${organization}/account/exports`))?.status()).toBe(404);
      for (const suffix of ['', `/${id}`, `/${id}/archive`])
        expect((await employee.request.get(`${api}/exports${suffix}`)).status()).toBe(403);
      await page.goto(`/o/${organization}/account/exports`);
      expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(1);
      if (javaScriptEnabled) expect(await axeFindings(page)).toEqual([]);
    });
  test('account links use real destinations and hide owner controls from an administrator', async ({
    open,
    world,
  }) => {
    const owner = await open(world.alice);
    await owner.goto(`/o/${world.organization}/account`);
    const destinations = owner.getByRole('list', { name: 'Account destinations', exact: true });
    await expect(destinations.getByRole('link', destination('Leave Ensemus'))).toHaveAttribute(
      'href',
      `/o/${world.organization}/account/leave`,
    );
    await destinations.getByRole('link', destination('Leave Ensemus')).click();
    await expect(owner.getByRole('heading', { name: 'Leave Ensemus', exact: true })).toBeVisible();
    const admin = await open(world.carol);
    await admin.goto(`/o/${world.organization}/account`);
    await expect(admin.getByRole('link', destination('Billing and subscription'))).toBeVisible();
    await expect(admin.getByRole('link', destination('Export your data'))).toHaveCount(0);
    await expect(admin.getByRole('link', destination('Leave Ensemus'))).toHaveCount(0);
    expect((await admin.goto(`/o/${world.organization}/account/exports`))?.status()).toBe(404);
  });
});
