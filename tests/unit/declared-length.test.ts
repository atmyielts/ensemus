// Next.js 16.4.5 drops Content-Length from a route's response (next/dist/server/send-response.js), so a
// download declares its length in a header of its own and the proxy restores Content-Length from it
// (apps/web/src/lib/declared-length.ts). These hold the app's half, and hold every proxy in front of the
// app to the same rule. infrastructure/scripts/check-proxy.mjs runs the deployed proxy with it, and
// tests/stack/sovereign-api.test.ts and tests/stack/work-file-download.test.ts see real downloads arrive
// with their length.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DECLARED_LENGTH_HEADER, declaredLength } from '../../apps/web/src/lib/declared-length';
import { repoRoot } from '../helpers/stack';

const read = (path: string) => readFileSync(join(repoRoot, path), 'utf8');
const PROXIES = [
  'infrastructure/compose/proxy/Caddyfile',
  'infrastructure/compose/proxy/Caddyfile.test',
];
const ROUTES = [
  'apps/web/src/app/api/v1/organizations/[organizationId]/imports/[importId]/files/[sourceArtifactId]/download/route.ts',
  'apps/web/src/app/api/v1/organizations/[organizationId]/exports/[exportId]/archive/route.ts',
  'apps/web/src/app/o/[organizationId]/work/[workUnitId]/files/[fileId]/route.ts',
];

/** Every Route Handler in the app, by its path from the repository root. */
const routeHandlers = () =>
  readdirSync(join(repoRoot, 'apps/web/src/app'), { recursive: true, encoding: 'utf8' })
    .filter((path) => /(^|[\\/])route\.tsx?$/.test(path))
    .map((path) => `apps/web/src/app/${path.replaceAll('\\', '/')}`);

/** A Content-Length a route sets by itself, which Next.js drops without a word. Comments left out. */
const bareLength = (source: string) =>
  /['"`]content-length['"`]\s*:/i.test(
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''),
  );

/**
 * Every Cache-Control a download states, in its route and in the headers helper it spreads. The app's own
 * compression gzips a text, CSV or tar body unless told no-transform, and an encoded body leaves with no
 * Content-Length at all, so a declared length holds only for a body nothing may transform.
 */
const cacheControls = (route: string) => {
  const source = read(route);
  const helpers = source.includes('...archiveHeaders(')
    ? [read('apps/web/src/server/sovereign-dto.ts')]
    : [];
  return [source, ...helpers].flatMap((text) =>
    [...text.matchAll(/['"]Cache-Control['"]\s*:\s*['"]([^'"]*)['"]/g)].map(([, value]) => value),
  );
};
const transformable = (values: (string | undefined)[]) =>
  values.length === 0 || values.some((value) => !/(^|,)\s*no-transform\s*(,|$)/.test(value ?? ''));

/** The body of each `<directive> ... {` block, braces matched, comments left out. */
function blocks(source: string, opening: RegExp): string[] {
  const text = source.replace(/#.*$/gm, '');
  const found: string[] = [];
  for (const match of text.matchAll(new RegExp(opening.source, 'gm'))) {
    let depth = 1;
    let at = match.index + match[0].length;
    const start = at;
    while (depth > 0 && at < text.length) {
      if (text[at] === '{') depth += 1;
      else if (text[at] === '}') depth -= 1;
      at += 1;
    }
    found.push(text.slice(start, at - 1));
  }
  return found;
}

const lines = (block: string) =>
  block
    .split('\n')
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter(Boolean);

/** What a reverse_proxy block lacks to turn a declared length into Content-Length, and only that. */
function proxyProblems(caddyfile: string): string[] {
  const proxies = blocks(caddyfile, /^\s*reverse_proxy\b[^{\n]*\{/);
  if (proxies.length === 0) return ['no reverse_proxy'];
  const problems: string[] = [];
  proxies.forEach((proxy, index) => {
    const own = lines(proxy);
    const matcher = blocks(proxy, /^\s*@declared_length\s*\{/);
    const handler = blocks(proxy, /^\s*handle_response @declared_length\s*\{/);
    const want = (ok: boolean, what: string) => {
      if (!ok) problems.push(`reverse_proxy ${index + 1}: ${what}`);
    };
    want(own.includes(`header_down -${DECLARED_LENGTH_HEADER}`), 'passes the header on');
    want(matcher.length === 1, 'has no @declared_length matcher');
    const conditions = lines(matcher[0] ?? '');
    want(conditions.includes('status 200'), 'declares for other statuses');
    want(conditions.includes(`header ${DECLARED_LENGTH_HEADER} *`), 'does not need a declaration');
    want(conditions.includes('header !Content-Length'), 'can send two lengths');
    want(conditions.includes('header !Content-Encoding'), 'declares an encoded body');
    want(handler.length === 1, 'never restores the length');
    const steps = lines(handler[0] ?? '');
    want(
      steps.includes(`header Content-Length {rp.header.${DECLARED_LENGTH_HEADER}}`),
      'sets another length',
    );
    want(steps.includes('copy_response'), 'does not send the body');
  });
  return problems;
}

describe('a declared body length', () => {
  it('states the exact length both as Content-Length and for the proxy', () => {
    expect(declaredLength(72)).toEqual({ 'Content-Length': '72', [DECLARED_LENGTH_HEADER]: '72' });
    expect(declaredLength(0)).toEqual({ 'Content-Length': '0', [DECLARED_LENGTH_HEADER]: '0' });
    const response = new Response(new Uint8Array(3), { headers: declaredLength(3) });
    expect(response.headers.get('x-ensemus-body-length')).toBe('3');
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'refuses %s, which no body is',
    (bytes) => {
      expect(() => declaredLength(bytes)).toThrow(RangeError);
    },
  );

  it.each(ROUTES)('is what %s sends', (route) => {
    expect(read(route)).toMatch(/\.\.\.declaredLength\(/);
  });

  it('is the only way any route states a length', () => {
    const handlers = routeHandlers();
    expect(handlers).toEqual(expect.arrayContaining(ROUTES));
    expect(handlers.filter((route) => bareLength(read(route)))).toEqual([]);
  });

  it.each(ROUTES)('%s lets nothing between encode what it declared', (route) => {
    expect(transformable(cacheControls(route))).toBe(false);
  });

  it('the check finds a download that may be encoded on the way', () => {
    expect(transformable(['private, no-store, no-transform'])).toBe(false);
    expect(transformable(['no-store, no-transform'])).toBe(false);
    expect(transformable(['private, no-store'])).toBe(true);
    expect(transformable(['no-store', 'no-store, no-transform'])).toBe(true);
    expect(transformable(['no-store, no-transformation'])).toBe(true);
    expect(transformable([])).toBe(true);
  });

  it('the check finds a route that sets Content-Length by itself', () => {
    expect(bareLength("headers: { 'Content-Length': String(file.body.length) }")).toBe(true);
    expect(bareLength('headers: { "content-length": "3" }')).toBe(true);
    expect(bareLength('headers: { ...declaredLength(file.body.length) }')).toBe(false);
    expect(bareLength("// Next.js drops 'Content-Length': here, so ...declaredLength(n)")).toBe(
      false,
    );
  });
});

describe('every proxy in front of the app', () => {
  it.each(PROXIES)('%s restores a declared length and never passes the header on', (path) => {
    expect(proxyProblems(read(path))).toEqual([]);
  });

  const good = `x {
	reverse_proxy web:3000 {
		header_up X-Forwarded-For {client_ip}
		header_down -X-Ensemus-Body-Length
		@declared_length {
			status 200
			header X-Ensemus-Body-Length *
			header !Content-Length
			header !Content-Encoding
		}
		handle_response @declared_length {
			header Content-Length {rp.header.X-Ensemus-Body-Length}
			copy_response
		}
	}
}`;

  it('the check passes a proxy that does all of it', () => {
    expect(proxyProblems(good)).toEqual([]);
  });

  it.each([
    ['passes the header on', '\t\theader_down -X-Ensemus-Body-Length\n'],
    ['declares for other statuses', '\t\t\tstatus 200\n'],
    ['declares an encoded body', '\t\t\theader !Content-Encoding\n'],
    ['can send two lengths', '\t\t\theader !Content-Length\n'],
    ['does not send the body', '\t\t\tcopy_response\n'],
  ])('the check finds a proxy that %s', (problem, line) => {
    expect(good).toContain(line);
    expect(proxyProblems(good.replace(line, ''))).toEqual([`reverse_proxy 1: ${problem}`]);
  });

  it('the check finds a second proxy that does none of it', () => {
    const second = good.replace(
      /\n\}$/,
      '\n\treverse_proxy web-2:3000 {\n\t\theader_up A b\n\t}\n}',
    );
    expect(proxyProblems(second)).toContain('reverse_proxy 2: never restores the length');
    expect(proxyProblems(second)).toContain('reverse_proxy 2: passes the header on');
  });

  it('the check finds a commented-out rule', () => {
    const commented = good.replace(
      'header_down -X-Ensemus-Body-Length',
      '# header_down -X-Ensemus-Body-Length',
    );
    expect(proxyProblems(commented)).toEqual(['reverse_proxy 1: passes the header on']);
  });
});
