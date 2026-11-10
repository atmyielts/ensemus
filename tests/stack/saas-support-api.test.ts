import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { BASE, createOrganization, join, signUp, type Person } from '../helpers/forms';
import { contractProblems } from '../helpers/openapi';
describe('support API protects a conversation in every standing', () => {
  let owner: Person, member: Person, outsider: Person, organizationId: string;
  beforeAll(async () => {
    owner = await signUp('Support API owner');
    outsider = await signUp('Support API other');
    organizationId = await createOrganization(owner, 'Support API account');
    member = await join(owner, organizationId, 'Support API member');
  });
  function call(person: Person, path: string, body?: unknown, version?: number) {
    return fetch(`${BASE}/api/v1/organizations/${organizationId}/support/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        cookie: person.jar.cookie,
        origin: BASE,
        'content-type': 'application/json',
        ...(version ? { 'if-match': `"${version}"` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  it('the outsider cannot read or create, while a member cannot see another persons ticket', async () => {
    expect((await call(outsider, 'tickets')).status).toBe(404);
    expect(
      (await call(outsider, 'tickets', { subject: 'Test', category: 'other', body: 'Test' }))
        .status,
    ).toBe(404);
    const opened = await call(owner, 'tickets', {
        subject: 'Owner ticket',
        category: 'account',
        body: 'Owner text',
      }),
      body = (await opened.json()) as { ticket_id: string };
    expect(opened.status).toBe(201);
    expect((await call(member, `tickets/${body.ticket_id}`)).status).toBe(404);
    expect((await call(member, 'break-glass')).status).toBe(404);
    expect(
      (await call(member, `break-glass/${randomUUID()}/decision`, { decision: 'authorize' }, 1))
        .status,
    ).toBe(404);
  });
  it('a member can ask for help and reply using the exact current version', async () => {
    const opened = await call(member, 'tickets', {
        subject: 'Member ticket',
        category: 'other',
        body: 'Test context',
      }),
      value = (await opened.json()) as { ticket_id: string };
    expect(opened.status).toBe(201);
    const response = await call(member, `tickets/${value.ticket_id}`),
      text = await response.text();
    expect(
      contractProblems({
        method: 'GET',
        path: `/organizations/${organizationId}/support/tickets/${value.ticket_id}`,
        status: response.status,
        headers: response.headers,
        text,
      }).problems,
    ).toEqual([]);
    expect(text).not.toMatch(
      /author_ref|opened_by_membership|operator_authorizer|customer_authorizer/,
    );
    const ticket = JSON.parse(text) as { version: number };
    expect(
      (await call(member, `tickets/${value.ticket_id}/messages`, { body: 'No version' })).status,
    ).toBe(428);
    const replied = await call(
      member,
      `tickets/${value.ticket_id}/messages`,
      { body: 'Test reply' },
      ticket.version,
    );
    expect(replied.status).toBe(200);
    expect(replied.headers.get('etag')).toBe(`"${ticket.version + 1}"`);
    expect(
      (
        await call(
          member,
          `tickets/${value.ticket_id}/messages`,
          { body: 'Stale reply' },
          ticket.version,
        )
      ).status,
    ).toBe(409);
  });
});
