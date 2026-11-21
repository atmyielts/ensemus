// M3's exit, on real containers: Slice 2, QA-007, QA-008, QA-019 and AI-TS-01, with fault injection at
// timeout-after-send (ADR-027). The sink stands in for a mail relay, and a message it took really went
// through the connector worker, the gateway and the second network. It runs only with the `connectors`
// profile on, which CI's `connectors` job turns on, and it skips in the rounds without it.
import { randomUUID } from 'node:crypto';
import { Client, Connection } from '@temporalio/client';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { externalActionTargetRef } from '@ensemus/domain/integration-events';
import { OAUTH_BROWSER_COOKIE } from '@ensemus/domain/workspace-suites';
import { externalActionWorkflowIdFor } from '@ensemus/workflows/schemas';
import {
  BASE,
  createOrganization,
  formOn,
  join,
  type Person,
  post,
  read,
  signUp,
  submit,
} from '../helpers/forms';
import { locationOf, mainOf, membershipOf, move, sectionOf, workPage } from '../helpers/flows';
import { inFixtureTenant } from '../helpers/fixture-tenant';
import {
  contractProblems,
  operationName,
  operations,
  validatedOperations,
} from '../helpers/openapi';
import {
  actionPage,
  actionsOnWork,
  AFTER_DEADLINE,
  AFTER_KILL,
  aCanary,
  anAddress,
  anEmail,
  api,
  approvalPage,
  approveOnPage,
  attemptsOf,
  connectors,
  connectorsEnabled,
  createReceiptWork,
  deliveriesOf,
  dumpApplicationDatabase,
  dumpTemporal,
  type ExternalActionSummary,
  holds,
  killConnectorWorker,
  newEndpoint,
  notificationsFor,
  paths,
  postWebhook,
  proposalEnvelope,
  propose,
  readAction,
  resolve,
  RUN,
  serviceLogs,
  setUpTenant,
  signedRequest,
  sink,
  sleep,
  statusOf,
  tablesHolding,
  type Tenant,
} from '../helpers/slice-2';
import { urls } from '../helpers/stack';

const TEMPORAL = '127.0.0.1:57233';
const UNKNOWN_WORDS = /don.{1,8}t know whether this was sent/i;
const ACCEPTED_WORDS = /mail server accepted/i;

describe.skipIf(!connectorsEnabled())('Slice 2 and the M3 exit', () => {
  let su: pg.Client;
  let temporalConnection: Connection;
  let temporal: Client;
  let tenant: Tenant;
  let rival: Tenant;
  let reviewer: Person;
  let reviewerId: string;
  let ownerId: string;

  const page = (id: string) => workPage(tenant.organization, id);
  const newWork = (label: string) =>
    createReceiptWork(tenant.owner, tenant.organization, `${label} ${randomUUID()}`);

  /** Proposed by the owner and decided by someone else, as the rules need. */
  async function proposeFor(work: string, to: string[], overrides = {}) {
    return propose(tenant.owner, tenant.organization, work, {
      connection: tenant.mail.id,
      approver: reviewerId,
      email: anEmail(to, overrides),
    });
  }

  beforeAll(async () => {
    // If the job meant to run this has no worker, that is a failure and not a quiet skip.
    expect(connectors('ps', '-q', 'connector-worker').trim()).not.toBe('');
    expect(connectors('ps', '-q', 'egress-gateway').trim()).not.toBe('');
    su = new pg.Client({ connectionString: urls.superuser() });
    await su.connect();
    temporalConnection = await Connection.connect({ address: TEMPORAL });
    temporal = new Client({ connection: temporalConnection, namespace: 'default' });
    tenant = await setUpTenant('Slice');
    rival = await setUpTenant('Rival');
    reviewer = await join(tenant.owner, tenant.organization, 'Remy Reviewer');
    reviewerId = await membershipOf(su, reviewer, tenant.organization);
    ownerId = await membershipOf(su, tenant.owner, tenant.organization);
  });

  beforeEach(() => sink.setMode('accept'));

  afterAll(async () => {
    await su?.end();
    await temporalConnection?.close();
  });

  describe('the slice', () => {
    it('goes from a signed callback to a receipt, one message, and work that can finish', async () => {
      // A Work Unit with an external_receipt criterion, on a stack with a connection that can act.
      const work = await newWork('Tell the client');
      await move(tenant.owner, tenant.organization, work, 'ready', 'running', 'verifying');
      const waiting = await read(page(work), tenant.owner.jar);
      expect(sectionOf(waiting.html, 'verification-heading')).toContain('Still needed');
      expect(mainOf(waiting.html)).not.toContain('>Mark done<');

      // A signed external_action.proposed goes to the endpoint. The answer says nothing at all.
      const to = anAddress('to');
      const cc = anAddress('cc');
      const bcc = anAddress('bcc');
      const subject = `Your report ${randomUUID()}`;
      const text = `The report is ready. ${randomUUID()}`;
      const endpoint = await newEndpoint(tenant.owner, tenant.organization, tenant.inbound.id);
      const posted = await postWebhook(
        endpoint.token,
        signedRequest(
          endpoint.secret,
          proposalEnvelope(work, tenant.mail.id, {
            to: [to],
            cc: [cc],
            bcc: [bcc],
            subject,
            text_body: text,
          }),
        ),
      );
      expect(posted).toEqual({ status: 202, text: '' });

      // The worker verifies it later, and an intent waits for a person. Nothing has gone anywhere.
      await expect
        .poll(async () => (await deliveriesOf(su, endpoint.id)).map((d) => d.state), RUN)
        .toEqual(['applied']);
      expect((await deliveriesOf(su, endpoint.id))[0]?.bodyGone).toBe(true);
      await expect.poll(async () => (await actionsOnWork(su, work)).length, RUN).toBe(1);
      const [proposed] = await actionsOnWork(su, work);
      if (!proposed) throw new Error('No intent');
      expect(proposed.status).toBe('awaiting_approval');
      expect(await sink.messagesTo(to)).toEqual([]);

      // The owner approves exactly what is shown, and what is shown is what the approval binds.
      const { action: intent } = await readAction(tenant.owner, tenant.organization, proposed.id);
      const approval = intent.approval_id;
      if (!approval) throw new Error('No approval on the intent');
      const shown = mainOf(
        (await read(approvalPage(tenant.organization, approval), tenant.owner.jar)).html,
      );
      for (const expected of [to, cc, bcc, subject, text, tenant.mail.fromAddress]) {
        expect(shown).toContain(expected);
      }
      const bound = await api(tenant.owner, 'GET', paths.approval(tenant.organization, approval));
      expect(bound.status).toBe(200);
      expect((bound.json as { action_hash: string }).action_hash).toBe(intent.request_hash);
      await approveOnPage(tenant.owner, tenant.organization, approval);

      // The dispatcher starts the workflow, an attempt is recorded, and the sink takes one message.
      await expect.poll(async () => (await statusOf(su, proposed.id))?.status, RUN).toBe('sent');
      expect(await attemptsOf(su, proposed.id)).toEqual([
        { attemptNo: 1, outcome: 'accepted', code: 'ACCEPTED_BY_RELAY' },
      ]);
      const delivered = await sink.messagesTo(to);
      expect(delivered).toHaveLength(1);
      const [message] = delivered;
      if (!message) throw new Error('No message');
      expect(message.mailFrom).toBe(tenant.mail.fromAddress);
      expect([...message.rcptTo].sort()).toEqual([to, cc, bcc].sort());
      expect(message.raw).toContain(subject);
      expect(message.raw).toContain(text);
      expect(message.raw).toContain(`<${proposed.id}@`);
      // Bcc is in the envelope, as it must be, and in no header anyone else can read.
      expect(message.raw).not.toContain(bcc);

      // A receipt on the page, saying what it means and on whose word.
      const { action: sent } = await readAction(tenant.owner, tenant.organization, proposed.id);
      expect(sent.status).toBe('sent');
      expect(sent.receipts.map((receipt) => [receipt.outcome, receipt.basis])).toEqual([
        ['sent', 'provider'],
      ]);
      expect(sent.can_resolve).toBe(false);
      const receiptPage = mainOf(
        (await read(actionPage(tenant.organization, proposed.id), tenant.owner.jar)).html,
      );
      expect(receiptPage).toMatch(ACCEPTED_WORDS);
      expect(receiptPage).toContain(`${proposed.id}@`);
      expect(receiptPage).not.toMatch(UNKNOWN_WORDS);

      // The criterion is met, and the owner completes the work.
      const met = await read(page(work), tenant.owner.jar);
      expect(sectionOf(met.html, 'verification-heading')).not.toContain('Still needed');
      await move(tenant.owner, tenant.organization, work, 'completed');
      const { rows } = await su.query('select status from work.work_units where id = $1', [work]);
      expect(rows[0].status).toBe('completed');
      // Finished is finished: nothing else went out through all of that.
      expect(await sink.messagesTo(to)).toHaveLength(1);
    }, 240_000);
  });

  describe('QA-008: the relay takes the message and then says nothing', () => {
    it('sends once, ends unknown, tells the owner, says so, and lets them say what they found', async () => {
      await sink.setMode('accept_then_silent');
      const member = await join(tenant.owner, tenant.organization, 'Asha Assigned');
      const work = await newWork('Timeout after send');
      await submit(page(work), tenant.owner.jar, /Add someone/, {
        membershipId: await membershipOf(su, member, tenant.organization),
      });
      const to = anAddress('silent');
      const { id, approval_id: approval } = await proposeFor(work, [to]);
      const before = await sink.stats();
      await approveOnPage(reviewer, tenant.organization, approval);

      // The sink has it. The client cannot know that, so past its deadline it is unknown.
      await expect.poll(async () => (await sink.messagesTo(to)).length, RUN).toBe(1);
      await expect
        .poll(async () => (await statusOf(su, id))?.status, AFTER_DEADLINE)
        .toBe('unknown');
      const [attempt, ...others] = await attemptsOf(su, id);
      expect(others).toEqual([]);
      expect(attempt?.outcome).toBe('indeterminate');
      expect(['TIMEOUT_AFTER_COMMIT', 'CONNECTION_LOST_AFTER_COMMIT']).toContain(attempt?.code);

      // A long wait, well past any retry the send could have had, adds nothing.
      await sleep(60_000);
      expect(await sink.messagesTo(to)).toHaveLength(1);
      expect(await sink.stats()).toEqual({
        received: before.received + 1,
        connections: before.connections + 1,
      });
      expect(await attemptsOf(su, id)).toHaveLength(1);
      expect((await statusOf(su, id))?.status).toBe('unknown');
      const closed = await temporal.workflow
        .getHandle(
          externalActionWorkflowIdFor({
            organizationId: tenant.organization,
            externalActionId: id,
          }),
        )
        .describe();
      expect(closed.status.name).toBe('COMPLETED');

      // The owner is told, in their inbox, as soon as nobody knows.
      expect(await notificationsFor(su, ownerId, externalActionTargetRef(id))).toContain(
        'external_action.unknown',
      );
      const inbox = await read(`/o/${tenant.organization}/inbox`, tenant.owner.jar);
      expect(inbox.html).toContain(`/external-actions/${id}`);

      // The page says it plainly, with what to search for. It is neither sent nor failed.
      const shown = mainOf(
        (await read(actionPage(tenant.organization, id), tenant.owner.jar)).html,
      );
      expect(shown).toMatch(UNKNOWN_WORDS);
      expect(shown).toContain(`${id}@`);
      expect(shown).not.toMatch(ACCEPTED_WORDS);
      expect(shown).not.toMatch(/>\s*(send|send again|retry|ask again)\s*</i);
      const { action: unknown } = await readAction(tenant.owner, tenant.organization, id);
      expect(unknown.status).toBe('unknown');
      expect(unknown.can_resolve).toBe(true);
      expect(unknown.can_retry).toBe(false);

      // Denied: someone assigned sees it and cannot answer for it, and another tenant sees nothing.
      const { action: asMember, etag } = await readAction(member, tenant.organization, id);
      expect(asMember.can_resolve).toBe(false);
      const body = { resolution: 'confirmed_sent', reason: 'I looked' };
      const refused = await api(member, 'POST', paths.resolution(tenant.organization, id), {
        body,
        ifMatch: etag,
      });
      expect(refused.status).toBe(403);
      const elsewhere = await api(rival.owner, 'POST', paths.resolution(tenant.organization, id), {
        body,
        ifMatch: etag,
      });
      expect(elsewhere.status).toBe(404);
      expect((await statusOf(su, id))?.status).toBe('unknown');

      // They resolve it. The record names them, it is shown as their word, and it sends nothing.
      const reason = `Found it in the relay's log ${randomUUID()}`;
      const resolved = await resolve(tenant.owner, tenant.organization, id, {
        resolution: 'confirmed_sent',
        reason,
      });
      expect(resolved.status).toBe('sent');
      expect(resolved.resolution).toBe('confirmed_sent');
      expect(resolved.resolution_reason).toBe(reason);
      expect(resolved.resolved_by_name).toBe(tenant.owner.name);
      expect(resolved.receipts.find((receipt) => receipt.basis === 'person')).toMatchObject({
        outcome: 'sent',
        actor_name: tenant.owner.name,
      });
      const { rows } = await su.query(
        `select resolved_by_membership_id as resolver from integrations.external_actions where id = $1`,
        [id],
      );
      expect(rows[0].resolver).toBe(ownerId);
      const after = mainOf(
        (await read(actionPage(tenant.organization, id), tenant.owner.jar)).html,
      );
      // The earlier unknown stays in the receipts, as history. The status is what has changed.
      expect(after).toContain(`Sent: confirmed by ${tenant.owner.name}`);
      // A person's reason stays with the work. It goes in no event, audit row or log.
      expect(await tablesHolding(su, reason)).toEqual([]);
      expect(await sink.messagesTo(to)).toHaveLength(1);
    }, 420_000);
  });

  describe('AI-TS-01: the worker dies while the relay is silent', () => {
    it('still ends with one message, unknown, and asking again takes a new approval', async () => {
      await sink.setMode('accept_then_silent');
      const work = await newWork('A worker dying');
      const to = anAddress('killed');
      const { id, approval_id: approval, request_hash: hash } = await proposeFor(work, [to]);
      const before = await sink.stats();
      await approveOnPage(reviewer, tenant.organization, approval);

      // The relay has it, and no outcome is recorded: this is the moment nobody can recover from.
      await expect.poll(async () => (await sink.messagesTo(to)).length, RUN).toBe(1);
      expect(await attemptsOf(su, id)).toEqual([{ attemptNo: 1, outcome: null, code: null }]);
      expect((await statusOf(su, id))?.status).toBe('sending');

      try {
        expect(killConnectorWorker()).toBe('137');
      } finally {
        connectors('start', 'connector-worker');
      }

      // Temporal gives up on the Activity, the workflow looks instead of retrying, and it stops.
      await expect.poll(async () => (await statusOf(su, id))?.status, AFTER_KILL).toBe('unknown');
      const attempts = await attemptsOf(su, id);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.outcome).toBe('indeterminate');
      expect(await sink.messagesTo(to)).toHaveLength(1);
      // Nothing from the worker that came back so much as connected.
      expect(await sink.stats()).toEqual({
        received: before.received + 1,
        connections: before.connections + 1,
      });
      expect(await notificationsFor(su, ownerId, externalActionTargetRef(id))).toContain(
        'external_action.unknown',
      );

      // A person says it did not go. It ends failed, and only a new approval can send it again.
      const failed = await resolve(tenant.owner, tenant.organization, id, {
        resolution: 'confirmed_not_sent',
        reason: 'Not in the relay log',
      });
      expect(failed.status).toBe('failed');
      expect(failed.can_retry).toBe(true);
      const retry = await api(tenant.owner, 'POST', paths.retries(tenant.organization, id), {
        body: { approver_membership_id: reviewerId },
      });
      expect(retry.status, retry.text).toBe(201);
      const asked = retry.json as { id: string; approval_id: string; request_hash: string };
      expect(asked.id).not.toBe(id);
      expect(asked.approval_id).not.toBe(approval);
      expect(asked.request_hash).toBe(hash);
      expect((await statusOf(su, asked.id))?.status).toBe('awaiting_approval');
      const rows = await actionsOnWork(su, work);
      expect(rows.find((row) => row.id === asked.id)?.retryOfId).toBe(id);
      await sleep(5_000);
      expect(await sink.messagesTo(to)).toHaveLength(1);
    }, 480_000);
  });

  describe('QA-007: recipients change after approval', () => {
    it('leaves the old one unable to send, and only the new recipients ever get anything', async () => {
      const work = await newWork('A changed recipient');
      const before = anAddress('before');
      const after = anAddress('after');
      const { id: old, approval_id: oldApproval } = await proposeFor(work, [before]);

      // With no connector worker, the approved action waits at the send, and no timing is involved.
      connectors('stop', 'connector-worker');
      let replacement: { id: string; approval_id: string; request_hash: string };
      try {
        await approveOnPage(reviewer, tenant.organization, oldApproval);
        expect((await statusOf(su, old))?.status).toBe('ready');
        const { action: approved, etag } = await readAction(tenant.owner, tenant.organization, old);

        const revised = await api(tenant.owner, 'POST', paths.revisions(tenant.organization, old), {
          body: { approver_membership_id: reviewerId, email: anEmail([after]) },
          ifMatch: etag,
        });
        expect(revised.status, revised.text).toBe(201);
        replacement = revised.json as typeof replacement;
        expect(replacement.id).not.toBe(old);
        expect(replacement.approval_id).not.toBe(oldApproval);
        expect(replacement.request_hash).not.toBe(approved.request_hash);

        // The old decision is spent, the old intent is closed, and the new one needs its own.
        expect(await statusOf(su, old)).toEqual({ status: 'cancelled', reason: 'SUPERSEDED' });
        const oldApprovalNow = await api(
          tenant.owner,
          'GET',
          paths.approval(tenant.organization, oldApproval),
        );
        expect((oldApprovalNow.json as { status: string }).status).toBe('cancelled');
        const rows = await actionsOnWork(su, work);
        expect(rows.find((row) => row.id === replacement.id)).toMatchObject({
          status: 'awaiting_approval',
          supersedesId: old,
        });
      } finally {
        connectors('start', 'connector-worker');
      }

      // The worker comes back and picks up the old run, which finds it closed and contacts nobody.
      const workflowId = externalActionWorkflowIdFor({
        organizationId: tenant.organization,
        externalActionId: old,
      });
      await expect
        .poll(
          async () => (await temporal.workflow.getHandle(workflowId).describe()).status.name,
          AFTER_DEADLINE,
        )
        .toBe('COMPLETED');
      expect(await attemptsOf(su, old)).toEqual([]);
      expect(await sink.messagesTo(before)).toEqual([]);
      expect(await sink.messagesTo(after)).toEqual([]);

      // Only the new approval sends, and only to who it names.
      await approveOnPage(reviewer, tenant.organization, replacement.approval_id);
      await expect.poll(async () => (await statusOf(su, replacement.id))?.status, RUN).toBe('sent');
      expect(await sink.messagesTo(after)).toHaveLength(1);
      expect(await sink.messagesTo(before)).toEqual([]);
      expect((await statusOf(su, old))?.status).toBe('cancelled');
    }, 360_000);
  });

  describe('QA-019: replaying a callback', () => {
    it('makes one intent, whichever way it is replayed', async () => {
      const work = await newWork('A replayed callback');
      const to = anAddress('replayed');
      const endpoint = await newEndpoint(tenant.owner, tenant.organization, tenant.inbound.id);
      const envelope = proposalEnvelope(work, tenant.mail.id, anEmail([to]));
      const eventId = `event-${randomUUID()}`;
      const now = Math.floor(Date.now() / 1000);
      const original = signedRequest(endpoint.secret, envelope, { eventId, timestampSeconds: now });
      const accepted = { status: 202, text: '' };

      expect(await postWebhook(endpoint.token, original)).toEqual(accepted);
      await expect
        .poll(async () => (await deliveriesOf(su, endpoint.id)).map((d) => d.state), RUN)
        .toEqual(['applied']);
      expect(await actionsOnWork(su, work)).toHaveLength(1);

      // The same request: the same answer at the door, and nothing stored.
      expect(await postWebhook(endpoint.token, original)).toEqual(accepted);
      expect(await deliveriesOf(su, endpoint.id)).toHaveLength(1);

      // A valid signature from outside the window: stored, then refused, and the bytes go.
      const old = signedRequest(endpoint.secret, envelope, {
        eventId,
        timestampSeconds: now - 3600,
      });
      expect(await postWebhook(endpoint.token, old)).toEqual(accepted);
      await expect
        .poll(async () => (await deliveriesOf(su, endpoint.id))[1], RUN)
        .toEqual({ state: 'rejected', rejectCode: 'TIMESTAMP_OUTSIDE_WINDOW', bodyGone: true });

      // A new request inside the window, with an event ID already applied: a duplicate.
      const repeated = signedRequest(endpoint.secret, envelope, {
        eventId,
        timestampSeconds: now + 1,
      });
      expect(await postWebhook(endpoint.token, repeated)).toEqual(accepted);
      await expect
        .poll(async () => (await deliveriesOf(su, endpoint.id))[2], RUN)
        .toEqual({ state: 'duplicate', rejectCode: null, bodyGone: true });

      // Still one intent, still waiting for a person, and nothing has been sent by any of this.
      const actions = await actionsOnWork(su, work);
      expect(actions).toHaveLength(1);
      expect(actions[0]?.status).toBe('awaiting_approval');
      expect(await sink.messagesTo(to)).toEqual([]);
    }, 240_000);
  });

  describe('denied', () => {
    it('refuses an unsigned post, a wrong signature, an altered body, and an unknown address', async () => {
      const work = await newWork('Callbacks that fail');
      const to = anAddress('forged');
      const endpoint = await newEndpoint(tenant.owner, tenant.organization, tenant.inbound.id);
      const envelope = proposalEnvelope(work, tenant.mail.id, anEmail([to]));
      const accepted = { status: 202, text: '' };

      // The caller hears the same whatever they sent, and learns nothing about signatures.
      const valid = signedRequest(endpoint.secret, envelope);
      const unsigned = { ...valid.headers };
      delete unsigned['x-ensemus-signature'];
      expect(await postWebhook(endpoint.token, { body: valid.body, headers: unsigned })).toEqual(
        accepted,
      );
      const wrongKey = signedRequest(randomUUID(), envelope);
      expect(await postWebhook(endpoint.token, wrongKey)).toEqual(accepted);
      const altered = signedRequest(endpoint.secret, envelope);
      expect(
        await postWebhook(endpoint.token, {
          headers: altered.headers,
          body: Buffer.from(JSON.stringify({ ...envelope, work_unit_id: randomUUID() })),
        }),
      ).toEqual(accepted);

      await expect
        .poll(
          async () => (await deliveriesOf(su, endpoint.id)).filter((d) => d.state !== 'received'),
          RUN,
        )
        .toHaveLength(3);
      expect(
        (await deliveriesOf(su, endpoint.id)).map((d) => [d.state, d.rejectCode, d.bodyGone]),
      ).toEqual([
        ['rejected', 'SIGNATURE_MISSING', true],
        ['rejected', 'BAD_SIGNATURE', true],
        ['rejected', 'BAD_SIGNATURE', true],
      ]);
      expect(await actionsOnWork(su, work)).toEqual([]);

      // An unknown address is a bare 404, the same as one that never existed.
      const unknown = await postWebhook(randomUUID(), valid);
      expect(unknown).toEqual({ status: 404, text: '' });
    }, 180_000);

    it("does nothing for another tenant's token, however well it is signed", async () => {
      const work = await newWork('Named by a stranger');
      const to = anAddress('stranger');
      const theirs = await newEndpoint(rival.owner, rival.organization, rival.inbound.id);

      // Correctly signed, with the rival's own secret and token, and naming this tenant's work.
      const posted = await postWebhook(
        theirs.token,
        signedRequest(theirs.secret, proposalEnvelope(work, tenant.mail.id, anEmail([to]))),
      );
      expect(posted).toEqual({ status: 202, text: '' });
      await expect
        .poll(async () => (await deliveriesOf(su, theirs.id))[0]?.state, RUN)
        .toBe('rejected');
      expect((await deliveriesOf(su, theirs.id))[0]?.bodyGone).toBe(true);
      expect(await actionsOnWork(su, work)).toEqual([]);

      // A rival's secret on this tenant's address proves nothing either.
      const ours = await newEndpoint(tenant.owner, tenant.organization, tenant.inbound.id);
      await postWebhook(
        ours.token,
        signedRequest(theirs.secret, proposalEnvelope(work, tenant.mail.id, anEmail([to]))),
      );
      await expect
        .poll(async () => (await deliveriesOf(su, ours.id))[0], RUN)
        .toEqual({ state: 'rejected', rejectCode: 'BAD_SIGNATURE', bodyGone: true });
      expect(await actionsOnWork(su, work)).toEqual([]);
      expect(await sink.messagesTo(to)).toEqual([]);
    }, 180_000);

    it('shows a member of another tenant nothing, by any path', async () => {
      const work = await newWork('Not for them');
      const subject = `Private ${randomUUID()}`;
      const { id, approval_id: approval } = await proposeFor(work, [anAddress('private')], {
        subject,
      });
      const org = tenant.organization;
      const stranger = await signUp('Sam Stranger');
      const strangerOrg = await createOrganization(stranger, `Elsewhere ${randomUUID()}`);

      // Control: the same paths answer for someone who may read them.
      expect((await api(tenant.owner, 'GET', paths.action(org, id))).status).toBe(200);
      expect((await read(actionPage(org, id), tenant.owner.jar)).status).toBe(200);
      expect((await read(actionPage(org, id), tenant.owner.jar)).html).toContain(subject);

      for (const person of [rival.owner, stranger]) {
        const home = person === stranger ? strangerOrg : rival.organization;
        // By this tenant's address.
        for (const path of [
          paths.action(org, id),
          paths.actions(org),
          paths.connections(org),
          paths.connection(org, tenant.mail.id),
          paths.approval(org, approval),
        ]) {
          const answer = await api(person, 'GET', path);
          expect(answer.status, path).toBe(404);
          expect(answer.text).not.toContain(subject);
        }
        // And by their own, with this tenant's IDs.
        for (const path of [paths.action(home, id), paths.approval(home, approval)]) {
          expect((await api(person, 'GET', path)).status, path).toBe(404);
        }
        const listed = await api(person, 'GET', paths.actions(home));
        expect(listed.status).toBe(200);
        const items = (listed.json as { items: ExternalActionSummary[] }).items;
        expect(items.map((item) => item.id)).not.toContain(id);
        for (const path of [
          actionPage(org, id),
          actionPage(home, id),
          approvalPage(org, approval),
          approvalPage(home, approval),
          `/o/${org}/external-actions`,
          `/o/${org}/connections`,
        ]) {
          const shown = await read(path, person.jar);
          expect(shown.status, path).toBe(404);
          expect(shown.html).not.toContain(subject);
        }
        const inOwnList = await read(`/o/${home}/external-actions`, person.jar);
        expect(inOwnList.status).toBe(200);
        expect(inOwnList.html).not.toContain(id);
      }

      // Their own proposal cannot name this tenant's work or connection.
      const proposal = {
        connection_id: tenant.mail.id,
        approver_membership_id: await membershipOf(su, rival.owner, rival.organization),
        email: anEmail([anAddress('stranger')]),
      };
      const onTheirWork = await createReceiptWork(
        rival.owner,
        rival.organization,
        `Theirs ${randomUUID()}`,
      );
      for (const path of [
        paths.proposals(org, work),
        paths.proposals(rival.organization, work),
        paths.proposals(rival.organization, onTheirWork),
      ]) {
        const refused = await api(rival.owner, 'POST', path, {
          body: proposal,
          key: randomUUID(),
        });
        expect(refused.status, path).toBe(404);
      }
      expect(await actionsOnWork(su, work)).toHaveLength(1);
      expect(await actionsOnWork(su, onTheirWork)).toEqual([]);
    }, 180_000);

    it('lets only the person named spend an approval', async () => {
      const work = await newWork('Decided by the wrong person');
      const { approval_id: approval, id } = await proposeFor(work, [anAddress('nobody')]);
      const path = approvalPage(tenant.organization, approval);
      const form = await formOn(
        path,
        reviewer.jar,
        (found) => found.hidden.get('decision') === 'approve',
      );

      // The form the right person was given, posted by the one who proposed it and by a bystander.
      const byProposer = await post(path, tenant.owner.jar, form);
      expect(locationOf(byProposer)).toBe(`${path}?error=APPROVAL_WRONG_APPROVER`);
      const bystander = await join(tenant.owner, tenant.organization, 'Nia Notnamed');
      const byBystander = await post(path, bystander.jar, form);
      expect(locationOf(byBystander)).toContain('error=');
      const byStranger = await post(path, rival.owner.jar, form);
      expect(byStranger.status === 404 || locationOf(byStranger).includes('error=')).toBe(true);

      expect((await statusOf(su, id))?.status).toBe('awaiting_approval');
    }, 120_000);

    it('lets only someone who manages connections make one, or a callback address', async () => {
      const member = await join(tenant.owner, tenant.organization, 'Milo Member');
      const org = tenant.organization;
      const refused = await api(member, 'POST', paths.connections(org), {
        body: {
          connector_type: 'inbound_webhook',
          display_name: 'Not allowed',
          config: {},
        },
        key: randomUUID(),
      });
      expect(refused.status).toBe(403);
      const endpoint = await api(member, 'POST', paths.endpoints(org, tenant.inbound.id));
      expect(endpoint.status).toBe(403);
      const elsewhere = await api(rival.owner, 'POST', paths.endpoints(org, tenant.inbound.id));
      expect(elsewhere.status).toBe(404);
      const crossed = await api(
        rival.owner,
        'POST',
        paths.endpoints(rival.organization, tenant.inbound.id),
      );
      expect(crossed.status).toBe(404);
    }, 120_000);
  });

  describe('confidentiality', () => {
    it('keeps a recipient, a subject and a body out of Temporal, logs and events', async () => {
      const recipientCanary = aCanary('recipient');
      const subjectCanary = aCanary('subject');
      const bodyCanary = aCanary('body');
      const to = `${recipientCanary}@example.invalid`;
      const work = await newWork('Canary');
      const endpoint = await newEndpoint(tenant.owner, tenant.organization, tenant.inbound.id);
      await postWebhook(
        endpoint.token,
        signedRequest(
          endpoint.secret,
          proposalEnvelope(
            work,
            tenant.mail.id,
            anEmail([to], { subject: subjectCanary, text_body: bodyCanary }),
          ),
        ),
      );
      await expect.poll(async () => (await actionsOnWork(su, work)).length, RUN).toBe(1);
      const [proposed] = await actionsOnWork(su, work);
      if (!proposed) throw new Error('No intent');
      const { action } = await readAction(tenant.owner, tenant.organization, proposed.id);
      if (!action.approval_id) throw new Error('No approval');
      await approveOnPage(tenant.owner, tenant.organization, action.approval_id);
      await expect.poll(async () => (await statusOf(su, proposed.id))?.status, RUN).toBe('sent');

      const canaries = [recipientCanary, subjectCanary, bodyCanary];

      // Controls: it really went through all of this, and these scans can see what they look for.
      const [message] = await sink.messagesTo(to);
      if (!message) throw new Error('No message');
      expect(message.raw).toContain(subjectCanary);
      expect(message.raw).toContain(bodyCanary);
      const { rows } = await su.query(
        'select payload::text as payload from integrations.external_actions where id = $1',
        [proposed.id],
      );
      for (const canary of canaries) expect(rows[0].payload).toContain(canary);
      const temporalDump = dumpTemporal();
      expect(temporalDump.length).toBeGreaterThan(10_000);
      expect(temporalDump).toContain(proposed.id);
      const logs = serviceLogs();
      expect(logs).toContain('connector_worker.started');
      const applicationDump = dumpApplicationDatabase();
      expect(holds(applicationDump, recipientCanary)).toBe(true);

      // The exact payload lives on the intent, under the work's rules, and in none of these.
      for (const canary of canaries) {
        expect(holds(temporalDump, canary), 'in Temporal').toBe(false);
        expect(holds(logs, canary), 'in a log').toBe(false);
        expect(await tablesHolding(su, canary)).toEqual([]);
      }

      // Nor is a credential, a signing secret or a webhook token anywhere it could be read back.
      const secrets = [tenant.mail.credential, endpoint.secret, endpoint.token];
      for (const value of secrets) {
        expect(holds(temporalDump, value), 'in Temporal').toBe(false);
        expect(holds(logs, value), 'in a log').toBe(false);
        expect(holds(applicationDump, value), 'in the database').toBe(false);
      }
      expect(holds(message.raw, tenant.mail.credential)).toBe(false);
    }, 240_000);
  });

  // A won deal starts an onboarding, which ends with a welcome message only the connector worker can send, so
  // it can start only where connectors are on (tests/stack/api.test.ts shows the refusal where they are off).
  // This is where both operations are proven, over the API and from the page, and where API-12's coverage of
  // them is asserted. Nothing is sent: the welcome message still waits for a person's approval. A tenant of its
  // own, so nothing it starts is in any other test's way.
  describe('client onboarding (API-12)', () => {
    const onboardings = (organization: string) =>
      `/api/v1/organizations/${organization}/client-onboardings`;
    const onboardingPage = (organization: string) => `/o/${organization}/onboarding`;
    const isOurs = (path: string) => /\/client-onboardings(\/|$)/.test(path);
    let company: Tenant;
    let colleague: Person;
    let founderMembership: string;
    let colleagueMembership: string;
    const contact = anAddress('client');

    beforeAll(async () => {
      company = await setUpTenant('Onboarding');
      colleague = await join(company.owner, company.organization, 'Oli Onboarding Reviewer');
      founderMembership = await membershipOf(su, company.owner, company.organization);
      colleagueMembership = await membershipOf(su, colleague, company.organization);
    });

    const start = () => ({
      deal_ref: `deal-${randomUUID()}`,
      client_name: 'Generated client',
      project_name: 'Generated project',
      owner_membership_id: founderMembership,
      reviewer_membership_id: colleagueMembership,
      email_connection_id: company.mail.id,
      contact_email: contact,
    });
    const codeOf = (answer: { json: unknown }) => (answer.json as { code?: string }).code;

    it('starts one onboarding per deal, replays its key, and reads it back', async () => {
      const body = start();
      const key = randomUUID();
      const started = await api(company.owner, 'POST', onboardings(company.organization), {
        body,
        key,
      });
      expect(started.status, started.text).toBe(201);
      const onboarding = started.json as { id: string; deal_ref: string; version: number };
      expect(onboarding).toMatchObject({
        deal_ref: body.deal_ref,
        reviewer_membership_id: colleagueMembership,
        version: 1,
      });
      const again = await api(company.owner, 'POST', onboardings(company.organization), {
        body,
        key,
      });
      expect(again.status, again.text).toBe(201);
      expect((again.json as { id: string }).id).toBe(onboarding.id);
      // The same deal under a new key is refused, not a second onboarding.
      const twice = await api(company.owner, 'POST', onboardings(company.organization), {
        body,
        key: randomUUID(),
      });
      expect(twice.status, twice.text).toBe(409);
      expect(codeOf(twice)).toBe('CLIENT_ONBOARDING_EXISTS');
      const read = await api(
        company.owner,
        'GET',
        `${onboardings(company.organization)}/${onboarding.id}`,
      );
      expect(read.status, read.text).toBe(200);
      expect(read.headers.get('etag')).toMatch(/^"[1-9]\d*"$/);
      expect(read.json).toMatchObject({ id: onboarding.id, deal_ref: body.deal_ref });
      // Starting is not sending: the welcome message waits for the reviewer's approval.
      expect(await sink.messagesTo(contact)).toEqual([]);
    }, 120_000);

    it('is refused to a member, a stranger, a self-review and a missing connection', async () => {
      const path = onboardings(company.organization);
      // A member may not start one, even naming someone else to review it.
      const third = await join(company.owner, company.organization, 'Tam Third Member');
      const byMember = await api(third, 'POST', path, { body: start(), key: randomUUID() });
      expect(byMember.status, byMember.text).toBe(403);
      expect(codeOf(byMember)).toBe('FORBIDDEN');
      const byStranger = await api(rival.owner, 'POST', path, {
        body: start(),
        key: randomUUID(),
      });
      expect(byStranger.status, byStranger.text).toBe(404);
      expect(codeOf(byStranger)).toBe('NOT_FOUND');
      const selfReview = await api(company.owner, 'POST', path, {
        body: { ...start(), reviewer_membership_id: founderMembership },
        key: randomUUID(),
      });
      expect(selfReview.status, selfReview.text).toBe(403);
      expect(codeOf(selfReview)).toBe('APPROVAL_SELF_APPROVAL');
      const noConnection = await api(company.owner, 'POST', path, {
        body: { ...start(), email_connection_id: randomUUID() },
        key: randomUUID(),
      });
      expect(noConnection.status, noConnection.text).toBe(404);
      expect(codeOf(noConnection)).toBe('NOT_FOUND');
      const readByStranger = await api(rival.owner, 'GET', `${path}/${randomUUID()}`);
      expect(readByStranger.status, readByStranger.text).toBe(404);
    }, 120_000);

    it('starts one from the page too, with no word of connectors being off', async () => {
      const shown = await read(onboardingPage(company.organization), company.owner.jar);
      expect(shown.status).toBe(200);
      expect(shown.html).not.toContain(
        'Email sending is switched off for this Ensemus installation',
      );
      const body = start();
      const response = await submit(
        onboardingPage(company.organization),
        company.owner.jar,
        /Start onboarding/,
        {
          dealRef: body.deal_ref,
          clientName: body.client_name,
          projectName: body.project_name,
          ownerMembershipId: body.owner_membership_id,
          reviewerMembershipId: body.reviewer_membership_id,
          emailConnectionId: body.email_connection_id,
          contactEmail: body.contact_email,
        },
      );
      expect(response.status).toBe(303);
      const { rows } = await su.query(
        'select id from work.client_onboardings where organization_id = $1 and deal_ref = $2',
        [company.organization, body.deal_ref],
      );
      expect(rows).toHaveLength(1);
      expect(response.headers.get('location')).toBe(
        `${onboardingPage(company.organization)}/${rows[0].id}`,
      );
    }, 120_000);

    it('has validated a real response from both onboarding operations, in a running test', () => {
      const ours = operations()
        .filter(({ status, path }) => status === undefined && isOurs(path))
        .map(({ method, path }) => operationName(method, path));
      expect(ours).toHaveLength(2);
      const { tested } = validatedOperations();
      expect(ours.filter((name) => !tested.has(name))).toEqual([]);
    });
  });
  // Connecting Google Workspace or Microsoft 365 by consent (ADR-038 D1, D5). Starting a consent needs
  // connectors on, so this is where the consent operations are proven over HTTP and where API-12's coverage
  // of them is asserted (tests/stack/api.test.ts shows the refusal where they are off, and covers what
  // members may connect). No provider is contacted: the provider's answer is the callback this test makes,
  // a refusal, so nothing is ever exchanged. The admin uses an app of their own with generated values; a
  // member's own consent uses the deployment's app, whose generated public ID compose.test.yaml gives web.
  // A tenant of its own.
  describe('connecting by consent (API-12)', () => {
    const base = (organization: string) => `/api/v1/organizations/${organization}`;
    const isOurs = (path: string) =>
      /\/(oauth-authorizations|my-connections)(\/|$)|^\/oauth\/callback$/.test(path);
    let company: Tenant;
    let member: Person;
    let memberMembership: string;
    type Started = {
      authorization: { id: string; status: string; owner_membership_id: string | null };
      authorize_url: string;
    };
    const bindingOf = (headers: Headers) => {
      const cookie = headers.get('set-cookie') ?? '';
      const match = new RegExp(`${OAUTH_BROWSER_COOKIE}=([^;]+)`).exec(cookie);
      if (!match?.[1]) throw new Error('The start set no browser binding');
      return match[1];
    };

    beforeAll(async () => {
      company = await setUpTenant('Consent');
      member = await join(company.owner, company.organization, 'Mo Member');
      memberMembership = await membershipOf(su, member, company.organization);
    });

    it('starts an admin’s consent, reads it back, and records the provider’s refusal', async () => {
      const path = `${base(company.organization)}/oauth-authorizations`;
      const clientSecret = `generated-${randomUUID()}`;
      const started = await api(company.owner, 'POST', path, {
        body: {
          connector_type: 'google_workspace',
          display_name: 'Generated workspace',
          config: {},
          capabilities: ['files'],
          client: {
            kind: 'customer',
            client_id: 'generated-customer.apps.example.invalid',
            client_secret: clientSecret,
          },
        },
      });
      expect(started.status, started.text).toBe(201);
      expect(started.headers.get('cache-control')).toContain('no-store');
      const { authorization, authorize_url: authorizeUrl } = started.json as Started;
      expect(authorization).toMatchObject({ status: 'pending', owner_membership_id: null });
      // The secret goes in and does not come back.
      expect(started.text).not.toContain(clientSecret);
      const state = new URL(authorizeUrl).searchParams.get('state');
      if (!state) throw new Error('The provider page names no state');
      const binding = bindingOf(started.headers);

      const listed = await api(company.owner, 'GET', path);
      expect(listed.status, listed.text).toBe(200);
      expect((listed.json as { items: { id: string }[] }).items.map((item) => item.id)).toContain(
        authorization.id,
      );
      // A member who did not start it hears that it does not exist.
      const byMember = await api(member, 'GET', `${path}/${authorization.id}`);
      expect(byMember.status, byMember.text).toBe(404);

      // The provider sends the admin back refusing, to the same session in the same browser.
      const callbackPath = `/api/v1/oauth/callback?state=${encodeURIComponent(state)}&error=access_denied`;
      const callback = () =>
        fetch(`${BASE}${callbackPath}`, {
          redirect: 'manual',
          headers: { cookie: `${company.owner.jar.cookie}; ${OAUTH_BROWSER_COOKIE}=${binding}` },
        });
      const response = await callback();
      const { problems } = contractProblems({
        method: 'GET',
        path: callbackPath,
        status: response.status,
        headers: response.headers,
        text: await response.text(),
      });
      expect(problems).toEqual([]);
      expect(response.status).toBe(303);
      const location = response.headers.get('location') ?? '';
      expect(location).toMatch(
        new RegExp(`/o/${company.organization}/connections\\?authorization=${authorization.id}$`),
      );
      expect(location).not.toContain(state);

      const read = await api(company.owner, 'GET', `${path}/${authorization.id}`);
      expect(read.status, read.text).toBe(200);
      expect(read.json).toMatchObject({
        id: authorization.id,
        status: 'denied',
        error_code: 'OAUTH_DENIED',
      });
      // The state was used once: the same callback again is refused, and says nothing more.
      const again = await callback();
      expect(again.status).toBe(303);
      expect(again.headers.get('location')).toMatch(/\?error=OAUTH_STATE_INVALID$/);
    }, 120_000);

    it('lets a member start a consent of their own, list their own and revoke it', async () => {
      const own = `${base(company.organization)}/my-connections`;
      const started = await api(member, 'POST', own, {
        body: {
          connector_type: 'google_workspace',
          display_name: 'My mail',
          capabilities: ['mail'],
        },
      });
      expect(started.status, started.text).toBe(201);
      expect((started.json as Started).authorization).toMatchObject({
        status: 'pending',
        owner_membership_id: memberMembership,
      });
      // What the organization does not allow members is refused in plain words.
      const refused = await api(member, 'POST', own, {
        body: {
          connector_type: 'google_workspace',
          display_name: 'My documents',
          capabilities: ['documents'],
        },
      });
      expect(refused.status, refused.text).toBe(403);
      expect((refused.json as { code?: string }).code).toBe('MEMBER_CAPABILITY_NOT_ALLOWED');

      // Consent never completes here, so the member's connection is written as the exchange leaves one.
      const connectionId = randomUUID();
      await inFixtureTenant(su, company.organization, () =>
        su.query(
          `insert into integrations.connections
             (organization_id, id, connector_type, display_name, state, granted_scopes,
              owner_membership_id, created_by_membership_id)
           values ($1, $2, 'google_workspace', 'My mail', 'active', $3, $4, $4)`,
          [
            company.organization,
            connectionId,
            ['gmail.readonly', 'gmail.compose', 'gmail.send'].map(
              (scope) => `https://www.googleapis.com/auth/${scope}`,
            ),
            memberMembership,
          ],
        ),
      );
      const listed = await api(member, 'GET', own);
      expect(listed.status, listed.text).toBe(200);
      expect(listed.text).not.toContain('googleapis.com/auth');
      expect(listed.json).toMatchObject({
        items: [{ id: connectionId, state: 'active', capabilities: ['mail'] }],
      });
      // Nobody else sees it as theirs, and another member may not revoke it.
      expect((await api(company.owner, 'GET', own)).json).toEqual({ items: [] });
      const other = await join(company.owner, company.organization, 'Sky Other Member');
      const byOther = await api(other, 'DELETE', `${own}/${connectionId}`);
      expect(byOther.status, byOther.text).toBe(404);

      const revoked = await api(member, 'DELETE', `${own}/${connectionId}`);
      expect(revoked.status, revoked.text).toBe(204);
      const after = await api(
        company.owner,
        'GET',
        `${base(company.organization)}/member-connections`,
      );
      expect(after.status, after.text).toBe(200);
      expect(after.json).toMatchObject({
        items: [{ id: connectionId, owner_membership_id: memberMembership, state: 'revoked' }],
      });
    }, 120_000);

    it('has validated a real response from every consent operation, in a running test', () => {
      const ours = operations()
        .filter(({ status, path }) => status === undefined && isOurs(path))
        .map(({ method, path }) => operationName(method, path));
      expect(ours).toHaveLength(7);
      const { tested } = validatedOperations();
      expect(ours.filter((name) => !tested.has(name))).toEqual([]);
    });
  });
});
