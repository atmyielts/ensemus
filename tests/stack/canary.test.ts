// NEXT-02: server-only values never reach a browser. Real values are planted in the fields that must
// stay on the server, then every tenant page, every RSC payload and every built client file is read as
// each kind of person would receive them. Each scan is paired with a control, so a page that simply
// failed to render, or a header that was ignored, cannot pass as "nothing leaked".
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BASE,
  createOrganization,
  type Jar,
  join,
  type Person,
  read,
  signUp,
  submit,
  tokenIn,
} from '../helpers/forms';
import { createWork, membershipOf, workPage } from '../helpers/flows';
import { compose, repoRoot, urls } from '../helpers/stack';

const canary = (kind: string) => `CANARY${kind}${randomUUID().replaceAll('-', '')}`;

type Received = { status: number; type: string; body: string };

/** How the framework asks for the same page: as HTML, as an RSC payload, and as a prefetch of one. */
const REQUESTS: Array<[string, Record<string, string>]> = [
  ['html', {}],
  ['rsc', { rsc: '1' }],
  ['prefetch', { rsc: '1', 'next-router-prefetch': '1' }],
];

async function receive(path: string, jar: Jar, headers: Record<string, string>): Promise<Received> {
  let url = `${BASE}${path}`;
  for (;;) {
    const response = await fetch(url, {
      headers: { cookie: jar.cookie, ...headers },
      redirect: 'manual',
    });
    // Next.js sends an RSC request without its cache-busting value back for one, as the router has.
    const location = response.headers.get('location');
    if (response.status === 307 && location && /[?&]_rsc\b/.test(location)) {
      url = new URL(location, BASE).href;
      continue;
    }
    return {
      status: response.status,
      type: response.headers.get('content-type') ?? '',
      body: await response.text(),
    };
  }
}

/** Every secret a deployment holds, except the public half of the sealing key, which is public. */
const serverSecrets = () =>
  readdirSync(joinPath(repoRoot, '.local', 'secrets'))
    .filter((file) => !file.endsWith('public_key.pem'))
    .map((file) => ({
      file,
      value: readFileSync(joinPath(repoRoot, '.local', 'secrets', file), 'utf8').trim(),
    }));

describe('what the browser receives (NEXT-02)', () => {
  let su: pg.Client;
  let owner: Person;
  let member: Person;
  let insider: Person;
  let reviewer: Person;
  let org: string;
  let restricted: string;
  let approval: string;
  let invited: string;

  const objective = canary('OBJECTIVE');
  const title = canary('TITLE');
  const actionField = canary('ACTION');
  const plantedHash = canary('TOKENHASH');
  let realHash: string;
  let passwordHash: string;

  /** Held by nobody's browser, whoever they are. */
  const neverSent = () => [
    { name: 'planted token hash', value: plantedHash },
    { name: 'real token hash', value: realHash },
    { name: 'password hash', value: passwordHash },
    { name: 'field name tokenHash', value: 'tokenHash' },
    { name: 'field name token_hash', value: 'token_hash' },
    ...serverSecrets().map(({ file, value }) => ({ name: `secret ${file}`, value })),
  ];
  const onRestrictedWork = () => [
    { name: 'objective', value: objective },
    { name: 'title', value: title },
    { name: 'action payload', value: actionField },
  ];

  const pagesFor = () => [
    '/',
    `/o/${org}`,
    `/o/${org}/work`,
    `/o/${org}/work/new`,
    workPage(org, restricted),
    `/o/${org}/approvals`,
    `/o/${org}/approvals/${approval}`,
    `/o/${org}/people`,
    `/o/${org}/clients`,
    `/o/${org}/inbox`,
    `/api/v1/organizations/${org}/work-units`,
    `/api/v1/organizations/${org}/approvals`,
  ];

  async function scan(person: Person, secrets: Array<{ name: string; value: string }>) {
    const found: string[] = [];
    const seen: Received[] = [];
    for (const path of pagesFor()) {
      for (const [mode, headers] of REQUESTS) {
        const received = await receive(path, person.jar, headers);
        seen.push(received);
        // A page that answered an RSC request with anything else was not really read as one.
        if (mode !== 'html' && received.status === 200 && !path.startsWith('/api/')) {
          expect(received.type, `${mode} ${path}`).toContain('text/x-component');
        }
        for (const { name, value } of secrets) {
          if (received.body.includes(value)) found.push(`${name} in ${mode} ${path}`);
        }
      }
    }
    return { found, seen };
  }

  beforeAll(async () => {
    su = new pg.Client({ connectionString: urls.superuser() });
    await su.connect();
    owner = await signUp('Olive Owner');
    org = await createOrganization(owner, `Canary ${randomUUID()}`);
    member = await join(owner, org, 'Milo Member');
    insider = await join(owner, org, 'Ines Insider');
    reviewer = await join(owner, org, 'Remy Reviewer');

    // Restricted work the owner of the organization and an ordinary member have no access to.
    restricted = await createWork(insider, org, {
      title,
      objective,
      classification: 'restricted',
      criteria: ['reviewer_approved'],
    });
    const page = workPage(org, restricted);
    await submit(page, insider.jar, /Add someone/, {
      membershipId: await membershipOf(su, reviewer, org),
    });
    await submit(page, insider.jar, /Request review/, {
      approverMembershipId: await membershipOf(su, reviewer, org),
    });
    approval =
      /\/approvals\/([0-9a-f-]{36})"/.exec((await read(page, insider.jar)).html)?.[1] ?? '';
    if (!approval) throw new Error('No approval link');
    await su.query(
      `update work.approvals set action = action || jsonb_build_object('note', $1::text) where id = $2`,
      [actionField, approval],
    );

    // Two open invitations: one whose stored hash is planted, and one whose hash is the real thing.
    invited = `invited-${randomUUID()}@example.invalid`;
    const people = `/o/${org}/people`;
    await submit(people, owner.jar, /name="email"/, { email: invited, role: 'member' });
    await su.query('update org.invitations set token_hash = $1 where email = $2', [
      plantedHash,
      invited,
    ]);
    const second = `second-${randomUUID()}@example.invalid`;
    const response = await submit(people, owner.jar, /name="email"/, {
      email: second,
      role: 'member',
    });
    expect(tokenIn(await response.text())).toBeDefined();
    const hashes = await su.query('select token_hash from org.invitations where email = $1', [
      second,
    ]);
    realHash = hashes.rows[0].token_hash;
    const accounts = await su.query(
      `select a.password from identity.accounts a join identity.users u on u.id = a.user_id
       where u.email = $1 and a.password is not null`,
      [owner.email],
    );
    passwordHash = accounts.rows[0].password;
    expect(passwordHash.length).toBeGreaterThan(20);
  });

  afterAll(() => su?.end());

  it('never sends a member with no access anything of restricted work, or anything server-only', async () => {
    const { found, seen } = await scan(member, [...onRestrictedWork(), ...neverSent()]);
    expect(found).toEqual([]);
    expect(seen.some((page) => page.status === 200 && page.type.includes('x-component'))).toBe(
      true,
    );
    const asMember = await receive(workPage(org, restricted), member.jar, {});
    expect(asMember.status).toBe(404);
  });

  it('never sends the owner of the organization restricted work they are not on', async () => {
    const { found } = await scan(owner, [...onRestrictedWork(), ...neverSent()]);
    expect(found).toEqual([]);
  });

  it('lists invitations for the owner without their hashes', async () => {
    for (const [mode, headers] of REQUESTS) {
      const { status, type, body } = await receive(`/o/${org}/people`, owner.jar, headers);
      expect(status, mode).toBe(200);
      // Control: this is the row the hash is on, and this response really is what it asked for.
      if (mode !== 'prefetch') expect(body, mode).toContain(invited);
      expect(type, mode).toContain(mode === 'html' ? 'text/html' : 'text/x-component');
      expect(body.includes(plantedHash), mode).toBe(false);
      expect(body.includes(realHash), mode).toBe(false);
    }
  });

  it('sends someone on the work only what the page shows them, in every form of the page', async () => {
    // Control for the scans above: the same requests do carry these, for someone allowed to see them.
    for (const [mode, headers] of REQUESTS) {
      const work = await receive(workPage(org, restricted), insider.jar, headers);
      expect(work.status, mode).toBe(200);
      // A prefetch stops at the page's loading state, so it has nothing to show as a control.
      if (mode !== 'prefetch') {
        expect(work.body, mode).toContain(title);
        expect(work.body, mode).toContain(objective);
      }
      // The payload is for the decision page, not for everything that mentions the review.
      expect(work.body.includes(actionField), mode).toBe(false);
    }
    const decision = await receive(`/o/${org}/approvals/${approval}`, reviewer.jar, {});
    expect(decision.status).toBe(200);
    expect(decision.body).toContain(actionField);
    const payload = await receive(`/o/${org}/approvals/${approval}`, reviewer.jar, { rsc: '1' });
    expect(payload.type).toContain('text/x-component');
    expect(payload.body).toContain(actionField);

    const lists = [`/o/${org}/approvals`, `/o/${org}`, `/o/${org}/inbox`, `/o/${org}/work`];
    for (const path of lists) {
      for (const [mode, headers] of REQUESTS) {
        const { body } = await receive(path, reviewer.jar, headers);
        expect(body.includes(actionField), `${mode} ${path}`).toBe(false);
      }
    }

    const insiderScan = await scan(insider, neverSent());
    const reviewerScan = await scan(reviewer, neverSent());
    expect([...insiderScan.found, ...reviewerScan.found]).toEqual([]);
  });

  it('puts none of it in any built client file', async () => {
    const files = compose('exec', '-T', 'web', 'find', '/app/apps/web/.next/static', '-type', 'f')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.replace('/app/apps/web/.next/static', '/_next/static'));
    const scripts = files.filter((file) => file.endsWith('.js'));
    expect(scripts.length).toBeGreaterThan(5);

    // Control: what a real page loads is on this list, so the list is the one that is served.
    const loaded = [
      ...(await read(`/o/${org}`, owner.jar)).html.matchAll(/\/_next\/static\/[^"'\\ ?]+\.js/g),
    ].map((match) => match[0]);
    expect(loaded.length).toBeGreaterThan(0);
    for (const script of loaded) expect(files).toContain(script);

    const forbidden = [
      ...neverSent(),
      ...onRestrictedWork(),
      // What server code would bring with it, if any of it ever reached a client bundle.
      ...[
        'postgres://',
        'BEGIN PRIVATE KEY',
        'DATABASE_URL_',
        'AUTH_SECRET',
        'TEMPORAL_CODEC',
        'OBJECT_STORAGE_SECRET',
        'SECRET_SEALING_PRIVATE',
        'NEXT_SERVER_ACTIONS_ENCRYPTION',
        'set_config',
        'drizzle-orm',
      ].map((value) => ({ name: `server marker ${value}`, value })),
    ];
    const found: string[] = [];
    for (let at = 0; at < files.length; at += 16) {
      await Promise.all(
        files.slice(at, at + 16).map(async (file) => {
          const response = await fetch(`${BASE}${file}`);
          expect(response.status, file).toBe(200);
          const bytes = Buffer.from(await response.arrayBuffer());
          for (const { name, value } of forbidden) {
            if (bytes.includes(value)) found.push(`${name} in ${file}`);
          }
        }),
      );
    }
    expect(found).toEqual([]);
  });
});
