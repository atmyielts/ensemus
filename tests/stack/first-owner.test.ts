// ID-01: a first owner on a default install, where sign-up is off, and the responsibility statement in
// each commercial mode. The web tier is recreated here with those settings, and restored afterwards.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BASE,
  createOrganization,
  type Person,
  PASSWORD,
  read,
  signUp,
  submit,
  tokenIn,
  visit,
} from '../helpers/forms';
import { compose, composeWith, urls } from '../helpers/stack';

const RECREATE_TIMEOUT = 180_000;

/** Recreates the web tier with these settings and waits until it answers. */
function recreateWeb(env: Record<string, string>) {
  composeWith(env, 'up', '-d', '--no-deps', '--force-recreate', '--wait', 'web');
}

/** The operator's documented command. Its output is the only place the code ever exists. */
function issueCode(): string {
  const output = compose(
    'run',
    '--rm',
    '--no-deps',
    '-T',
    'migrate',
    'node',
    'dist/setup-token.js',
  );
  const code = /^[A-Za-z0-9_-]{43}$/m.exec(output)?.[0];
  if (!code) throw new Error('The setup command printed no code');
  return code;
}

const newEmail = () => `first-${randomUUID()}@example.invalid`;

async function useCode(code: string, email = newEmail(), password = PASSWORD, page = '/setup') {
  const person: Person = { jar: { cookie: '' }, name: 'Fay First', email };
  const response = await submit(page, person.jar, /name="code"/, {
    code,
    name: person.name,
    email,
    password,
  });
  return { person, response, location: response.headers.get('location') ?? '' };
}

describe('a first owner on a default install (ID-01)', () => {
  let su: pg.Client;

  const accounts = async (email: string) => {
    const { rows } = await su.query(
      'select count(*)::int as n from identity.users where email = $1',
      [email],
    );
    return rows[0].n as number;
  };

  beforeAll(async () => {
    su = new pg.Client({ connectionString: urls.superuser() });
    await su.connect();
    recreateWeb({ ENSEMUS_ALLOW_SIGNUP: 'false' });
  }, RECREATE_TIMEOUT);

  // Every other stack test expects sign-up on and the default mode.
  afterAll(async () => {
    recreateWeb({});
    await su?.end();
  }, RECREATE_TIMEOUT);

  describe('with sign-up off', () => {
    it('keeps sign-up shut, on the page and on the API', async () => {
      expect((await read('/sign-up')).status).toBe(404);
      const email = newEmail();
      // The sign-up route allows 5 a minute from one address, and every stack test comes from one.
      // Refused by the rate limit would prove nothing about sign-up, and this attempt should not
      // use up what the next test file needs.
      const forgetAttempts = () =>
        su.query(`delete from identity.rate_limits where key like '%sign-up%'`);
      await forgetAttempts();
      const direct = await fetch(`${BASE}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE },
        body: JSON.stringify({ name: 'Nobody', email, password: PASSWORD }),
      });
      await forgetAttempts();
      expect(direct.status).toBe(400);
      expect(((await direct.json()) as { code: string }).code).toBe(
        'EMAIL_PASSWORD_SIGN_UP_DISABLED',
      );
      expect(await accounts(email)).toBe(0);
      const signIn = (await read('/sign-in')).html;
      expect(signIn).not.toContain('Create an account');
      expect(signIn).toContain('Given a setup code?');
    });

    it('takes someone with a code from the operator to a working organization', async () => {
      const code = issueCode();
      const { person, response, location } = await useCode(code);
      expect(response.status).toBe(303);
      expect(location).toBe('/');
      // In the form and in no URL, so it stays out of browser history and proxy logs.
      expect(location).not.toContain(code);

      const setup = await read('/', person.jar);
      expect(setup.status).toBe(200);
      expect(setup.html).toContain('Set up your organization');
      expect(setup.html).toContain('Who is responsible for your data');

      const name = `First ${randomUUID()}`;
      const organization = await createOrganization(person, name);
      const home = await read(`/o/${organization}`, person.jar);
      expect(home.status).toBe(200);
      expect(home.html).toContain(name);
      const { rows } = await su.query(
        `select m.role from org.memberships m join identity.users u on u.id = m.user_id
         where u.email = $1 and m.organization_id = $2`,
        [person.email, organization],
      );
      expect(rows).toEqual([{ role: 'owner' }]);

      const created = await submit(`/o/${organization}/work/new`, person.jar, /name="title"/, {
        title: `First work ${randomUUID()}`,
        classification: 'internal',
      });
      expect(created.headers.get('location')).toMatch(/\/work\/[0-9a-f-]{36}$/);
    });

    it('works once', async () => {
      const code = issueCode();
      expect((await useCode(code)).location).toBe('/');
      const second = await useCode(code);
      expect(second.location).toBe('/setup?error=code');
      expect(await accounts(second.person.email)).toBe(0);
      expect(second.person.jar.cookie).not.toContain('session_token');
      expect((await read(second.location)).html).toContain('That setup code does not work');
    });

    it('refuses a guess and a code that ran out, and says the same about both', async () => {
      const guess = await useCode('x'.repeat(43));
      expect(guess.location).toBe('/setup?error=code');
      expect(await accounts(guess.person.email)).toBe(0);

      const code = issueCode();
      await su.query(`update identity.setup_tokens set expires_at = now() - interval '1 second'
                      where used_at is null and expires_at > now()`);
      const late = await useCode(code);
      expect(late.location).toBe('/setup?error=code');
      expect(await accounts(late.person.email)).toBe(0);
    });

    it('keeps the code working when the details were the problem', async () => {
      const code = issueCode();
      const email = newEmail();
      const refused = await useCode(code, email, 'too short');
      expect(refused.location).toBe('/setup?error=details');
      expect((await read(refused.location)).html).toContain('your setup code still works');
      expect(await accounts(email)).toBe(0);
      expect((await useCode(code, email)).location).toBe('/');
      expect(await accounts(email)).toBe(1);
    });

    it('stores only a hash, and leaves the code out of the logs', async () => {
      const code = issueCode();
      await useCode(code);
      const { rows } = await su.query('select * from identity.setup_tokens');
      expect(JSON.stringify(rows)).not.toContain(code);
      expect(compose('logs', '--no-log-prefix', 'web')).not.toContain(code);
      expect(compose('logs', '--no-log-prefix', 'migrate')).not.toContain(code);
    });

    it('gives the new account nothing but itself', async () => {
      const someone = await useCode(issueCode());
      const other = await useCode(issueCode());
      const theirs = await createOrganization(other.person, `Theirs ${randomUUID()}`);
      expect((await visit(`/o/${theirs}`, someone.person.jar)).status).toBe(404);
    });

    it('also lets someone invited get an account, and keeps their place', async () => {
      const inviter = await useCode(issueCode());
      const organization = await createOrganization(inviter.person, `Invites ${randomUUID()}`);
      const email = newEmail();
      const invited = await submit(
        `/o/${organization}/people`,
        inviter.person.jar,
        /name="email"/,
        { email, role: 'member' },
      );
      const token = tokenIn(await invited.text());
      if (!token) throw new Error('No invitation link');
      const here = `/invite/${token}`;
      expect((await read(here)).html).toContain('setup code');

      const { person, location } = await useCode(
        issueCode(),
        email,
        PASSWORD,
        `/setup?next=${encodeURIComponent(here)}`,
      );
      expect(location).toBe(here);
      const asked = await submit(here, person.jar, /Accept invitation/);
      // Nothing has proven the address, so someone still has to confirm it.
      expect(asked.headers.get('location')).toBe(`${here}?state=waiting`);
    });
  });

  // What each mode says, in the words of docs/01-product/05-commercial-modes.md.
  const STATEMENTS: Record<string, { present: string[]; absent: string[] }> = {
    cloud: {
      present: ['Ensemus Cloud', 'Ensemus hosts this service and stores', 'approved AI model'],
      absent: ['on infrastructure it controls', 'This is not zero-knowledge'],
    },
    byom: {
      present: ['Ensemus with your own models', 'with your own keys', 'This is not zero-knowledge'],
      absent: ['on infrastructure it controls', 'Ensemus supplies the approved'],
    },
    sovereign: {
      present: [
        'Ensemus Sovereign',
        'on infrastructure it controls',
        'responsible for operating, securing and backing up',
      ],
      absent: ['Ensemus hosts this service', 'This is not zero-knowledge'],
    },
  };

  describe.each(Object.keys(STATEMENTS))('in %s mode', (mode) => {
    beforeAll(() => {
      recreateWeb({ ENSEMUS_ALLOW_SIGNUP: 'false', ENSEMUS_MODE: mode });
    }, RECREATE_TIMEOUT);

    it('states who is responsible before anything exists, and records the mode', async () => {
      const { person } = await useCode(issueCode());
      const { status, html } = await read('/', person.jar);
      expect(status).toBe(200);
      const main = /<main[\s\S]*<\/main>/.exec(html)?.[0] ?? '';
      expect(main).toContain('Who is responsible for your data');
      expect(main).toContain('AI features are not active yet');
      for (const words of STATEMENTS[mode]?.present ?? []) expect(main).toContain(words);
      for (const words of STATEMENTS[mode]?.absent ?? []) expect(main).not.toContain(words);
      expect(main).not.toMatch(/SOC ?2|ISO ?27001|HIPAA|certified/i);

      const organization = await createOrganization(person, `Mode ${randomUUID()}`);
      const { rows } = await su.query(
        'select commercial_mode from org.organizations where id = $1',
        [organization],
      );
      expect(rows).toEqual([{ commercial_mode: mode }]);
    });
  });
});

describe('with sign-up on', () => {
  it('needs no code, and a code still works', async () => {
    const person = await signUp('Open Sign-Up');
    expect((await read('/', person.jar)).html).toContain('Set up your organization');
    expect((await useCode(issueCode())).location).toBe('/');
  });
});
