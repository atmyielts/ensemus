// Generated people use the production HTTP routes and their published response contracts.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disableMember } from '@ensemus/application';
import { openAppDatabase } from '@ensemus/database';
import {
  BASE,
  createOrganization,
  join,
  read,
  signUp,
  submit,
  type Person,
} from '../helpers/forms';
import { nativePersonContext } from '../helpers/product';
import { seedConnection } from '../helpers/integrations';
import { seedMeetingSuggestions, TEST_NOTICE } from '../helpers/expansion';
import { urls } from '../helpers/stack';
import { contractProblems } from '../helpers/openapi';

describe('manual meeting HTTP lifecycle', () => {
  const app = openAppDatabase(urls.app());
  let owner: Person,
    member: Person,
    foreign: Person,
    org: string,
    foreignOrg: string,
    memberId: string,
    meetingId: string,
    notesKey: string;
  const base = () => `/api/v1/organizations/${org}`;
  async function call(
    person: Person,
    method: string,
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ) {
    const response = await fetch(BASE + path, {
      method,
      headers: {
        cookie: person.jar.cookie,
        origin: BASE,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    expect(
      contractProblems({ method, path, status: response.status, headers: response.headers, text })
        .problems,
    ).toEqual([]);
    return { response, body: text ? JSON.parse(text) : null };
  }
  async function contextFor(person: Person, organizationId: string) {
    const response = await fetch(BASE + '/api/auth/get-session', {
      headers: { cookie: person.jar.cookie },
    });
    expect(response.status).toBe(200);
    const { user, session } = (await response.json()) as {
      user: { id: string };
      session: { id: string };
    };
    return nativePersonContext(app.db, { userId: user.id, sessionId: session.id }, organizationId);
  }
  beforeAll(async () => {
    owner = await signUp('Generated meeting organizer');
    org = await createOrganization(owner, 'Generated meeting company');
    member = await join(owner, org, 'Generated meeting participant');
    foreign = await signUp('Generated other company organizer');
    foreignOrg = await createOrganization(foreign, 'Generated other meeting company');
    memberId = (await contextFor(member, org)).membershipId;
  });
  afterAll(() => app.close());
  it('starts off, refuses member administration, then records the owner notice and settings ETag', async () => {
    const original = await call(owner, 'GET', base() + '/meeting-settings');
    expect(original.body).toEqual({ enabled: false, notice_ref: null, version: 1 });
    expect(original.response.headers.get('etag')).toBe('"1"');
    expect(
      (
        await call(
          member,
          'PATCH',
          base() + '/meeting-settings',
          { enabled: true, notice_ref: 'generated-notice' },
          { 'if-match': '"1"' },
        )
      ).response.status,
    ).toBe(403);
    const updated = await call(
      owner,
      'PATCH',
      base() + '/meeting-settings',
      { enabled: true, notice_ref: 'generated-notice' },
      { 'if-match': '"1"' },
    );
    expect(updated.response.status).toBe(200);
    expect(updated.body.enabled).toBe(true);
  });
  it('grants only a tenant-local notes provider once, and can revoke it without replaying a grant', async () => {
    const endpoint = base() + '/meeting-provider-approvals';
    const administrator = await contextFor(owner, org);
    const connection = await seedConnection(app.db, administrator, {
      connectorType: 'meeting_notes_http',
      displayName: 'Generated meeting notes connection',
    });
    const body = {
      kind: 'source',
      connection_id: connection,
      max_classification: 'internal',
      terms_ref: 'generated-provider-terms',
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    };
    const key = { 'idempotency-key': randomUUID() };
    expect((await call(member, 'GET', endpoint)).response.status).toBe(403);
    expect((await call(member, 'POST', endpoint, body, key)).response.status).toBe(403);
    expect((await call(foreign, 'GET', endpoint)).response.status).toBe(404);
    const otherEndpoint = '/api/v1/organizations/' + foreignOrg + '/meeting-provider-approvals';
    expect((await call(foreign, 'POST', otherEndpoint, body, key)).response.status).toBe(404);
    expect(
      (await call(owner, 'POST', endpoint, { ...body, max_classification: 'restricted' }, key))
        .response.status,
    ).toBe(400);

    const created = await call(owner, 'POST', endpoint, body, key);
    expect(created.response.status).toBe(201);
    expect(created.body).toMatchObject({
      kind: 'source',
      target_ref: 'connection:' + connection,
      purposes: ['import_notes'],
      revoked_at: null,
    });
    expect((await call(owner, 'POST', endpoint, body, key)).body).toEqual(created.body);
    expect(
      (await call(owner, 'POST', endpoint, { ...body, terms_ref: 'changed' }, key)).response.status,
    ).toBe(409);
    const id = created.body.id as string;
    const revoke = '/' + id + '/revocation';
    expect((await call(member, 'POST', endpoint + revoke)).response.status).toBe(403);
    expect((await call(foreign, 'POST', otherEndpoint + revoke)).response.status).toBe(404);
    expect((await call(owner, 'POST', endpoint + revoke)).response.status).toBe(204);
    expect((await call(owner, 'POST', endpoint + revoke)).response.status).toBe(204);
    const replayed = await call(owner, 'POST', endpoint, body, key);
    expect(replayed.body.revoked_at).toEqual(expect.any(String));
    expect((await call(owner, 'GET', endpoint)).body.items).toEqual([replayed.body]);
  });
  it('creates once, records each actual answer, stores notes once and rejects stale participant changes', async () => {
    const key = randomUUID(),
      input = { title: 'GENERATED_PRIVATE_HTTP_MEETING', occurred_at: new Date().toISOString() };
    const created = await call(owner, 'POST', base() + '/meetings', input, {
      'idempotency-key': key,
    });
    expect(created.response.status).toBe(201);
    meetingId = created.body.id;
    expect(
      (await call(owner, 'GET', base() + '/meetings')).body.items.some(
        (row: { id: string }) => row.id === meetingId,
      ),
    ).toBe(true);
    expect(
      (await call(owner, 'POST', base() + '/meetings', input, { 'idempotency-key': key })).body.id,
    ).toBe(meetingId);
    expect((await call(member, 'GET', base() + `/meetings/${meetingId}`)).response.status).toBe(
      404,
    );
    const notesPath = base() + `/meetings/${meetingId}/notes`;
    expect(
      (
        await call(
          owner,
          'POST',
          notesPath,
          { text: 'Too soon' },
          { 'idempotency-key': randomUUID() },
        )
      ).body.code,
    ).toBe('CONSENT_INCOMPLETE');
    const participant = await call(
      owner,
      'POST',
      base() + `/meetings/${meetingId}/participants`,
      { kind: 'member', membership_id: memberId },
      { 'if-match': '"1"' },
    );
    expect(participant.response.status).toBe(201);
    expect(
      (
        await call(
          owner,
          'POST',
          base() + `/meetings/${meetingId}/participants`,
          { kind: 'external', label: 'Generated late stale request' },
          { 'if-match': '"1"' },
        )
      ).body.code,
    ).toBe('VERSION_CONFLICT');
    const current = await call(owner, 'GET', base() + `/meetings/${meetingId}`);
    const outside = await call(
      owner,
      'POST',
      base() + `/meetings/${meetingId}/participants`,
      { kind: 'external', label: 'Generated unanswered visitor' },
      { 'if-match': `"${current.body.version}"` },
    );
    expect(outside.response.status).toBe(201);
    const afterOutside = await call(owner, 'GET', base() + `/meetings/${meetingId}`);
    expect(
      (
        await call(
          owner,
          'DELETE',
          base() + `/meetings/${meetingId}/participants/${outside.body.id}`,
          undefined,
          { 'if-match': `"${afterOutside.body.version}"` },
        )
      ).response.status,
    ).toBe(204);
    const consent = (participantId: string) =>
      base() + `/meetings/${meetingId}/participants/${participantId}/consent`;
    expect(
      (
        await call(owner, 'POST', consent(participant.body.id), {
          decision: 'granted',
          notice_ref: 'generated-notice',
        })
      ).body.code,
    ).toBe('CONSENT_NOT_YOURS');
    await call(owner, 'POST', consent(created.body.participants[0].id), {
      decision: 'granted',
      notice_ref: 'generated-notice',
    });
    expect(
      (
        await call(member, 'POST', consent(participant.body.id), {
          decision: 'granted',
          notice_ref: 'generated-notice',
        })
      ).body.consent,
    ).toBe('complete');
    notesKey = randomUUID();
    const saved = await call(
      owner,
      'POST',
      notesPath,
      { text: 'GENERATED_PRIVATE_HTTP_NOTES' },
      { 'idempotency-key': notesKey },
    );
    expect(saved.response.status).toBe(201);
    expect(saved.body.version).toBe(1);
    expect(
      (
        await call(
          owner,
          'POST',
          notesPath,
          { text: 'GENERATED_PRIVATE_HTTP_NOTES' },
          { 'idempotency-key': notesKey },
        )
      ).body,
    ).toEqual(saved.body);
    expect(
      (await call(member, 'GET', base() + `/meetings/${meetingId}`)).body.current_notes.text,
    ).toBe('GENERATED_PRIVATE_HTTP_NOTES');
    expect(
      (
        await call(
          member,
          'POST',
          notesPath,
          { text: 'Not the organizer' },
          { 'idempotency-key': randomUUID() },
        )
      ).response.status,
    ).toBe(403);
  });
  it('keeps foreign and unknown meetings indistinguishable', async () => {
    const foreignRead = await call(
      foreign,
      'GET',
      `/api/v1/organizations/${foreignOrg}/meetings/${meetingId}`,
    );
    const unknown = await call(
      foreign,
      'GET',
      `/api/v1/organizations/${foreignOrg}/meetings/${randomUUID()}`,
    );
    expect(foreignRead.response.status).toBe(404);
    expect(foreignRead.body.code).toBe(unknown.body.code);
    expect(JSON.stringify(foreignRead.body)).not.toContain('GENERATED_PRIVATE_HTTP');
  });
  it('requires preconditions and rejects malformed bodies', async () => {
    expect(
      (
        await call(owner, 'PATCH', base() + '/meeting-settings', {
          enabled: false,
          notice_ref: 'generated-notice',
        })
      ).response.status,
    ).toBe(428);
    expect(
      (
        await call(
          owner,
          'POST',
          base() + '/meetings',
          { title: 'Generated', occurred_at: 'bad-date' },
          { 'idempotency-key': randomUUID() },
        )
      ).response.status,
    ).toBe(400);
    expect((await call(owner, 'GET', base() + '/meetings?cursor=invalid')).response.status).toBe(
      400,
    );
  });
  it('accepts bounded notes above the ordinary JSON limit and refuses oversized UTF-8 or wire bodies', async () => {
    const path = base() + `/meetings/${meetingId}/notes`;
    expect(
      (
        await call(
          owner,
          'POST',
          path,
          { text: 'a'.repeat(300000) },
          { 'idempotency-key': randomUUID() },
        )
      ).response.status,
    ).toBe(201);
    expect(
      (
        await call(
          owner,
          'POST',
          path,
          { text: 'é'.repeat(300000) },
          { 'idempotency-key': randomUUID() },
        )
      ).response.status,
    ).toBe(400);
    expect(
      (
        await call(
          owner,
          'POST',
          path,
          { text: 'a'.repeat(4 * 1024 * 1024) },
          { 'idempotency-key': randomUUID() },
        )
      ).response.status,
    ).toBe(413);
  });

  it('withdraws through the participant account and refuses an old notes key afterward', async () => {
    const current = await call(member, 'GET', base() + `/meetings/${meetingId}`),
      p = current.body.participants.find(
        (p: { membership_id: string }) => p.membership_id === memberId,
      );
    const gone = await call(
      member,
      'POST',
      base() + `/meetings/${meetingId}/participants/${p.id}/consent`,
      { decision: 'withdrawn', notice_ref: 'generated-notice' },
    );
    expect(gone.body).toEqual({ consent: 'withdrawn', status: 'purged' });
    const read = await call(owner, 'GET', base() + `/meetings/${meetingId}`);
    expect(read.body.current_notes.text).toBeNull();
    expect(read.body.title).toBe('Removed');
    expect(
      (
        await call(
          owner,
          'POST',
          base() + `/meetings/${meetingId}/notes`,
          { text: 'GENERATED_PRIVATE_HTTP_NOTES' },
          { 'idempotency-key': notesKey },
        )
      ).body.code,
    ).toBe('MEETING_PURGED');
  });
  it('hands off an orphaned meeting through the API and the private administrator form', async () => {
    const session = (await (
      await fetch(BASE + '/api/auth/get-session', { headers: { cookie: owner.jar.cookie } })
    ).json()) as { user: { id: string }; session: { id: string } };
    const ownerContext = await nativePersonContext(
      app.db,
      { userId: session.user.id, sessionId: session.session.id },
      org,
    );
    const meetings = [];
    for (const title of ['PRIVATE_API_HANDOFF', 'PRIVATE_FORM_HANDOFF']) {
      const created = await call(
        member,
        'POST',
        base() + '/meetings',
        {
          title,
          occurred_at: new Date().toISOString(),
        },
        { 'idempotency-key': randomUUID() },
      );
      expect(created.response.status).toBe(201);
      const path = base() + `/meetings/${created.body.id}`;
      const joined = await call(
        member,
        'POST',
        path + '/participants',
        {
          kind: 'member',
          membership_id: ownerContext.membershipId,
        },
        { 'if-match': `"${created.body.version}"` },
      );
      expect(joined.response.status).toBe(201);
      meetings.push({
        id: created.body.id as string,
        path,
        version: created.body.version + 1,
        title,
      });
    }
    const [apiMeeting, formMeeting] = meetings;
    const handoff = apiMeeting!.path + '/organizer';
    const body = { organizer_membership_id: ownerContext.membershipId };
    const current = { 'if-match': `"${apiMeeting!.version}"` };
    expect((await call(owner, 'POST', handoff, body)).response.status).toBe(428);
    expect((await call(owner, 'POST', handoff, body, current)).response.status).toBe(409);
    await disableMember(app.db, ownerContext, { membershipId: memberId });
    expect((await call(owner, 'POST', handoff, body, current)).response.status).toBe(204);
    expect((await call(owner, 'POST', handoff, body, current)).response.status).toBe(409);
    expect((await call(owner, 'GET', apiMeeting!.path)).body.organizer_membership_id).toBe(
      ownerContext.membershipId,
    );

    const pagePath = `/o/${org}/meetings/${formMeeting!.id}`;
    const page = await read(pagePath, owner.jar);
    expect(page.html).toContain('Hand off meeting');
    const posted = await submit(pagePath, owner.jar, /name="organizerMembershipId"/, {
      organizerMembershipId: ownerContext.membershipId,
    });
    expect(posted.status).toBe(303);
    expect(posted.headers.get('location')).toBe(pagePath);
    expect((await read(pagePath, owner.jar)).html).not.toContain('Hand off meeting');
    expect((await call(owner, 'GET', formMeeting!.path)).body.organizer_membership_id).toBe(
      ownerContext.membershipId,
    );
  });
  it('reviews private derived content and creates only one work unit through concurrent retries', async () => {
    const coworker = await join(owner, org, 'Generated non-attendee');
    const coworkerContext = await contextFor(coworker, org);
    const room = await seedMeetingSuggestions(app.db, await contextFor(owner, org));
    const parent = base() + '/meetings/' + room.id;
    const items = base() + '/meeting-items/';
    const view = await call(owner, 'GET', parent + '/summaries');
    expect(view.body.items).toEqual([
      expect.objectContaining({ trust: 'model_generated', text: room.summaryText }),
    ]);
    expect((await call(coworker, 'GET', parent + '/proposed-items')).response.status).toBe(404);
    expect((await call(foreign, 'GET', parent + '/summaries')).response.status).toBe(404);

    const approval = { 'if-match': '"1"' };
    expect(
      (await call(owner, 'POST', items + room.decision + '/decision', {}, approval)).body,
    ).toEqual({ version: 2 });
    expect(
      (await call(owner, 'POST', items + room.dismiss + '/rejection', {}, approval)).body,
    ).toEqual({ version: 2 });

    const key = { ...approval, 'idempotency-key': randomUUID() };
    const workPath = items + room.work + '/work';
    const input = {
      title: 'Generated accepted meeting work',
      owner_membership_id: coworkerContext.membershipId,
      due_at: null,
    };
    expect(
      (await call(owner, 'POST', workPath, input, { 'idempotency-key': randomUUID() })).response
        .status,
    ).toBe(428);
    expect((await call(coworker, 'POST', workPath, input, key)).response.status).toBe(404);
    const [first, replay] = await Promise.all([
      call(owner, 'POST', workPath, input, key),
      call(owner, 'POST', workPath, input, key),
    ]);
    expect(first.response.status, JSON.stringify(first.body)).toBe(201);
    expect(replay.response.status, JSON.stringify(replay.body)).toBe(201);
    expect(replay.body).toEqual(first.body);
    const item = (await call(owner, 'GET', parent + '/proposed-items')).body.items.find(
      (entry: { id: string }) => entry.id === room.work,
    );
    expect(item).toMatchObject({
      status: 'accepted',
      work_unit_id: first.body.work_unit_id,
      version: 2,
    });
    const work = base() + '/work-units/' + first.body.work_unit_id;
    expect((await call(owner, 'GET', work)).body).toMatchObject({ title: input.title });

    const withdrawn = await call(
      owner,
      'POST',
      parent + '/participants/' + room.organizerParticipantId + '/consent',
      { decision: 'withdrawn', notice_ref: TEST_NOTICE },
    );
    expect(withdrawn.response.status).toBe(200);
    expect((await call(owner, 'POST', workPath, input, key)).body.code).toBe('MEETING_PURGED');
    expect((await call(owner, 'GET', parent + '/summaries')).body.items).toEqual([
      expect.objectContaining({ text: null }),
    ]);
    expect((await call(owner, 'GET', work)).response.status).toBe(200);
  });
});
