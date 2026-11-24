import { updateSecurityPolicy } from '@ensemus/application/security-policy';
import { openAppDatabase } from '@ensemus/database';
import { nativePersonContext } from '../../helpers/product';
import { urls } from '../../helpers/stack';
import { randomUUID } from 'node:crypto';
import { createOrganization, signUp, BASE, type Person } from '../../helpers/forms';
import { proveSecondFactor } from '../../helpers/product';
import { expect, test } from '../support/fixtures';
const offered = (process.env.ENSEMUS_TEST_BUSINESS_CONNECTORS ?? '').split(',');
test.describe('business connection forms', () => {
  test.skip(
    !offered.includes('crm_http'),
    'Needs an explicitly operator-routed generated CRM adapter',
  );
  let owner: Person, org: string;
  test.beforeAll(async () => {
    owner = await signUp('Generated business form owner');
    org = await createOrganization(owner, 'Generated form setup');
    const who = (await (
      await fetch(BASE + '/api/auth/get-session', { headers: { cookie: owner.jar.cookie } })
    ).json()) as { user: { id: string }; session: { id: string } };
    await proveSecondFactor({ userId: who.user.id, sessionId: who.session.id });
  });
  for (const javaScriptEnabled of [true, false])
    test(`keeps safe choices and clears credentials after refusal (${javaScriptEnabled ? 'JavaScript' : 'native'})`, async ({
      open,
    }) => {
      const page = await open(owner, { javaScriptEnabled, width: 320 });
      await page.goto(`/o/${org}/connections`);
      const section = page.getByRole('region', { name: 'Connect CRM (adapter)', exact: true });
      await section.getByText('Set up connection', { exact: true }).click();
      const label = 'Generated browser connection ' + randomUUID();
      await section.getByLabel('Name', { exact: true }).fill(label);
      await section.getByLabel('Companies', { exact: true }).check();
      await section.getByLabel('Allow proposals for reviewed changes').check();
      await section.getByLabel('Adapter certificate name').fill('invalid certificate name');
      await section.getByLabel('Credential', { exact: false }).fill('GENERATED-PRIVATE-CREDENTIAL');
      await section.getByRole('button', { name: 'Add connection', exact: true }).click();
      await expect(section.getByRole('alert')).toContainText('Please check');
      await expect(section.getByLabel('Name', { exact: true })).toHaveValue(label);
      await expect(section.getByLabel('Companies', { exact: true })).toBeChecked();
      await expect(section.getByLabel('Allow proposals for reviewed changes')).toBeChecked();
      await expect(section.getByLabel('Credential', { exact: false })).toHaveValue('');
      await section.getByLabel('Adapter certificate name').fill('adapter.example.invalid');
      await section.getByLabel('Credential', { exact: false }).fill('GENERATED-PRIVATE-CREDENTIAL');
      await section.getByRole('button', { name: 'Add connection', exact: true }).click();
      await expect(
        section.getByRole('status').filter({ hasText: 'Connection added.' }),
      ).toContainText('Connection added.');
      await expect(page.getByRole('region', { name: 'Your company’s connections' })).toContainText(
        label,
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
    });
  test('asks for fresh identity proof before showing credential fields', async ({ open }) => {
    const person = await signUp('Generated unproved form owner'),
      own = await createOrganization(person, 'Generated unproved form');
    const who = (await (
      await fetch(BASE + '/api/auth/get-session', { headers: { cookie: person.jar.cookie } })
    ).json()) as { user: { id: string }; session: { id: string } };
    const identity = { userId: who.user.id, sessionId: who.session.id };
    await proveSecondFactor(identity);
    const web = openAppDatabase(urls.app());
    try {
      const context = await nativePersonContext(web.db, identity, own);
      await updateSecurityPolicy(
        web.db,
        context,
        { sessionId: identity.sessionId },
        {
          expectedVersion: 1,
          mfaForAdministration: true,
          mfaMaxAgeSeconds: 900,
          ssoEnforcement: 'optional',
        },
      );
    } finally {
      await web.close();
    }
    await proveSecondFactor(identity, new Date(Date.now() - 3600000));
    const page = await open(person);
    await page.goto(`/o/${own}/connections`);
    const section = page.getByRole('region', { name: 'Connect CRM (adapter)', exact: true });
    await expect(
      section.getByRole('link', { name: 'Verify your identity to set up this connection' }),
    ).toBeVisible();
    await expect(section.getByLabel('Credential', { exact: false })).toHaveCount(0);
  });
});
