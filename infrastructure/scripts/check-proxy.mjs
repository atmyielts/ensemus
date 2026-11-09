#!/usr/bin/env node
// Runs the deployed proxy/Caddyfile, unchanged and with the settings Compose really resolves for it, and
// looks at what the app would be told. No stack test can do this: they all run proxy/Caddyfile.test,
// which sets the client address itself. It builds nothing and needs only the proxy's pinned image. Each
// case is a throwaway container with no network, reached over loopback, with a small upstream inside it
// standing in for web:3000 and repeating what it received.
//
// The connection always comes from loopback. So `trusted` says whether that one address is on the list,
// and the same request with the same claim is believed or not by that setting alone.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CADDYFILE = '/etc/caddy/Caddyfile';
const NAME = 'ensemus.example.invalid';
const LOCAL_ADDRESSES = ['127.0.0.1', '::1'];
const FORGED = '203.0.113.66';
const CLIENT = '198.51.100.7';
const READY_WITHIN_MS = 20_000;

// The /length/ answers are chunked, as Next.js sends every route's response, and some declare their
// length the way apps/web/src/lib/declared-length.ts does. One says it is encoded (br, which nothing on
// the way decodes), so its declared length is not the length of what is sent.
const UPSTREAM = `{
	admin off
	auto_https off
}
http://:3000 {
	handle /length/declared {
		header Transfer-Encoding chunked
		header X-Ensemus-Body-Length 5
		respond "hello" 200
	}
	handle /length/encoded {
		header Transfer-Encoding chunked
		header Content-Encoding br
		header X-Ensemus-Body-Length 5
		respond "hello" 200
	}
	handle /length/undeclared {
		header Transfer-Encoding chunked
		respond "hello" 200
	}
	handle {
		respond "xff={header.X-Forwarded-For}|xfh={header.X-Forwarded-Host}|xfp={header.X-Forwarded-Proto}|host={host}" 200
	}
}
`;
const START = `printf '%s' "$UPSTREAM" > /tmp/upstream
caddy run --adapter caddyfile --config /tmp/upstream &
exec caddy run --adapter caddyfile --config ${CADDYFILE}`;

let checked = 0;
const failures = [];

function check(label, actual, expected) {
  checked += 1;
  const passed = Array.isArray(expected) ? expected.includes(actual) : actual === expected;
  if (!passed) {
    failures.push(`${label}: got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`);
  }
}

/** The proxy service as Compose resolves it. Empty beats a .env file, and counts as not set. */
function resolvedProxy(hostname, trusted) {
  const output = execFileSync(
    'docker',
    ['compose', '-f', 'infrastructure/compose/compose.yaml', 'config', '--format', 'json'],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        ENSEMUS_HOSTNAME: hostname,
        ENSEMUS_TRUSTED_PROXIES: trusted,
      },
    },
  );
  return JSON.parse(output).services.proxy;
}

const runArguments = (proxy) => {
  const config = proxy.volumes.find((volume) => volume.target === CADDYFILE);
  return [
    '--network',
    'none',
    '--tmpfs',
    '/data',
    '--tmpfs',
    '/config',
    '-v',
    `${config.source}:${CADDYFILE}:ro`,
    ...Object.entries(proxy.environment ?? {}).flatMap(([name, value]) => [
      '-e',
      `${name}=${value}`,
    ]),
  ];
};

function request(container, host, headers = []) {
  const result = spawnSync(
    'docker',
    [
      'exec',
      container,
      'wget',
      '-q',
      '-O',
      '-',
      '-T',
      '5',
      '--no-check-certificate',
      ...headers.flatMap((header) => ['--header', header]),
      `https://${host}/`,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) return null;
  return Object.fromEntries(result.stdout.split('|').map((field) => field.split(/=(.*)/s)));
}

/** The body and the response headers (names in lower case) a client receives for a path. */
function fetched(container, host, path) {
  const result = spawnSync(
    'docker',
    [
      'exec',
      container,
      'wget',
      '-q',
      '-S',
      '-O',
      '-',
      '-T',
      '5',
      '--no-check-certificate',
      `https://${host}${path}`,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) return null;
  const headers = new Map();
  for (const line of result.stderr.split('\n')) {
    const field = /^\s*([A-Za-z0-9-]+):\s*(.*?)\s*$/.exec(line);
    if (field) headers.set(field[1].toLowerCase(), field[2]);
  }
  return { body: result.stdout, headers };
}

async function untilAnswered(container, host) {
  const deadline = Date.now() + READY_WITHIN_MS;
  while (Date.now() < deadline) {
    if (request(container, host)) return true;
    await new Promise((done) => setTimeout(done, 250));
  }
  return false;
}

/** Starts one proxy and removes it whatever happens. */
async function withProxy({ hostname = '', trusted = '', answersAs }, work) {
  const proxy = resolvedProxy(hostname, trusted);
  const label = `hostname "${hostname}", trusted "${trusted}"`;
  check(`${label}: Compose hands over the name`, proxy.environment?.ENSEMUS_HOSTNAME, answersAs);
  check(
    `${label}: Compose hands over the list`,
    proxy.environment?.ENSEMUS_TRUSTED_PROXIES,
    trusted,
  );

  const container = `ensemus-proxy-check-${randomUUID().slice(0, 12)}`;
  try {
    execFileSync(
      'docker',
      [
        'run',
        '-d',
        '--name',
        container,
        ...runArguments(proxy),
        '--add-host',
        'web:127.0.0.1',
        // Only IPv4, unlike localhost, so a connection to this name has one possible address.
        '--add-host',
        `${NAME}:127.0.0.1`,
        '-e',
        `UPSTREAM=${UPSTREAM}`,
        proxy.image,
        'sh',
        '-c',
        START,
      ],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (await untilAnswered(container, answersAs)) {
      await work(container, label);
    } else {
      const logs = spawnSync('docker', ['logs', '--tail', '15', container], { encoding: 'utf8' });
      failures.push(`${label}: never answered as ${answersAs}\n${logs.stdout}${logs.stderr}`);
    }
  } finally {
    spawnSync('docker', ['rm', '-f', '-v', container], { stdio: 'ignore' });
  }
}

// Nothing set: a direct client, and every claim it makes is discarded.
await withProxy({ answersAs: 'localhost' }, (container, label) => {
  const forged = request(container, 'localhost', [
    `X-Forwarded-For: ${FORGED}`,
    `X-Forwarded-Host: evil.example.invalid`,
    `X-Forwarded-Proto: http`,
  ]);
  check(`${label}: a forged address is replaced`, forged?.xff, LOCAL_ADDRESSES);
  check(`${label}: a forged host is replaced`, forged?.xfh, 'localhost');
  check(`${label}: a forged scheme is replaced`, forged?.xfp, 'https');
  check(`${label}: no claim`, request(container, 'localhost')?.xff, LOCAL_ADDRESSES);
  check(`${label}: another name is refused`, request(container, NAME), null);

  // Next.js drops Content-Length from a route's response. The proxy restores it from a length the app
  // declared, and only for an unencoded body, and the internal header never reaches a client.
  const declared = fetched(container, 'localhost', '/length/declared');
  check(`${label}: a declared length is sent whole`, declared?.body, 'hello');
  check(
    `${label}: a declared length becomes Content-Length`,
    declared?.headers.get('content-length'),
    '5',
  );
  check(
    `${label}: a declared body is not chunked`,
    declared?.headers.get('transfer-encoding'),
    undefined,
  );
  check(
    `${label}: the declared length header is not passed on`,
    declared?.headers.has('x-ensemus-body-length'),
    false,
  );
  const encoded = fetched(container, 'localhost', '/length/encoded');
  check(`${label}: an encoded body is still sent`, encoded?.body, 'hello');
  check(
    `${label}: an encoded body gets no declared length`,
    encoded?.headers.get('content-length'),
    undefined,
  );
  check(
    `${label}: nor is its declared length header passed on`,
    encoded?.headers.has('x-ensemus-body-length'),
    false,
  );
  const undeclared = fetched(container, 'localhost', '/length/undeclared');
  check(`${label}: an undeclared body is still sent`, undeclared?.body, 'hello');
  check(
    `${label}: an undeclared body is given no length`,
    undeclared?.headers.get('content-length'),
    undefined,
  );
});

// The hostname setting: the site answers as that name and no longer as localhost.
await withProxy({ hostname: NAME, answersAs: NAME }, (container, label) => {
  const answer = request(container, NAME, [`X-Forwarded-For: ${FORGED}`]);
  check(`${label}: it answers as the name`, answer?.host, NAME);
  check(`${label}: a forged address is replaced`, answer?.xff, '127.0.0.1');
  check(`${label}: localhost is refused`, request(container, 'localhost'), null);
});

// A list that does not name this connection is the same as no list.
await withProxy(
  { hostname: NAME, trusted: `192.0.2.0/24 ${FORGED}/32`, answersAs: NAME },
  (container, label) => {
    const answer = request(container, NAME, [`X-Forwarded-For: ${FORGED}`]);
    check(`${label}: a forged address is replaced`, answer?.xff, '127.0.0.1');
  },
);

// A host-level proxy on the list. The app accepts a single address and reads a chain as no address, so
// what it is told must always be one address, the rightmost one that nobody on the list vouches for.
await withProxy(
  { hostname: NAME, trusted: '127.0.0.1/32 10.0.0.0/8', answersAs: NAME },
  (container, label) => {
    const told = (...values) =>
      request(
        container,
        NAME,
        values.map((value) => `X-Forwarded-For: ${value}`),
      )?.xff;
    check(`${label}: the proxy's address for the client`, told(CLIENT), CLIENT);
    check(`${label}: a forgery the proxy added to`, told(`${FORGED}, ${CLIENT}`), CLIENT);
    check(`${label}: a forgery on a line of its own`, told(FORGED, CLIENT), CLIENT);
    check(`${label}: a forgery that is no address`, told(`not-an-address, ${CLIENT}`), CLIENT);
    check(`${label}: a further proxy on the list`, told(`${FORGED}, ${CLIENT}, 10.1.1.1`), CLIENT);
    check(`${label}: only proxies on the list`, told('10.1.1.1, 10.2.2.2'), '127.0.0.1');
    check(`${label}: nothing stated`, told(), '127.0.0.1');
    const forwarded = request(container, NAME, [`X-Forwarded-Host: public.example.invalid`]);
    check(`${label}: its public host is kept`, forwarded?.xfh, 'public.example.invalid');
  },
);

// A setting Caddy cannot read stops the proxy, rather than leaving it to run with a different list.
function accepts(trusted) {
  const proxy = resolvedProxy('', trusted);
  const validated = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      ...runArguments(proxy),
      proxy.image,
      'caddy',
      'validate',
      '--adapter',
      'caddyfile',
      '--config',
      CADDYFILE,
    ],
    { cwd: root, encoding: 'utf8' },
  );
  return validated.status === 0;
}
check('a list Caddy can read is accepted', accepts('10.0.0.0/8 192.0.2.1'), true);
check('a list Caddy cannot read stops the proxy', accepts('not-a-range'), false);

for (const failure of failures) console.error(`FAIL ${failure}`);
console.log(`Checked ${checked} behaviours of the deployed proxy, ${failures.length} failed.`);
process.exit(failures.length > 0 ? 1 : 0);
