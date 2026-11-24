import { randomUUID } from 'node:crypto';
import {
  externalResourceAcl,
  externalResources,
  meetingImportRequests,
  openAppDatabase,
  withTenantTx,
} from '@ensemus/database';
import { approveMeetingProvider } from '@ensemus/application';
import { storeSecret } from '@ensemus/secrets/seal';
import { eq } from 'drizzle-orm';
import { BASE, createOrganization, signUp } from '../../helpers/forms';
import { enableMeetings, TEST_TERMS } from '../../helpers/expansion';
import { seedConnection } from '../../helpers/integrations';
import { nativePersonContext, proveSecondFactor } from '../../helpers/product';
import { secret, urls } from '../../helpers/stack';
import { expect, test } from '../support/fixtures';

for (const javaScriptEnabled of [true, false]) {
  test(`links a meeting source and requests a consented import with scripts ${javaScriptEnabled ? 'on' : 'off'}`, async ({
    open,
  }, testInfo) => {
    const app = openAppDatabase(urls.app());
    try {
      const owner = await signUp('Generated connected notes organizer');
      const org = await createOrganization(owner, 'Generated connected notes workspace');
      const session = await fetch(BASE + '/api/auth/get-session', {
        headers: { cookie: owner.jar.cookie },
      });
      expect(session.status).toBe(200);
      const { user, session: identity } = (await session.json()) as {
        user: { id: string };
        session: { id: string };
      };
      const signedIn = { userId: user.id, sessionId: identity.id };
      await proveSecondFactor(signedIn);
      const context = await nativePersonContext(app.db, signedIn, org);
      await enableMeetings(app.db, context);
      const sealed = await storeSecret(app.db, context, {
        publicKeyPem: secret('sealing_public_key.pem'),
        purpose: 'connector_credential',
        plaintext: 'GENERATED-BROWSER-NOTES-CREDENTIAL',
      });
      const connectionId = await seedConnection(app.db, context, {
        connectorType: 'meeting_notes_http',
        displayName: 'Generated notes adapter',
        credentialSecretId: sealed.secretRef,
      });
      const resourceId = randomUUID();
      await withTenantTx(app.db, context, async (tx) => {
        await tx.insert(externalResources).values({
          organizationId: org,
          id: resourceId,
          connectionId,
          stream: 'meetings.notes',
          resourceType: 'meetings.notes',
          externalId: 'generated-browser-note',
          displayName: 'Generated weekly design notes',
          classification: 'confidential',
          aclState: 'mapped',
        });
        await tx.insert(externalResourceAcl).values({
          organizationId: org,
          resourceId,
          principalKind: 'user',
          principalExternalId: 'generated-browser-member',
          access: 'read',
          membershipId: context.membershipId,
        });
      });
      const approval = await approveMeetingProvider(app.db, context, {
        kind: 'source',
        connectionId,
        maxClassification: 'confidential',
        termsRef: TEST_TERMS,
        expiresAt: new Date(Date.now() + 3_600_000),
      });

      const page = await open(owner, { javaScriptEnabled, width: javaScriptEnabled ? 1280 : 320 });
      await page.goto(`/o/${org}/meetings`);
      await page.getByText('New meeting', { exact: true }).click();
      await page.getByRole('combobox', { name: 'Notes source' }).selectOption(resourceId);
      await page
        .getByRole('textbox', { name: 'Meeting title' })
        .fill('Generated connected meeting');
      await page.locator('input[name="occurredAt"]').fill('2026-11-20T10:00');
      await page
        .locator('form:has(select[name="resourceId"])')
        .getByRole('button', { name: /Create|Start/ })
        .click();
      await expect(
        page.getByRole('heading', { name: 'Generated connected meeting' }),
      ).toBeVisible();
      expect(
        await page.locator('main').evaluate((main) => main.scrollWidth - main.clientWidth),
      ).toBeLessThanOrEqual(1);
      const notes = page.getByRole('region', { name: 'Notes', exact: true });
      await expect(notes.getByRole('button', { name: 'Import notes', exact: true })).toHaveCount(0);

      await page.getByRole('button', { name: 'I agree', exact: true }).click();
      await expect(notes.getByRole('button', { name: 'Import notes', exact: true })).toBeVisible();
      await notes.getByRole('combobox', { name: 'Source approval' }).selectOption(approval.id);
      await notes.getByRole('button', { name: 'Import notes', exact: true }).click();
      await expect(
        notes.getByRole('status').filter({ hasText: /Import queued|could not read the notes/ }),
      ).toBeVisible();
      const meetingId = new URL(page.url()).pathname.split('/').at(-1)!;
      const requested = await withTenantTx(app.db, context, (tx) =>
        tx
          .select()
          .from(meetingImportRequests)
          .where(eq(meetingImportRequests.meetingId, meetingId)),
      );
      expect(requested).toHaveLength(1);
      expect(requested[0]?.sourceApprovalId).toBe(approval.id);
      await notes.screenshot({ path: testInfo.outputPath('connected-notes.png') });
    } finally {
      await app.close();
    }
  });
}
