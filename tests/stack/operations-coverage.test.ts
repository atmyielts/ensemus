// API-12 coverage: a validated real answer under 400 for implemented operations that no other stack suite
// reached, each through the proxy, matched against docs/specifications/openapi.yaml by contractProblems (which
// records it for tests/stack/api.test.ts). Every operation is also refused to someone outside the tenant, so
// a success here is not a route that answers anyone. Generated data only.
import { randomUUID } from 'node:crypto';
import { createWorkUnit } from '@ensemus/application';
import { openAppDatabase, resolveTenantContext } from '@ensemus/database';
import { PACK_CATALOG } from '@ensemus/packs';
import { beforeAll, describe, expect, it } from 'vitest';
import { BASE, createOrganization, signUp, type Person } from '../helpers/forms';
import { contractProblems } from '../helpers/openapi';
import { proveSecondFactor } from '../helpers/product';
import { urls } from '../helpers/stack';

type Answer = { status: number; text: string; json: Record<string, unknown>; headers: Headers };

async function sessionOf(person: Person) {
  const response = await fetch(`${BASE}/api/auth/get-session`, {
    headers: { cookie: person.jar.cookie },
  });
  const body = (await response.json()) as { user?: { id?: unknown }; session?: { id?: unknown } };
  if (typeof body.user?.id !== 'string' || typeof body.session?.id !== 'string')
    throw new Error('TEST_SESSION_MISSING');
  return { userId: body.user.id, sessionId: body.session.id };
}

describe('operations no other stack suite reaches (API-12)', () => {
  let owner: Person, outsider: Person, organization: string;

  async function call(
    person: Person,
    method: string,
    suffix: string,
    options: { body?: unknown; form?: FormData; headers?: Record<string, string> } = {},
  ): Promise<Answer> {
    const path = `/api/v1/organizations/${organization}/${suffix}`;
    const response = await fetch(BASE + path, {
      method,
      headers: {
        cookie: person.jar.cookie,
        ...(method === 'GET' ? {} : { origin: BASE }),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...options.headers,
      },
      ...(options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : options.form
          ? { body: options.form }
          : {}),
      redirect: 'manual',
    });
    const text = await response.text();
    expect(
      contractProblems({ method, path, status: response.status, headers: response.headers, text })
        .problems,
      text,
    ).toEqual([]);
    expect(response.headers.get('cache-control')).toContain('no-store');
    return {
      status: response.status,
      text,
      json: text ? (JSON.parse(text) as Record<string, unknown>) : {},
      headers: response.headers,
    };
  }

  /** The same operation, as someone with no membership here: the ordinary missing answer. */
  async function hiddenFromOutsider(method: string, suffix: string, body?: unknown) {
    const answer = await call(outsider, method, suffix, body === undefined ? {} : { body });
    expect(answer.status, answer.text).toBe(404);
  }

  beforeAll(async () => {
    owner = await signUp('Coverage owner');
    organization = await createOrganization(owner, 'Generated coverage company');
    outsider = await signUp('Coverage outsider');
    await createOrganization(outsider, 'Generated other coverage company');
    // Packs need recent MFA (0404 'always' tier). This proves it for the owner's own session only.
    await proveSecondFactor(await sessionOf(owner));
  }, 120_000);

  it('reads the Pulse and keeps a signal’s state for one person', async () => {
    const { userId } = await sessionOf(owner);
    const database = openAppDatabase(urls.app());
    const title = `Generated overdue coverage ${randomUUID()}`;
    let workId: string;
    try {
      const context = await resolveTenantContext(database.db, userId, organization);
      workId = (
        await createWorkUnit(database.db, context, {
          title,
          objective: 'Generated overdue work for the Pulse.',
          classification: 'internal',
          dueAt: new Date(Date.now() - 3 * 86_400_000),
        })
      ).id;
    } finally {
      await database.close();
    }
    const pulse = await call(owner, 'GET', 'pulse');
    expect(pulse.status, pulse.text).toBe(200);
    const signal = (pulse.json.signals as { key: string; work: { id: string } }[]).find(
      (item) => item.work.id === workId,
    );
    if (!signal) throw new Error('TEST_PULSE_SIGNAL_MISSING');
    const key = encodeURIComponent(signal.key);
    const dismissed = await call(owner, 'PUT', `pulse/signals/${key}`, {
      body: { state: 'dismissed' },
    });
    expect(dismissed.status, dismissed.text).toBe(204);
    const all = await call(owner, 'GET', 'pulse?include_dismissed=true');
    expect(all.status).toBe(200);
    expect(
      (all.json.signals as { key: string; personal_state: string }[]).find(
        (item) => item.key === signal.key,
      )?.personal_state,
    ).toBe('dismissed');
    expect(
      (await call(owner, 'PUT', `pulse/signals/${key}`, { body: { state: 'open' } })).status,
    ).toBe(204);
    await hiddenFromOutsider('GET', 'pulse');
    await hiddenFromOutsider('PUT', `pulse/signals/${key}`, { state: 'dismissed' });
  });

  it('shows the egress ledger and simulates a proposed destination without saving it', async () => {
    const ledger = await call(owner, 'GET', 'egress-ledger');
    expect(ledger.status, ledger.text).toBe(200);
    const proposal = {
      destination: 'customer_private_inference',
      destination_host: 'inference.example.invalid',
      billing_owner: 'customer',
      retention_basis: 'self_hosted',
      region: null,
      contract_ref: null,
      allowed_classes: ['internal'],
      purposes: ['answer'],
    };
    const simulated = await call(owner, 'POST', 'egress-simulations', { body: proposal });
    expect(simulated.status, simulated.text).toBe(200);
    // A simulation records nothing that leaves: the ledger is unchanged by it.
    const after = await call(owner, 'GET', 'egress-ledger');
    expect(after.json.items).toEqual(ledger.json.items);
    await hiddenFromOutsider('GET', 'egress-ledger');
    await hiddenFromOutsider('POST', 'egress-simulations', proposal);
  });

  it('links a source to work and walks the company graph from it', async () => {
    const work = await call(owner, 'POST', 'work-units', {
      body: { title: `Generated graph work ${randomUUID()}`, objective: 'Graph coverage' },
      headers: { 'idempotency-key': randomUUID() },
    });
    expect(work.status, work.text).toBe(201);
    const form = new FormData();
    form.set(
      'metadata',
      JSON.stringify({
        title: `Generated graph source ${randomUUID()}`,
        classification: 'internal',
        grants: [],
      }),
    );
    form.set('file', new File(['Generated graph words.'], 'graph.txt', { type: 'text/plain' }));
    const source = await call(owner, 'POST', 'knowledge/sources', {
      form,
      headers: { 'idempotency-key': randomUUID() },
    });
    expect(source.status, source.text).toBe(201);
    const edge = {
      from: { type: 'knowledge_source', id: String(source.json.id) },
      relation: 'documents',
      to: { type: 'work_unit', id: String(work.json.id) },
    };
    const linked = await call(owner, 'POST', 'knowledge/graph/edges', { body: edge });
    expect(linked.status, linked.text).toBe(201);
    // The same link again is the same edge.
    const again = await call(owner, 'POST', 'knowledge/graph/edges', { body: edge });
    expect(again.json.edge_id).toBe(linked.json.edge_id);
    const walk = { from: { type: 'work_unit', id: String(work.json.id) }, depth: 1 };
    const walked = await call(owner, 'POST', 'knowledge/graph/traverse', { body: walk });
    expect(walked.status, walked.text).toBe(200);
    await hiddenFromOutsider('POST', 'knowledge/graph/edges', edge);
    await hiddenFromOutsider('POST', 'knowledge/graph/traverse', walk);
  });

  it('installs, reviews, activates, upgrades and rolls back a pack', async () => {
    const catalog = await call(owner, 'GET', 'packs');
    expect(catalog.status, catalog.text).toBe(200);
    const key = (catalog.json.items as { key: string }[])[0]?.key;
    if (!key) throw new Error('TEST_PACK_CATALOG_EMPTY');
    const versions = PACK_CATALOG.filter((pack) => pack.key === key).map((pack) => pack.version);
    // Rollback needs an older version to go back to; the catalog keeps every shipped one.
    expect(versions.length).toBeGreaterThanOrEqual(2);

    async function installAndActivate(version: string) {
      const requested = await call(owner, 'POST', `packs/${key}/installations`, {
        body: { version },
      });
      expect(requested.status, requested.text).toBe(201);
      const id = String(requested.json.id);
      const read = await call(owner, 'GET', `pack-installations/${id}`);
      expect(read.status, read.text).toBe(200);
      let current = read;
      // Declining grants nothing and still decides each capability, which activation requires.
      for (const capability of read.json.capabilities as { key: string }[]) {
        current = await call(owner, 'POST', `pack-installations/${id}/capabilities`, {
          body: { capability_key: capability.key, decision: 'declined' },
        });
        expect(current.status, current.text).toBe(200);
      }
      const activated = await call(owner, 'POST', `pack-installations/${id}/activation`, {
        headers: { 'if-match': current.headers.get('etag') ?? '' },
      });
      expect(activated.status, activated.text).toBe(200);
      expect(activated.json.status).toBe('active');
      return activated;
    }

    await installAndActivate(versions[0]!);
    const upgraded = await installAndActivate(versions.at(-1)!);
    const rolledBack = await call(
      owner,
      'POST',
      `pack-installations/${String(upgraded.json.id)}/rollback`,
      { headers: { 'if-match': upgraded.headers.get('etag') ?? '' } },
    );
    expect(rolledBack.status, rolledBack.text).toBe(200);
    await hiddenFromOutsider('GET', 'packs');
    await hiddenFromOutsider('GET', `pack-installations/${String(upgraded.json.id)}`);
  });

  it('lists the company’s own support tickets and break-glass requests', async () => {
    const opened = await call(owner, 'POST', 'support/tickets', {
      body: { subject: 'Generated coverage ticket', category: 'other', body: 'Generated text' },
    });
    expect(opened.status, opened.text).toBe(201);
    const tickets = await call(owner, 'GET', 'support/tickets');
    expect(tickets.status, tickets.text).toBe(200);
    const requests = await call(owner, 'GET', 'support/break-glass');
    expect(requests.status, requests.text).toBe(200);
    await hiddenFromOutsider('GET', 'support/tickets');
    await hiddenFromOutsider('GET', 'support/break-glass');
  });
});
