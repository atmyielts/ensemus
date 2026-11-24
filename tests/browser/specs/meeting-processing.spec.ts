import { openAppDatabase } from '@ensemus/database';
import { modelProfileRef } from '@ensemus/domain/meeting';
import { BASE, createOrganization, signUp } from '../../helpers/forms';
import { seedActiveProfile } from '../../helpers/ai/fixtures';
import {
  enableMeetings,
  seedDerivationRun,
  seedModelApproval,
  seedNotes,
  seedReadyMeeting,
} from '../../helpers/expansion';
import { nativePersonContext, proveSecondFactor } from '../../helpers/product';
import { urls } from '../../helpers/stack';
import { expect, test } from '../support/fixtures';

for (const javascript of [true, false]) {
  test(`queues approved meeting processing with scripts ${javascript ? 'on' : 'off'}`, async ({
    open,
  }, testInfo) => {
    const app = openAppDatabase(urls.app());
    const agent = openAppDatabase(urls.agent());
    try {
      const owner = await signUp('Generated processing organizer');
      const org = await createOrganization(owner, 'Generated processing workspace');
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
      const room = await seedReadyMeeting(app.db, context);

      // The generated room first has an approval with no usable profile. Display that state honestly.
      const page = await open(owner, {
        javaScriptEnabled: javascript,
        width: javascript ? 1280 : 320,
      });
      const path = `/o/${org}/meetings/${room.id}`;
      await page.goto(path);
      const region = page.getByRole('region', { name: 'Meeting processing' });
      await expect(
        region.getByText('A workspace administrator must approve', { exact: false }),
      ).toBeVisible();
      await expect(region.getByRole('button', { name: 'Queue request' })).toHaveCount(0);

      const profileId = await seedActiveProfile(app.db, agent.db, context, {
        alias: 'Approved model profile with a deliberately long name for the narrow workspace',
        allowedClasses: ['confidential'],
        allowedPurposes: ['compose', 'extract'],
      });
      const approval = await seedModelApproval(app.db, context, {
        targetRef: modelProfileRef(profileId),
      });
      await page.reload();
      const select = region.getByRole('combobox', { name: 'Result and provider' });
      const queue = region.getByRole('button', { name: 'Queue request' });
      await select.selectOption('summarize:' + approval);
      await expect(
        region.getByText('Send version 1 of these notes', { exact: false }),
      ).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);

      // Notes added in another session must not be sent by this older page.
      const currentNotesId = await seedNotes(app.db, context, {
        meetingId: room.id,
        version: 2,
        text: 'Generated second notes version',
      });
      await queue.click();
      await expect(region.getByRole('alert')).toBeVisible();
      await expect(
        region.getByText('Send version 2 of these notes', { exact: false }),
      ).toBeVisible();
      await expect(region.getByRole('list', { name: 'Recent processing requests' })).toHaveCount(0);

      const purpose = javascript ? 'extract_items' : 'summarize';
      await select.selectOption(purpose + ':' + approval);
      await queue.click();
      await expect(region.getByText('Request submitted.', { exact: true })).toBeVisible();
      const requests = region.getByRole('list', { name: 'Recent processing requests' });
      await expect(requests.getByRole('listitem')).toHaveCount(1);
      await expect(requests).toContainText(javascript ? 'Follow-up suggestions' : 'Summary');
      const assertFit = () =>
        page.evaluate(() => {
          const documentRoot = document.documentElement;
          const main = document.querySelector('.content > main');
          return (
            documentRoot.scrollWidth <= innerWidth + 1 &&
            (innerWidth >= 768 || (main !== null && main.scrollWidth <= main.clientWidth + 1))
          );
        });
      await expect.poll(assertFit).toBe(true);

      await seedDerivationRun(app.db, context, {
        meetingId: room.id,
        notesId: currentNotesId,
        providerApprovalId: approval,
        purpose: javascript ? 'summarize' : 'extract_items',
      });
      await page.reload();
      await region.getByRole('button', { name: 'Refresh status' }).click();
      await expect(requests.getByRole('listitem')).toHaveCount(2);
      await expect(requests.getByText('Queued', { exact: true }).first()).toBeVisible();
      await expect.poll(assertFit).toBe(true);
      await region.screenshot({ path: testInfo.outputPath('meeting-processing.png') });
    } finally {
      await Promise.all([app.close(), agent.close()]);
    }
  });
}
