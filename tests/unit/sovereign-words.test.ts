// COMM-03, SOV-02, ADR-030 D2: what the license and data pages may say, and what they must. It reads the page
// sources, so a sentence added next year meets the same rule. The second half holds the other promise the
// pages rest on: nothing about a trust root, a bundle manifest or a setting stops the process or a request.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateTestSigningKey,
  signForTest,
  testTrustRootText,
} from '@ensemus/sovereign/testing';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { repoRoot } from '../helpers/stack';

// Importing the real package from outside a server component throws, which is what it is for.
vi.mock('../../apps/web/node_modules/server-only/index.js', () => ({}));

const { buildSovereignRuntime } = await import('../../apps/web/src/server/sovereign-runtime');

const web = join(repoRoot, 'apps/web/src');

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const organizationPages = join(web, 'app/o/[organizationId]');
const components = readdirSync(join(web, 'components'))
  .filter((name) => /^(license|export|import)-/.test(name))
  .map((name) => join(web, 'components', name));
const server = readdirSync(join(web, 'server'))
  .filter((name) => name.startsWith('sovereign-'))
  .map((name) => join(web, 'server', name));

const pageSources = [
  ...walk(join(organizationPages, 'license')),
  ...walk(join(organizationPages, 'data')),
  ...components,
];
const allSources = [...pageSources, ...server];
const read = (file: string) => readFileSync(file, 'utf8');
const readAll = (files: readonly string[]) => files.map(read).join('\n');

const BANNED_PHRASES = [
  'expired license',
  'license expired',
  'air-gap ready',
  'air-gapped ready',
  'certified',
  'guarantee',
];
// A currency sign or a currency code beside a number, in either order, and anything priced by a period.
const PRICE =
  /[$€£¥]\s?\d|\b\d[\d,.]*\s?(usd|eur|gbp|aud|cad|dollars?|euros?|pounds?)\b|\b(usd|eur|gbp|aud|cad)\s?\d|\bper (seat|user|month|year)\b/i;
// The page can never state what a deployment's network looks like, so no spelling of this is allowed at all.
const NETWORK_CLAIM = /air[\s-]?gap/i;

function problemsIn(text: string): string[] {
  const lower = text.toLowerCase();
  return [
    ...BANNED_PHRASES.filter((phrase) => lower.includes(phrase)),
    ...(PRICE.test(text) ? ['a price'] : []),
    ...(NETWORK_CLAIM.test(text) ? ['a claim about the network'] : []),
  ];
}

describe('the words on the license and data pages', () => {
  it('finds the sources it is meant to read', () => {
    expect(pageSources.length).toBeGreaterThanOrEqual(10);
    expect(readAll(pageSources)).toContain('License and support');
    expect(readAll(pageSources)).toContain('Export and import');
  });

  it.each(allSources.map((file) => [file.slice(web.length + 1), file] as const))(
    '%s makes no claim it cannot back',
    (_, file) => {
      expect(problemsIn(read(file))).toEqual([]);
    },
  );

  it.each([
    'Your expired license',
    'LICENSE EXPIRED',
    'Air-gap ready',
    'air-gapped ready',
    'This deployment is air-gapped',
    'Certified by',
    'We guarantee this',
    'from $40',
    '1,200 USD',
    'EUR 20',
    '£5 a month',
    '30 per seat',
  ])('refuses %s, so that the rule above is a rule', (text) => {
    expect(problemsIn(text)).not.toEqual([]);
  });

  it('does not take ordinary sentences for a price', () => {
    expect(problemsIn('A seat count of 12, shown for your records, on 2027-01-01.')).toEqual([]);
  });

  it('says a lapse is a support status, and that the software keeps running', () => {
    const notices = read(join(web, 'components/license-notice-list.tsx'));
    expect(notices).toMatch(/lapsed:\s*'Maintenance has lapsed\. This is a support status/);
    expect(notices).toMatch(/maintenance_lapsed:\s*'[^']*keeps running/);
  });

  it('says a test key out loud, before anything else on the license page', () => {
    const page = read(join(organizationPages, 'license/page.tsx'));
    expect(page.indexOf('<LicenseTestKeyBanner')).toBeGreaterThan(-1);
    expect(page.indexOf('<LicenseTestKeyBanner')).toBeLessThan(page.indexOf('<PageHead'));
    expect(read(join(web, 'components/license-notice-list.tsx'))).toContain('generated test key');
  });

  it('says so when there is no trust root, or when it cannot be read', () => {
    const notices = read(join(web, 'components/license-notice-list.tsx'));
    expect(notices).toMatch(/not_configured:\s*'[^']*no trust root/);
    expect(notices).toMatch(/unreadable:\s*'[^']*could not be read/);
  });

  it('asks only for a public key, and says where the private one stays', () => {
    const form = read(join(web, 'components/export-request-form.tsx'));
    expect(form).toContain('name="recipientPublicKey"');
    expect(form).toContain('recipient-key tool');
    expect(form).toContain('private key stays with you');
    // No field takes one, on any page here, and the only thing a page does with the words is warn.
    for (const source of pageSources) {
      expect(read(source)).not.toMatch(/name="[^"]*(private|secret|passphrase)[^"]*"/i);
      expect(read(source)).not.toContain('type="password"');
    }
  });

  it('says an import takes a new, empty organization, and has words for every warning', () => {
    expect(read(join(organizationPages, 'data/page.tsx'))).toContain('new, empty organization');
    const summary = read(join(web, 'components/import-summary.tsx'));
    for (const code of [
      'RESTRICTED_EXCLUDED_AT_SOURCE',
      'TOMBSTONED_SKIPPED',
      'PERSON_NOT_LINKED',
      'CONNECTION_NEEDS_CREDENTIAL',
      'SECTION_NOT_SUPPORTED',
      'BYTES_MISSING',
      'RELATION_DANGLING',
      'WORK_PAUSED_ON_IMPORT',
    ]) {
      expect(summary).toMatch(new RegExp(`${code}:\\s*'`));
    }
  });
});

describe('who sees what', () => {
  it('gives a member the usual not found on both pages', () => {
    for (const page of [
      'license/page.tsx',
      'data/page.tsx',
      'data/work/page.tsx',
      'data/work/[workUnitId]/page.tsx',
    ]) {
      expect(read(join(organizationPages, page)), page).toMatch(
        /if \(!can\(context\.role, 'license\.view'\)\) notFound\(\);/,
      );
    }
  });

  it('shows neither page in a member navigation, by role and without reading any license', () => {
    const layout = read(join(organizationPages, 'layout.tsx'));
    expect(layout).toMatch(/can\(context\.role, 'license\.view'\)\s*\?\s*\[/);
    expect(layout).not.toMatch(
      /getLicenseStatus|listAdvisories|licenseNotices|maintenanceStatus|readVerifiedLicenseFacts/,
    );
  });

  it('offers installing, exporting and importing only by the capability that allows it', () => {
    expect(read(join(organizationPages, 'license/page.tsx'))).toMatch(
      /can\(context\.role, 'license\.manage'\) \?/,
    );
    expect(read(join(organizationPages, 'data/page.tsx'))).toMatch(
      /if \(!can\(context\.role, 'organization\.export'\)\) \{/,
    );
  });

  it('keeps the operator tools and the vendor side out of everything the web tier imports', () => {
    const imports = /from '(@ensemus\/sovereign\/[a-z-]+|@temporalio\/[a-z-]+)'/g;
    const found = walk(web)
      .filter((file) => /\.tsx?$/.test(file))
      .flatMap((file) => [...read(file).matchAll(imports)].map((match) => match[1]));
    expect([...new Set(found)].sort()).toEqual([
      '@ensemus/sovereign/trust-root',
      '@ensemus/sovereign/verify',
    ]);
  });
});

describe('the runtime behind the pages', () => {
  const folder = mkdtempSync(join(tmpdir(), 'ensemus-sovereign-runtime-'));
  const path = (name: string) => join(folder, name);
  const logged: { event: string; fields: unknown }[] = [];
  const log = {
    info: (event: string, fields: unknown) => logged.push({ event, fields }),
    warn: (event: string, fields: unknown) => logged.push({ event, fields }),
  };

  beforeEach(() => {
    logged.length = 0;
  });
  afterAll(() => rmSync(folder, { recursive: true, force: true }));

  const key = generateTestSigningKey('runtime-test-key');
  const trustRootFile = path('trust-root.json');
  writeFileSync(trustRootFile, testTrustRootText([key]));

  const release = {
    version: '2.0.1',
    line: '2.0',
    kind: 'patch',
    security: false,
    published_on: '2027-02-01',
  } as const;
  const manifest = () => ({
    format: 'ensemus.bundle',
    format_version: 1,
    bundle_id: randomUUID(),
    issued_at: '2027-02-01T00:00:00.000Z',
    release: { ...release, git_commit: 'a'.repeat(40) },
    files: [{ path: 'images/web.tar', sha256: 'b'.repeat(64), bytes: 1, role: 'image' }],
    images: [{ name: 'web', digest: `sha256:${'c'.repeat(64)}`, file: 'images/web.tar' }],
    compatibility: {
      upgrade_from: [],
      rollback_to: [],
      rollback_constraints: [],
      database_schema_version: '0301_sovereign_security.sql',
      workflow_compatibility: 'test',
      node_version: 'test',
    },
    models: [],
  });

  it('answers null, and logs a code, with nothing configured', () => {
    const runtime = buildSovereignRuntime({}, log);
    expect(runtime).toEqual({
      trustRoot: null,
      trustRootState: 'not_configured',
      runningRelease: null,
      sourceRelease: 'unreleased',
    });
    expect(logged).toEqual([
      { event: 'license.trust_root_absent', fields: { errorCode: 'TRUST_ROOT_NOT_CONFIGURED' } },
    ]);
  });

  it('answers null for a trust root file that is not there', () => {
    const runtime = buildSovereignRuntime(
      { ENSEMUS_LICENSE_TRUST_ROOT_FILE: path('nothing-here.json') },
      log,
    );
    expect(runtime.trustRoot).toBeNull();
    expect(runtime.trustRootState).toBe('unreadable');
  });

  it('answers null for a trust root it cannot read, and logs none of what the file held', () => {
    const file = path('damaged.json');
    writeFileSync(file, 'canary-trust-root-contents');
    const runtime = buildSovereignRuntime({ ENSEMUS_LICENSE_TRUST_ROOT_FILE: file }, log);
    expect(runtime.trustRoot).toBeNull();
    expect(runtime.trustRootState).toBe('unreadable');
    expect(JSON.stringify(logged)).toContain('TRUST_ROOT_UNREADABLE');
    expect(JSON.stringify(logged)).not.toContain('canary');
  });

  it('carries on when a setting is invalid, which it treats as nothing configured', () => {
    const runtime = buildSovereignRuntime({ ENSEMUS_RELEASE: 'x'.repeat(65) }, log);
    expect(runtime.trustRootState).toBe('not_configured');
    expect(JSON.stringify(logged)).toContain('SOVEREIGN_CONFIG_INVALID');
  });

  it('loads a good trust root', () => {
    const runtime = buildSovereignRuntime({ ENSEMUS_LICENSE_TRUST_ROOT_FILE: trustRootFile }, log);
    expect(runtime.trustRootState).toBe('loaded');
    expect(runtime.trustRoot?.keys.map(({ key_id }) => key_id)).toEqual(['runtime-test-key']);
  });

  it('reads the running release from a verified bundle manifest, and only from that', () => {
    const file = path('good-manifest.json');
    writeFileSync(file, signForTest('bundle', manifest(), [key]));
    const runtime = buildSovereignRuntime(
      {
        ENSEMUS_LICENSE_TRUST_ROOT_FILE: trustRootFile,
        ENSEMUS_BUNDLE_MANIFEST_FILE: file,
        ENSEMUS_RELEASE: 'claimed-by-a-setting',
      },
      log,
    );
    expect(runtime.runningRelease).toEqual(release);
    expect(runtime.sourceRelease).toBe('2.0.1');
  });

  it('believes no manifest signed by a key it does not hold', () => {
    const file = path('forged-manifest.json');
    writeFileSync(file, signForTest('bundle', manifest(), [generateTestSigningKey('stranger')]));
    const runtime = buildSovereignRuntime(
      {
        ENSEMUS_LICENSE_TRUST_ROOT_FILE: trustRootFile,
        ENSEMUS_BUNDLE_MANIFEST_FILE: file,
        ENSEMUS_RELEASE: '2.0.0',
      },
      log,
    );
    expect(runtime.runningRelease).toBeNull();
    expect(runtime.sourceRelease).toBe('2.0.0');
    expect(logged.map(({ event }) => event)).toContain('license.bundle_manifest_refused');
  });

  it('believes no manifest of another kind, signed by a key it does hold', () => {
    const file = path('wrong-kind.json');
    writeFileSync(file, signForTest('license', manifest(), [key]));
    const runtime = buildSovereignRuntime(
      { ENSEMUS_LICENSE_TRUST_ROOT_FILE: trustRootFile, ENSEMUS_BUNDLE_MANIFEST_FILE: file },
      log,
    );
    expect(runtime.runningRelease).toBeNull();
  });

  it('does not read a manifest when there is nothing to check it against', () => {
    const file = path('unchecked-manifest.json');
    writeFileSync(file, signForTest('bundle', manifest(), [key]));
    const runtime = buildSovereignRuntime({ ENSEMUS_BUNDLE_MANIFEST_FILE: file }, log);
    expect(runtime.runningRelease).toBeNull();
    expect(runtime.trustRootState).toBe('not_configured');
  });

  it('survives a manifest file that is not there', () => {
    const runtime = buildSovereignRuntime(
      {
        ENSEMUS_LICENSE_TRUST_ROOT_FILE: trustRootFile,
        ENSEMUS_BUNDLE_MANIFEST_FILE: path('nothing-here.json'),
      },
      log,
    );
    expect(runtime.runningRelease).toBeNull();
    expect(JSON.stringify(logged)).toContain('BUNDLE_MANIFEST_UNREADABLE');
  });

  it('finds an import only for an owner, and only through a tenant transaction', () => {
    const source = read(join(web, 'server/sovereign-runtime.ts'));
    expect(source).toMatch(/if \(!can\(context\.role, 'organization\.import'\)\) return null;/);
    expect(source).toContain('withTenantTx');
  });

  it('hands the logger codes, and no path an operator chose', () => {
    const runtime = buildSovereignRuntime(
      { ENSEMUS_LICENSE_TRUST_ROOT_FILE: path('secret-name-canary.json') },
      log,
    );
    expect(runtime.trustRoot).toBeNull();
    expect(JSON.stringify(logged)).not.toContain('secret-name-canary');
  });
});
