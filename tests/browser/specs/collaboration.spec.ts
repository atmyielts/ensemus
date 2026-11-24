import { notifyFederationGrantAccepted } from '@ensemus/application';
import { openAppDatabase } from '@ensemus/database';
import { randomUUID } from 'node:crypto';
import { BASE, createOrganization, signUp } from '../../helpers/forms';
import { clearDeploymentProfile, setDeploymentProfile } from '../../helpers/federation';
import { contractProblems } from '../../helpers/openapi';
import { urls } from '../../helpers/stack';
import { expect, test } from '../support/fixtures';
import { axeFindings, sidewaysOverflow } from '../support/look';

const operatorEnabled = process.env.ENSEMUS_TEST_FEDERATION_ENABLED === 'true';
const apiBase = (org: string) => '/api/v1/organizations/' + org + '/federation';
const pagePath = (org: string) => '/o/' + org + '/collaboration';

test('a deployment with collaboration off refuses the routes before requiring sign-in', async ({
  open,
}) => {
  test.skip(operatorEnabled, 'Requires the default operator configuration');
  const page = await open(null);
  const org = randomUUID();
  expect((await page.request.get(apiBase(org) + '/settings')).status()).toBe(404);
  const owner = await signUp('Generated owner on a default deployment');
  const organization = await createOrganization(owner, 'Default workspace');
  const signedIn = await open(owner);
  await signedIn.goto('/o/' + organization + '/settings');
  await expect(signedIn.getByRole('link', { name: /^Collaboration/ })).toHaveCount(0);
  await signedIn.goto(pagePath(organization));
  await expect(signedIn.getByRole('heading', { name: 'Collaboration', exact: true })).toHaveCount(
    0,
  );
});

for (const javaScriptEnabled of [true, false]) {
  test(
    'both owners consent and revoke on a phone with scripts ' + (javaScriptEnabled ? 'on' : 'off'),
    async ({ open }) => {
      test.skip(
        !operatorEnabled,
        'Requires an isolated preview with collaboration enabled by the operator',
      );
      const sharing = await signUp('Generated sharing owner');
      const receiving = await signUp('Generated receiving owner');
      const outsider = await signUp('Generated outside owner');
      const sharingId = await createOrganization(sharing, 'Sharing workspace');
      const receivingId = await createOrganization(receiving, 'Receiving workspace');
      const outsiderId = await createOrganization(outsider, 'Other workspace');
      const sender = await open(sharing, { width: 320, javaScriptEnabled });
      const recipient = await open(receiving, {
        width: 320,
        javaScriptEnabled: false,
        colorScheme: 'dark',
      });
      const other = await open(outsider);
      await setDeploymentProfile({ crossOrgEnabled: true });
      try {
        await sender.goto('/o/' + sharingId + '/settings');
        await sender.getByRole('link', { name: /^Collaboration/ }).click();
        await recipient.goto(pagePath(receivingId));
        for (const page of [sender, recipient]) {
          await page.getByRole('button', { name: 'Enable collaboration' }).click();
          await expect(page.getByText('Collaboration updated.')).toBeVisible();
        }
        await sender.getByRole('button', { name: 'Create invitation', exact: true }).click();
        const tokenField = sender.getByRole('textbox', { name: 'Invitation token' });
        await expect(tokenField).toBeVisible();
        const token = await tokenField.inputValue();
        expect(token).toMatch(/^[a-zA-Z0-9_-]{43}$/);
        expect(sender.url()).not.toContain(token);
        expect(await sidewaysOverflow(sender)).toBeLessThanOrEqual(1);

        await recipient.getByLabel('Token from the other organization').fill(token);
        await recipient.getByRole('button', { name: 'Review invitation', exact: true }).click();
        const review = recipient.getByRole('region', { name: 'Review invitation' });
        await expect(review.getByRole('heading', { name: 'Sharing workspace' })).toBeVisible();
        await expect(review.getByText('Grant expires', { exact: true })).toBeVisible();
        expect(recipient.url()).not.toContain(token);
        const consent = review.locator('details.confirm');
        await consent.locator('summary').click();
        await consent.getByRole('checkbox').check();
        await consent.getByRole('button', { name: 'Accept invitation' }).click();
        await expect(recipient.getByText('Awaiting confirmation')).toBeVisible();
        expect(await sidewaysOverflow(recipient)).toBeLessThanOrEqual(1);
        expect(await axeFindings(recipient)).toEqual([]);

        const acceptedList = await recipient.request.get(apiBase(receivingId) + '/grants');
        const acceptedId = (await acceptedList.json()).items[0].id as string;
        const worker = openAppDatabase(urls.worker());
        try {
          await notifyFederationGrantAccepted(worker.db, {
            organizationId: receivingId,
            grantId: acceptedId,
          });
        } finally {
          await worker.close();
        }
        await sender.goto('/o/' + sharingId + '/inbox');
        await sender
          .getByRole('button', { name: 'A collaboration invitation was accepted' })
          .click();
        await expect(sender).toHaveURL(pagePath(sharingId) + '#grant-' + acceptedId);
        await expect(sender.locator('#grant-' + acceptedId)).toBeVisible();
        await expect(tokenField).toHaveCount(0);
        const confirmation = sender
          .locator('details.confirm')
          .filter({ hasText: 'Confirm recipient' });
        await confirmation.locator('summary').click();
        await confirmation.getByRole('checkbox').check();
        await confirmation.getByRole('button', { name: 'Activate grant' }).click();
        await expect(sender.getByText('Active', { exact: true })).toBeVisible();

        const api = apiBase(sharingId) + '/grants';
        const response = await sender.request.get(api);
        const text = await response.text();
        const grantId = JSON.parse(text).items[0].id as string;
        expect(text).not.toContain(token);
        expect(response.headers()['cache-control']).toBe('private, no-store');
        expect(
          contractProblems({
            method: 'GET',
            path: api,
            status: response.status(),
            headers: new Headers(response.headers()),
            text,
          }).problems,
        ).toEqual([]);
        expect((await other.request.get(apiBase(outsiderId) + '/grants/' + grantId)).status()).toBe(
          404,
        );

        await recipient.reload();
        const end = recipient.locator('details.confirm').filter({ hasText: 'Revoke grant' });
        await end.locator('summary').click();
        await end.getByRole('checkbox').check();
        await end.getByRole('button', { name: 'Revoke grant' }).click();
        await expect(recipient.getByText('Ended', { exact: true })).toBeVisible();

        const data = {
          purpose: 'document_review',
          max_classification: 'internal',
          expires_in_days: 5,
          invitation_expires_in_days: 2,
        };
        const headers = { origin: BASE, 'Idempotency-Key': randomUUID() };
        const created = await sender.request.post(api, { data, headers });
        expect(created.status()).toBe(201);
        const createdText = await created.text();
        expect(
          contractProblems({
            method: 'POST',
            path: api,
            status: 201,
            headers: new Headers(created.headers()),
            text: createdText,
          }).problems,
        ).toEqual([]);
        const createdToken = JSON.parse(createdText).token;
        const duplicate = await sender.request.post(api, { data, headers });
        expect(duplicate.status()).toBe(409);
        expect(await duplicate.text()).not.toContain(createdToken);
        expect((await (await sender.request.get(api)).json()).items).toHaveLength(2);
        const acceptance = apiBase(receivingId) + '/invitations/acceptance';
        const acceptanceHeaders = { origin: BASE, 'Idempotency-Key': randomUUID() };
        const acceptanceBody = {
          token: createdToken,
          terms_hash: JSON.parse(createdText).grant.terms_hash,
        };
        const accepted = await recipient.request.post(acceptance, {
          data: acceptanceBody,
          headers: acceptanceHeaders,
        });
        expect(accepted.status()).toBe(201);
        const replay = await recipient.request.post(acceptance, {
          data: acceptanceBody,
          headers: acceptanceHeaders,
        });
        expect(replay.status()).toBe(201);
        expect(await replay.json()).toEqual(await accepted.json());
      } finally {
        await clearDeploymentProfile();
      }
    },
  );
}
