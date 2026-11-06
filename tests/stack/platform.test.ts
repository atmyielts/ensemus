// PLAT-11, PLAT-12, PLAT-15, ASSUR-01, ID-03, SEC-10, NEXT-02, NEXT-04, against built images.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectClient, startProbe } from '@ensemus/workflows/client';
import {
  pinProblems,
  pinsOf,
  SHIPPED_CONNECTIONS,
  TEST_CONNECTIONS,
  type ResolvedConfig,
} from '../helpers/compose-pins';
import { compose, repoRoot, secret, urls } from '../helpers/stack';
import { createOrganization, openAppDatabase } from '@ensemus/database';
import { WorkflowFailedError } from '@temporalio/client';
import { releaseProbeSignal } from '@ensemus/workflows/workflows';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // The proxy uses a local test certificate.

const BASE = 'https://localhost:8443';
const PASSWORD = 'correct horse battery staple';
const inContainer = (service: string, ...args: string[]) => compose('exec', '-T', service, ...args);
const nodeIn = (service: string, script: string) => inContainer(service, 'node', '-e', script);

async function signUp() {
  const email = `${randomUUID()}@example.invalid`;
  const response = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ name: 'Stack User', email, password: PASSWORD }),
  });
  expect(response.status).toBe(200);
  const { user } = (await response.json()) as { user: { id: string } };
  const cookie = response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  return { userId: user.id, cookie };
}

describe('web tier behind the proxy', () => {
  it('reports ready, naming no versions or dependencies', async () => {
    const response = await fetch(`${BASE}/api/health/ready`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ready' });
  });

  it('sends security headers and hides the framework', async () => {
    const { headers } = await fetch(`${BASE}/sign-in`);
    expect(headers.get('x-powered-by')).toBeNull();
    expect(headers.get('x-frame-options')).toBe('DENY');
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('strict-transport-security')).toContain('max-age');
  });

  it('sends anonymous visitors to sign-in', async () => {
    const response = await fetch(`${BASE}/`, { redirect: 'manual' });
    expect([303, 307]).toContain(response.status);
    expect(response.headers.get('location')).toContain('/sign-in');
  });

  it('sets a Secure, HttpOnly session cookie', async () => {
    const response = await fetch(`${BASE}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({
        name: 'Cookie',
        email: `${randomUUID()}@example.invalid`,
        password: PASSWORD,
      }),
    });
    const cookie = response.headers.getSetCookie().find((c) => c.includes('session_token'));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it('refuses an auth request from another origin', async () => {
    const response = await fetch(`${BASE}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({
        name: 'x',
        email: `${randomUUID()}@example.invalid`,
        password: PASSWORD,
      }),
    });
    expect(response.status).toBe(403);
  });
});

describe('two tenants through the real pages', () => {
  const app = () => openAppDatabase(urls.app());
  let orgId: string;
  let member: { cookie: string; userId: string };
  let outsider: { cookie: string; userId: string };
  let database: ReturnType<typeof app>;
  const orgName = `Org ${randomUUID()}`;

  beforeAll(async () => {
    database = app();
    member = await signUp();
    outsider = await signUp();
    ({ organizationId: orgId } = await createOrganization(database.db, {
      userId: member.userId,
      name: orgName,
      commercialMode: 'sovereign',
    }));
  });
  afterAll(() => database?.close());

  it('shows the organization to its member', async () => {
    const response = await fetch(`${BASE}/o/${orgId}`, { headers: { cookie: member.cookie } });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(orgName);
  });

  it('gives an outsider the same 404 as a missing organization, with no content', async () => {
    const forbidden = await fetch(`${BASE}/o/${orgId}`, { headers: { cookie: outsider.cookie } });
    const missing = await fetch(`${BASE}/o/${randomUUID()}`, {
      headers: { cookie: outsider.cookie },
    });
    expect(forbidden.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await forbidden.text()).not.toContain(orgName);
  });

  it('never lists another tenant on the home page', async () => {
    const response = await fetch(`${BASE}/`, { headers: { cookie: outsider.cookie } });
    expect(await response.text()).not.toContain(orgName);
  });
});

describe('web tier isolation (ADR-024 D3, D5)', () => {
  it('shares no network with Temporal', () => {
    const networksOf = (service: string) =>
      Object.keys(
        JSON.parse(
          execFileSync(
            'docker',
            [
              'inspect',
              compose('ps', '-q', service).trim(),
              '--format',
              '{{json .NetworkSettings.Networks}}',
            ],
            { encoding: 'utf8' },
          ),
        ),
      );
    const web = networksOf('web');
    expect(web.length).toBeGreaterThan(0);
    for (const network of networksOf('temporal')) expect(web).not.toContain(network);
  });

  // This lookup is itself an outbound DNS query, so the air-gap gate would rightly count it.
  it.skipIf(process.env.ENSEMUS_COMPOSE_AIRGAP)('cannot resolve Temporal by name', () => {
    const output = nodeIn(
      'web',
      `require('dns').lookup('temporal',(e)=>{process.stdout.write(e?'blocked':'resolved')})`,
    );
    expect(output).toBe('blocked');
  });

  it('cannot reach Temporal by IP address, on any of its networks', () => {
    // Read from Docker, not looked up in a container: a lookup would itself be outbound DNS.
    const addresses = execFileSync(
      'docker',
      [
        'inspect',
        compose('ps', '-q', 'temporal').trim(),
        '--format',
        '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}',
      ],
      { encoding: 'utf8' },
    )
      .trim()
      .split(/\s+/);
    expect(addresses.length).toBeGreaterThanOrEqual(2);
    for (const address of addresses) {
      const output = nodeIn(
        'web',
        `const s=require('net').connect({host:'${address}',port:7233,timeout:3000});` +
          `s.on('connect',()=>{process.stdout.write('connected');s.destroy()});` +
          `s.on('timeout',()=>{process.stdout.write('blocked');s.destroy()});` +
          `s.on('error',()=>process.stdout.write('blocked'));`,
      );
      expect(output, address).toBe('blocked');
    }
  });

  it('publishes no port except the proxy, in the deployed configuration', () => {
    // Asks Compose for the resolved base file, without the test overlay.
    const config = JSON.parse(
      execFileSync(
        'docker',
        ['compose', '-f', 'infrastructure/compose/compose.yaml', 'config', '--format', 'json'],
        { cwd: repoRoot, encoding: 'utf8' },
      ),
    ) as { services: Record<string, { ports?: unknown[] }> };
    const publishing = Object.entries(config.services)
      .filter(([, service]) => service.ports?.length)
      .map(([name]) => name);
    expect(publishing).toEqual(['proxy']);
  });

  const resolvedConfig = (...files: string[]) =>
    JSON.parse(
      execFileSync(
        'docker',
        ['compose', ...files.flatMap((file) => ['-f', file]), 'config', '--format', 'json'],
        { cwd: repoRoot, encoding: 'utf8' },
      ),
    ) as ResolvedConfig;

  it('pins every internal name a service could look up, so an outage sends none off the network', () => {
    const config = resolvedConfig('infrastructure/compose/compose.yaml');
    expect(pinProblems(config, SHIPPED_CONNECTIONS)).toEqual([]);
    expect(pinsOf(config, 'web')).not.toHaveProperty('temporal');
  });

  // The air-gap gate runs with this overlay, and its second replica has to hold to the same rule.
  it('pins the names the test overlay adds as well', () => {
    const config = resolvedConfig(
      'infrastructure/compose/compose.yaml',
      'infrastructure/compose/compose.test.yaml',
    );
    expect(pinProblems(config, TEST_CONNECTIONS)).toEqual([]);
    expect(pinsOf(config, 'web-2')).not.toHaveProperty('temporal');
  });

  it('control: the worker can reach Temporal the same way', () => {
    const output = nodeIn(
      'worker',
      `const s=require('net').connect({host:'temporal',port:7233,timeout:3000});` +
        `s.on('connect',()=>{process.stdout.write('connected');s.destroy()});` +
        `s.on('error',()=>process.stdout.write('blocked'));`,
    );
    expect(output).toBe('connected');
  });

  it('has no Temporal code in the web image', () => {
    const output = inContainer(
      'web',
      'sh',
      '-c',
      'ls /app/node_modules/.pnpm | grep -c temporalio || true',
    );
    expect(output.trim()).toBe('0');
  });

  it('holds no private key, in its secrets or its environment', () => {
    const mounted = inContainer('web', 'ls', '/run/secrets');
    expect(mounted).toContain('sealing_public_key.pem');
    expect(mounted).not.toContain('private');
    expect(mounted).not.toContain('temporal_codec_key');
    expect(mounted).not.toContain('db_secrets_url');
    const env = inContainer('web', 'env');
    expect(env).not.toContain('PRIVATE');
    expect(env).not.toContain('BEGIN');
  });

  it('cannot read sealed secrets with its own database credentials', () => {
    const output = nodeIn(
      'web',
      `const {Client}=require('/app/node_modules/.pnpm/node_modules/pg');` +
        `const c=new Client({connectionString:require('fs').readFileSync('/run/secrets/db_app_url','utf8').trim()});` +
        `c.connect().then(()=>c.query('select * from secrets.sealed_secrets')).then(()=>process.stdout.write('read'),e=>process.stdout.write(e.code)).finally(()=>c.end())`,
    );
    expect(output).toBe('42501');
  });

  it('runs as a non-root user on a read-only filesystem', () => {
    expect(inContainer('web', 'id', '-u').trim()).not.toBe('0');
    expect(inContainer('worker', 'id', '-u').trim()).not.toBe('0');
    const output = nodeIn(
      'web',
      `try{require('fs').writeFileSync('/app/x','x');process.stdout.write('wrote')}catch{process.stdout.write('denied')}`,
    );
    expect(output).toBe('denied');
  });
});

describe('secrets in what the browser receives (SEC-10, NEXT-02)', () => {
  const secretValues = () =>
    readdirSync(join(repoRoot, '.local', 'secrets'))
      .filter((f) => !f.endsWith('public_key.pem'))
      .map((f) => readFileSync(join(repoRoot, '.local', 'secrets', f), 'utf8').trim());

  it('sends no secret value in any page or script', async () => {
    const { cookie } = await signUp();
    const pages = await Promise.all(
      ['/', '/sign-in', '/sign-up', '/api/health/ready', '/api/auth/get-session'].map((path) =>
        fetch(`${BASE}${path}`, { headers: { cookie } }).then((r) => r.text()),
      ),
    );
    const scripts = [...pages.join('').matchAll(/\/_next\/static\/[^"'\\ ]+\.js/g)].map(
      (m) => m[0],
    );
    expect(scripts.length).toBeGreaterThan(0);
    const bundles = await Promise.all(
      [...new Set(scripts)].map((s) => fetch(`${BASE}${s}`).then((r) => r.text())),
    );
    const received = [...pages, ...bundles].join('\n');
    for (const value of secretValues()) expect(received.includes(value)).toBe(false);
  });

  it('bakes no secret into the images', () => {
    const scan = (service: string, value: string) =>
      inContainer(
        service,
        'sh',
        '-c',
        `grep -rlF -- "$0" /app 2>/dev/null | head -1 || true`,
        value,
      ).trim();
    for (const name of ['auth_secret', 'db_app_password', 'temporal_codec_key']) {
      expect(scan('web', secret(name)), name).toBe('');
      expect(scan('worker', secret(name)), name).toBe('');
    }
    // Reads every file in both images six times, which takes minutes on Docker Desktop.
  }, 300_000);

  it('refuses to start without a per-deployment Server Action key', () => {
    const result = spawnSync('docker', ['run', '--rm', 'ensemus/web:local'], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Refusing to start');
  });

  it('leaves the unused LGPL image library out of the web image', () => {
    const output = inContainer('web', 'sh', '-c', 'find /app -type d -path "*@img*" | wc -l');
    expect(output.trim()).toBe('0');
  });
});

describe('durable execution, independent of the web tier (PLAT-12, NEXT-04)', () => {
  let temporal: Awaited<ReturnType<typeof connectClient>>;

  beforeAll(async () => {
    temporal = await connectClient({
      address: '127.0.0.1:57233',
      namespace: 'default',
      codecKey: secret('temporal_codec_key'),
    });
  });
  afterAll(() => temporal?.close());

  const logs = () => compose('logs', '--no-log-prefix', 'worker');

  it('keeps running while the web tier restarts', async () => {
    const probeId = randomUUID();
    const handle = await startProbe(temporal.client, { probeId });
    compose('restart', 'web');
    await handle.signal(releaseProbeSignal);
    await expect(handle.result()).resolves.toEqual({ probeId, outcome: 'completed', steps: 2 });
  });

  it('resumes a waiting workflow after the worker restarts', async () => {
    const probeId = randomUUID();
    const handle = await startProbe(temporal.client, { probeId });
    await expect.poll(logs, { timeout: 30_000 }).toContain(probeId);
    compose('restart', 'worker');
    await handle.signal(releaseProbeSignal);
    await expect(handle.result()).resolves.toMatchObject({ probeId, outcome: 'completed' });
  });

  it('honors cancellation', async () => {
    const handle = await startProbe(temporal.client, { probeId: randomUUID() });
    await handle.cancel();
    await expect(handle.result()).rejects.toBeInstanceOf(WorkflowFailedError);
  });

  it('logs identifiers only', async () => {
    const output = logs();
    expect(output).toContain('probe.step');
    expect(output).not.toMatch(/password|BEGIN PRIVATE/i);
  });
});

describe('database in the deployed stack', () => {
  it('applied migrations through the one-shot job', async () => {
    const client = new pg.Client({ connectionString: urls.superuser() });
    await client.connect();
    const { rows } = await client.query(
      'select count(*)::int as n from drizzle.__drizzle_migrations',
    );
    expect(rows[0].n).toBeGreaterThanOrEqual(2);
    await client.end();
  });
});
