// COMM-03, COMM-05, SOV-02, SOV-04: the Sovereign routes against built images, through the proxy. Every
// response goes through call(), which validates it against docs/specifications/openapi.yaml at run time.
//
// It needs the stack and the generated test trust root compose.test.yaml mounts into web, whose signing key
// generate-test-secrets.mjs writes (see trustRootForTheStack below).
import { createHash, createPrivateKey, createPublicKey, randomUUID } from 'node:crypto';
import { openAppDatabase } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { runOrganizationImport, SOURCE_PORTABILITY_SECTIONS } from '@ensemus/application';
import { S3ObjectStore } from '@ensemus/storage';
import { readFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import {
  exportRecipientPublicKey,
  generateRecipientKeyPair,
  recipientKeyId,
} from '@ensemus/sovereign/sealed';
import {
  signForTest,
  testLicense,
  testMaintenance,
  type TestSigningKey,
} from '@ensemus/sovereign/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { components } from '../../packages/contracts/generated/openapi';
import { contractProblems, operationName, operations } from '../helpers/openapi';
import { BASE, createOrganization, join, type Person, signUp, submit } from '../helpers/forms';
import { repoRoot, urls, secret } from '../helpers/stack';
import { buildArchive } from '../integration/fixtures/archive-builder';

type ApiError = components['schemas']['Error'];
type LicenseStatus = components['schemas']['LicenseStatus'];
type InstalledDocument = components['schemas']['InstalledDocument'];
type OrganizationExport = components['schemas']['OrganizationExport'];
type OrganizationImport = components['schemas']['OrganizationImport'];
type ImportedPerson = components['schemas']['ImportedPerson'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INTERNALS =
  /\bselect\b[\s\S]*\bfrom\b|insert into|update \S+ set|delete from|stack|postgres|drizzle|node_modules|\bat \S+:\d+:\d+/i;
const POLL_MS = 500;
const EXPORT_LIMIT_MS = 90_000;

/**
 * The private half of the generated key the stack's test overlay trusts. Written by the step that starts the
 * stack (generate-test-secrets.mjs), next to its other generated secrets, and never used outside a test:
 * compose.test.yaml mounts only the trust root, which names the public half, into web. A failure to find it
 * is a failure, and not a skip: a test that quietly does not run proves nothing.
 */
function trustRootForTheStack(): TestSigningKey {
  const folder = joinPath(repoRoot, '.local', 'sovereign-test');
  const pem = readFileSync(joinPath(folder, 'test-signing-key.pem'), 'utf8');
  const privateKey = createPrivateKey(pem);
  return {
    keyId: readFileSync(joinPath(folder, 'test-signing-key.id'), 'utf8').trim(),
    privateKey,
    publicKeyBase64: createPublicKey(privateKey)
      .export({ type: 'spki', format: 'der' })
      .toString('base64'),
  };
}

const validated = new Set<string>();

/** `bytes` is the body exactly as it arrived, which `text` is not for a binary one such as a tar. */
type Result = { status: number; headers: Headers; bytes: Buffer; text: string; json: unknown };
type CallOptions = { body?: unknown; origin?: string | null; contentType?: string };

async function call(
  person: Person | undefined,
  method: string,
  path: string,
  options: CallOptions = {},
): Promise<Result> {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  const response = await fetch(`${BASE}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      ...(person ? { cookie: person.jar.cookie } : {}),
      ...(method !== 'GET' && options.origin !== null ? { origin: options.origin ?? BASE } : {}),
      ...(payload === undefined
        ? {}
        : { 'content-type': options.contentType ?? 'application/json' }),
    },
    ...(payload === undefined ? {} : { body: payload }),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  // What response.text() would give: UTF-8, a byte order mark dropped, and a bad byte replaced.
  const text = new TextDecoder().decode(bytes);
  const { operation, problems } = contractProblems({
    method,
    path,
    status: response.status,
    headers: response.headers,
    text,
  });
  expect(problems).toEqual([]);
  if (operation && response.status < 400) validated.add(operation);
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, bytes, text, json };
}

function expectError(result: Result, status: number, code?: string): ApiError {
  expect(result.status, result.text).toBe(status);
  expect(result.text).not.toMatch(INTERNALS);
  const error = result.json as ApiError;
  if (code) expect(error.code).toBe(code);
  expect(error.request_id).toMatch(UUID);
  expect(result.headers.get('cache-control')).toContain('no-store');
  return error;
}

const api = (organization: string, path: string) => `/api/v1/organizations/${organization}/${path}`;

/** Promotes someone through the same form an owner would use. */
async function makeAdmin(owner: Person, organization: string, person: Person) {
  await submit(
    `/o/${organization}/people`,
    owner.jar,
    (form) => form.html.includes(`Save access for ${person.name}`),
    { role: 'admin' },
  );
}

const aRecipient = () => {
  const { publicKey, privateKey } = generateRecipientKeyPair();
  return {
    publicKey,
    publicKeyBase64: exportRecipientPublicKey(publicKey),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    keyId: recipientKeyId(publicKey),
  };
};

describe('the Sovereign API', () => {
  let su: pg.Client;
  let key: TestSigningKey;
  let owner: Person;
  let admin: Person;
  let member: Person;
  let rival: Person;
  let org: string;
  let rivalOrg: string;

  beforeAll(async () => {
    key = trustRootForTheStack();
    su = new pg.Client({ connectionString: urls.superuser() });
    await su.connect();
    owner = await signUp('Olive Owner');
    org = await createOrganization(owner, `Sovereign ${randomUUID()}`);
    admin = await join(owner, org, 'Ada Admin');
    await makeAdmin(owner, org, admin);
    member = await join(owner, org, 'Milo Member');
    rival = await signUp('Rita Rival');
    rivalOrg = await createOrganization(rival, `Sovereign ${randomUUID()}`);
  });

  afterAll(() => su?.end());

  describe('every route, for someone with no business there', () => {
    const everyRoute = (organization: string): [string, string, unknown?][] => [
      ['GET', 'license'],
      ['POST', 'license/documents', { envelope: 'x' }],
      ['GET', 'advisories'],
      ['GET', 'exports'],
      ['POST', 'exports', { recipient_public_key: 'QUJD' }],
      ['GET', `exports/${organization}`],
      ['GET', `exports/${organization}/archive`],
      ['POST', 'imports'],
      ['GET', `imports/${organization}`],
      ['GET', `imports/${organization}/files/${organization}/download`],
      ['GET', 'imported-people'],
      ['POST', `imported-people/${organization}/link`, { membership_id: organization }],
    ];

    it('asks anyone not signed in to sign in', async () => {
      for (const [method, path, body] of everyRoute(org)) {
        expectError(
          await call(undefined, method, api(org, path), body === undefined ? {} : { body }),
          401,
          'UNAUTHENTICATED',
        );
      }
    });

    it('looks missing to someone in another organization, in every route', async () => {
      for (const [method, path, body] of everyRoute(org)) {
        expectError(
          await call(rival, method, api(org, path), body === undefined ? {} : { body }),
          404,
          'NOT_FOUND',
        );
      }
    });

    it('refuses a member everything', async () => {
      for (const [method, path, body] of everyRoute(org)) {
        const result = await call(
          member,
          method,
          api(org, path),
          body === undefined ? {} : { body },
        );
        expect([403, 404], `${method} ${path}`).toContain(result.status);
      }
    });

    it('refuses a write that did not come from this origin, and a malformed ID', async () => {
      expectError(
        await call(owner, 'POST', api(org, 'imports'), { origin: 'https://elsewhere.invalid' }),
        403,
        'ORIGIN_NOT_ALLOWED',
      );
      expectError(await call(owner, 'GET', api('not-an-id', 'license')), 400, 'INVALID_INPUT');
      expectError(await call(owner, 'GET', api(org, 'exports/not-an-id')), 400, 'INVALID_INPUT');
    });

    it('wants JSON, and refuses a body with a field the schema does not have', async () => {
      expectError(
        await call(owner, 'POST', api(org, 'license/documents'), {
          body: { envelope: 'x' },
          contentType: 'text/plain',
        }),
        415,
        'UNSUPPORTED_MEDIA_TYPE',
      );
      expectError(
        await call(owner, 'POST', api(org, 'license/documents'), {
          body: { envelope: 'x', extra: true },
        }),
        400,
        'INVALID_INPUT',
      );
    });
  });

  describe('license', () => {
    const licenseId = randomUUID();
    const licenseFile = () =>
      signForTest(
        'license',
        testLicense({ license_id: licenseId, issued_at: '2020-01-01T00:00:00.000Z' }),
        [key],
      );

    it('answers for an organization with nothing installed', async () => {
      const result = await call(owner, 'GET', api(org, 'license'));
      expect(result.status).toBe(200);
      const status = result.json as LicenseStatus;
      expect(status.standing).toBe('unlicensed');
      expect(status.license).toBeNull();
      expect(status.notices).toContain('no_license');
    });

    it('lets an admin read, and only an owner install', async () => {
      expect((await call(admin, 'GET', api(org, 'license'))).status).toBe(200);
      expect((await call(admin, 'GET', api(org, 'advisories'))).status).toBe(200);
      expectError(
        await call(admin, 'POST', api(org, 'license/documents'), {
          body: { envelope: licenseFile() },
        }),
        403,
        'FORBIDDEN',
      );
      expectError(await call(member, 'GET', api(org, 'license')), 403, 'FORBIDDEN');
    });

    it('changes nothing for a forged file, and says so in the usual shape', async () => {
      const stranger = { ...key, keyId: 'a-key-nobody-trusts' };
      for (const envelope of [
        'not a signed file',
        signForTest('license', testLicense(), [stranger]),
      ]) {
        expectError(
          await call(owner, 'POST', api(org, 'license/documents'), { body: { envelope } }),
          400,
          'LICENSE_NOT_VALID',
        );
      }
      const status = (await call(owner, 'GET', api(org, 'license'))).json as LicenseStatus;
      expect(status.standing).toBe('unlicensed');
    });

    it('installs a license once, and a second time changes nothing', async () => {
      const envelope = licenseFile();
      const first = await call(owner, 'POST', api(org, 'license/documents'), {
        body: { envelope },
      });
      expect(first.status).toBe(201);
      expect(first.json as InstalledDocument).toMatchObject({
        type: 'license',
        created: true,
        test_key: true,
      });
      const again = await call(owner, 'POST', api(org, 'license/documents'), {
        body: { envelope },
      });
      expect(again.status).toBe(200);
      expect((again.json as InstalledDocument).created).toBe(false);
    });

    it('shows a test key, and treats a lapse as a support status that stops nothing', async () => {
      const lapsed = signForTest(
        'maintenance',
        testMaintenance({
          maintenance_id: randomUUID(),
          license_id: licenseId,
          issued_at: '2020-01-01T00:00:00.000Z',
          starts_on: '2020-01-01',
          ends_on: '2020-12-31',
        }),
        [key],
      );
      const installed = await call(owner, 'POST', api(org, 'license/documents'), {
        body: { envelope: lapsed },
      });
      expect(installed.status).toBe(201);
      const status = (await call(owner, 'GET', api(org, 'license'))).json as LicenseStatus;
      expect(status.standing).toBe('licensed');
      expect(status.license?.test_key).toBe(true);
      expect(status.maintenance).toEqual({ status: 'lapsed', last_covered_on: '2020-12-31' });
      expect(status.notices).toEqual(
        expect.arrayContaining(['maintenance_lapsed', 'signed_with_test_key']),
      );
      // Ordinary business, right after: a lapse changes what a page says and nothing else.
      const work = await fetch(`${BASE}${api(org, 'work-units')}`, {
        headers: { cookie: owner.jar.cookie },
      });
      expect(work.status).toBe(200);
    });

    it('keeps one tenant’s license out of another tenant’s answer', async () => {
      const status = (await call(rival, 'GET', api(rivalOrg, 'license'))).json as LicenseStatus;
      expect(status.standing).toBe('unlicensed');
      expect(JSON.stringify(status)).not.toContain(licenseId);
    });

    it('lists an advisory that verifies', async () => {
      const advisory = (advisoryId: string, title: string) =>
        signForTest(
          'advisory',
          {
            format: 'ensemus.advisory',
            format_version: 1,
            advisory_id: advisoryId,
            issued_at: '2027-01-01T00:00:00.000Z',
            severity: 'high',
            title,
            summary: 'Written by a test.',
            affected_versions: ['2.0.0'],
            fixed_in_versions: ['2.0.1'],
          },
          [key],
        );
      // The signed advisory shape (packages/sovereign/src/documents.ts, ADR-030 D2, and
      // issuing-documents.md) takes an upper-case advisory_id. A correctly signed file with any
      // other ID does not verify, so it is refused and nothing is listed.
      const unfit = await call(owner, 'POST', api(org, 'license/documents'), {
        body: { envelope: advisory(`TEST-${randomUUID()}`, 'An advisory that does not verify') },
      });
      expectError(unfit, 400, 'LICENSE_NOT_VALID');
      const installed = await call(owner, 'POST', api(org, 'license/documents'), {
        body: { envelope: advisory(`TEST-${randomUUID().toUpperCase()}`, 'A test advisory') },
      });
      expect(installed.status, installed.text).toBe(201);
      const listed = await call(admin, 'GET', api(org, 'advisories'));
      const { items } = listed.json as { items: components['schemas']['Advisory'][] };
      expect(items.map((item) => item.title)).toContain('A test advisory');
      expect(items.map((item) => item.title)).not.toContain('An advisory that does not verify');
      expect((await call(rival, 'GET', api(rivalOrg, 'advisories'))).json).toEqual({ items: [] });
    });
  });

  describe('exports', () => {
    const recipient = aRecipient();
    let exportId: string;

    it('refuses an admin and a member', async () => {
      const body = { recipient_public_key: recipient.publicKeyBase64 };
      expectError(await call(admin, 'POST', api(org, 'exports'), { body }), 403, 'FORBIDDEN');
      expectError(await call(member, 'POST', api(org, 'exports'), { body }), 403, 'FORBIDDEN');
      expectError(await call(admin, 'GET', api(org, 'exports')), 403, 'FORBIDDEN');
    });

    it('refuses a key that is not a public X25519 key, a private one included', async () => {
      for (const value of [
        'not base64 at all!',
        Buffer.from('not a key').toString('base64'),
        recipient.privateKeyPem,
        Buffer.from(recipient.privateKeyPem).toString('base64').slice(0, 512),
      ]) {
        const refused = await call(owner, 'POST', api(org, 'exports'), {
          body: { recipient_public_key: value },
        });
        expectError(refused, 400, 'INVALID_INPUT');
        expect(refused.text).not.toContain(value);
      }
    });

    it('answers at once, before the worker starts, with a key it can name', async () => {
      const requested = await call(owner, 'POST', api(org, 'exports'), {
        body: { recipient_public_key: recipient.publicKeyBase64 },
      });
      expect(requested.status).toBe(202);
      const view = requested.json as OrganizationExport;
      expect(view.recipient_key_id).toBe(recipient.keyId);
      expect(view.scope).toBe('standard');
      expect(view.downloadable).toBe(false);
      exportId = view.id;
    });

    it('refuses a second one while the first runs, and a download before it is ready', async () => {
      const second = await call(owner, 'POST', api(org, 'exports'), {
        body: { recipient_public_key: recipient.publicKeyBase64 },
      });
      if (second.status !== 202) expectError(second, 409, 'EXPORT_ALREADY_RUNNING');
      const early = await call(owner, 'GET', api(org, `exports/${exportId}`));
      const { status } = early.json as OrganizationExport;
      if (status === 'requested' || status === 'running') {
        expectError(await call(owner, 'GET', api(org, `exports/${exportId}/archive`)), 409);
      }
    });

    it('looks missing from another tenant, at the same ID', async () => {
      expectError(await call(rival, 'GET', api(rivalOrg, `exports/${exportId}`)), 404, 'NOT_FOUND');
      expectError(
        await call(rival, 'GET', api(rivalOrg, `exports/${exportId}/archive`)),
        404,
        'NOT_FOUND',
      );
    });

    it('becomes a download of sealed parts, which is never kept by anything between', async () => {
      const deadline = Date.now() + EXPORT_LIMIT_MS;
      let view = (await call(owner, 'GET', api(org, `exports/${exportId}`)))
        .json as OrganizationExport;
      while (view.status !== 'ready' && view.status !== 'failed' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        view = (await call(owner, 'GET', api(org, `exports/${exportId}`)))
          .json as OrganizationExport;
      }
      expect(view.status).toBe('ready');
      expect(view.downloadable).toBe(true);

      const listed = (await call(owner, 'GET', api(org, 'exports'))).json as {
        items: OrganizationExport[];
      };
      expect(listed.items.map((item) => item.id)).toContain(exportId);

      const download = await call(owner, 'GET', api(org, `exports/${exportId}/archive`));
      expect(download.status).toBe(200);
      expect(download.headers.get('content-type')).toBe('application/x-tar');
      // no-transform keeps the app's compression off a tar, whose declared length is then still true
      // (ADR-030 D7; apps/web/src/lib/declared-length.ts). no-store is asserted exactly as before.
      expect(download.headers.get('cache-control')).toBe('no-store, no-transform');
      expect(download.headers.get('content-disposition')).toMatch(/^attachment; /);
      expect(download.bytes.length).toBeGreaterThan(0);
      // The tar is binary, so its length is measured in the bytes that arrived, and it is the size the
      // export reported. Next.js drops the route's Content-Length; the proxy restores it from the length
      // the app declared, and that internal header never reaches a client (apps/web/src/lib/declared-length.ts).
      expect(download.bytes.length).toBe(view.archive_bytes);
      expect(download.headers.get('content-length')).toBe(String(download.bytes.length));
      expect(download.headers.get('x-ensemus-body-length')).toBeNull();
      // The tar's framing is plain and its parts are not, so a title in clear would be a real finding.
      expect(download.text).toContain('manifest.json.sealed');
      expect(download.text).not.toContain(owner.name);
    });
  });

  describe('imports', () => {
    let importer: Person;
    let target: string;
    let importId: string;

    beforeAll(async () => {
      importer = await signUp('Ines Importer');
      target = await createOrganization(importer, `Import target ${randomUUID()}`);
    });

    it('refuses an organization that holds anything', async () => {
      expectError(await call(owner, 'POST', api(org, 'imports')), 409, 'IMPORT_TARGET_NOT_EMPTY');
    });

    it('refuses an admin and a member, and reads as missing from outside', async () => {
      expectError(await call(admin, 'POST', api(org, 'imports')), 403, 'FORBIDDEN');
      expectError(await call(member, 'POST', api(org, 'imports')), 403, 'FORBIDDEN');
      expectError(await call(rival, 'POST', api(target, 'imports')), 404, 'NOT_FOUND');
    });

    it('takes one archive, and refuses a second', async () => {
      const requested = await call(importer, 'POST', api(target, 'imports'));
      expect(requested.status).toBe(201);
      const view = requested.json as OrganizationImport;
      expect(view.status).toBe('requested');
      expect(view.applied_counts).toEqual({});
      importId = view.id;
      expectError(await call(importer, 'POST', api(target, 'imports')), 409, 'IMPORT_ALREADY_USED');
    });

    it('shows how it stands to its own organization and to nobody else', async () => {
      // A well-formed ID, so the rival's 404 is the tenant boundary and not the ID check.
      expect(importId).toMatch(UUID);
      const found = await call(importer, 'GET', api(target, `imports/${importId}`));
      expect(found.status, found.text).toBe(200);
      expect((found.json as OrganizationImport).id).toBe(importId);
      expectError(await call(rival, 'GET', api(rivalOrg, `imports/${importId}`)), 404, 'NOT_FOUND');
    });

    it('lists no people before anything has arrived', async () => {
      const listed = await call(importer, 'GET', api(target, 'imported-people'));
      expect(listed.json as { items: ImportedPerson[] }).toEqual({ items: [] });
    });

    it('refuses linking someone the archive did not name', async () => {
      expectError(
        await call(importer, 'POST', api(target, `imported-people/${randomUUID()}/link`), {
          body: { membership_id: randomUUID() },
        }),
        404,
      );
      expectError(
        await call(importer, 'POST', api(target, `imported-people/${randomUUID()}/link`), {
          body: { membership_id: 'not-an-id' },
        }),
        400,
        'INVALID_INPUT',
      );
    });
  });

  it('downloads only a real verified inert archive file through the native HTTP boundary', async () => {
    const custodian = await signUp('Generated HTTP archive custodian'),
      company = await createOrganization(custodian, `Generated archive ${randomUUID()}`);
    const requested = await call(custodian, 'POST', api(company, 'imports'));
    expect(requested.status).toBe(201);
    const importId = (requested.json as OrganizationImport).id,
      sourceArtifactId = randomUUID();
    const path = api(company, `imports/${importId}/files/${sourceArtifactId}/download`);
    expectError(await call(custodian, 'GET', path), 404);
    const bytes = Buffer.from(
      'GENERATED HTTP archive bytes, retained without trusted original lineage.',
    );
    const recipient = aRecipient(),
      archive = buildArchive(recipient, {
        pages: [
          {
            section: 'artifacts',
            recordKind: 'artifact',
            records: [
              {
                kind: 'artifact',
                id: sourceArtifactId,
                name: 'Generated archived note.txt',
                mime_type: 'text/plain',
                size_bytes: bytes.length,
                sha256: createHash('sha256').update(bytes).digest('hex'),
                classification: 'internal',
                created_by_membership_id: randomUUID(),
                created_at: '2026-11-08T00:00:00.000Z',
              },
            ],
          },
        ],
        files: { [sourceArtifactId]: bytes },
      });
    const app = openAppDatabase(urls.app()),
      store = new S3ObjectStore({
        endpoint: `http://127.0.0.1:${process.env.ENSEMUS_TEST_OBJECTS_PORT ?? '58333'}`,
        bucket: 'ensemus',
        accessKey: secret('objects_access_key'),
        secretKey: secret('objects_secret_key'),
        maxAttempts: 1,
      });
    try {
      // The operator/parser runs in the test driver. No customer-facing HTTP route performs import work.
      const imported = await runOrganizationImport(
        app.db,
        createServiceContext(company),
        {
          importId,
          archive: archive.reader,
          recipientPrivateKeyPem: recipient.privateKeyPem,
        },
        { sections: SOURCE_PORTABILITY_SECTIONS, store, ledger: store },
      );
      expect(imported).toMatchObject({
        status: 'completed_with_warnings',
        warningCounts: { FILES_AWAIT_REVIEW: 1 },
      });
      const downloaded = await call(custodian, 'GET', path);
      expect(downloaded.status).toBe(200);
      expect(downloaded.text).toBe(bytes.toString());
      expect(downloaded.headers.get('content-type')).toBe('application/octet-stream');
      expect(downloaded.headers.get('content-length')).toBe(String(bytes.length));
      // Next.js drops the route's Content-Length; the proxy restores it from the length the app declared,
      // and that internal header never reaches a client (apps/web/src/lib/declared-length.ts).
      expect(downloaded.headers.get('x-ensemus-body-length')).toBeNull();
      expect(downloaded.headers.get('content-disposition')).toMatch(/^attachment;/);
      expect(downloaded.headers.get('cache-control')).toContain('no-store');
      expect(downloaded.headers.get('x-content-type-options')).toBe('nosniff');
      expectError(await call(rival, 'GET', path), 404);
    } finally {
      store.close();
      await app.close();
    }
  });

  it('links a person an imported archive named, through the native HTTP boundary', async () => {
    const custodian = await signUp('Generated HTTP link custodian'),
      company = await createOrganization(custodian, `Generated link ${randomUUID()}`);
    const requested = await call(custodian, 'POST', api(company, 'imports'));
    expect(requested.status).toBe(201);
    const importId = (requested.json as OrganizationImport).id,
      sourceMembershipId = randomUUID();
    const recipient = aRecipient(),
      archive = buildArchive(recipient, {
        pages: [
          {
            section: 'people',
            recordKind: 'people',
            records: [
              {
                kind: 'person',
                membership_id: sourceMembershipId,
                display_name: 'Generated archived person',
                email: `archived-${sourceMembershipId}@example.invalid`,
                role: 'member',
                status: 'active',
                created_at: '2026-11-08T00:00:00.000Z',
              },
            ],
          },
        ],
      });
    const app = openAppDatabase(urls.app()),
      store = new S3ObjectStore({
        endpoint: `http://127.0.0.1:${process.env.ENSEMUS_TEST_OBJECTS_PORT ?? '58333'}`,
        bucket: 'ensemus',
        accessKey: secret('objects_access_key'),
        secretKey: secret('objects_secret_key'),
        maxAttempts: 1,
      });
    try {
      // As above: the operator's import runs in the test driver, and only the link goes through HTTP.
      const imported = await runOrganizationImport(
        app.db,
        createServiceContext(company),
        { importId, archive: archive.reader, recipientPrivateKeyPem: recipient.privateKeyPem },
        { sections: SOURCE_PORTABILITY_SECTIONS, store, ledger: store },
      );
      expect(['completed', 'completed_with_warnings']).toContain(imported.status);
    } finally {
      store.close();
      await app.close();
    }
    const listed = (await call(custodian, 'GET', api(company, 'imported-people'))).json as {
      items: ImportedPerson[];
    };
    expect(listed.items).toEqual([
      expect.objectContaining({
        source_membership_id: sourceMembershipId,
        target_membership_id: null,
        linked_at: null,
      }),
    ]);

    const membershipOf = async (person: Person, organization: string) => {
      const { rows } = await su.query<{ id: string }>(
        `select m.id from org.memberships m join identity.users u on u.id = m.user_id
          where u.email = $1 and m.organization_id = $2`,
        [person.email, organization],
      );
      const id = rows[0]?.id;
      if (!id) throw new Error(`${person.name} has no membership there`);
      return id;
    };
    const arrived = await join(custodian, company, 'Generated arrived member');
    const membershipId = await membershipOf(arrived, company);
    const link = api(company, `imported-people/${sourceMembershipId}/link`);
    const body = { membership_id: membershipId };

    // Only an owner of this organization may say who someone was, and only as one of its own members.
    expect([403, 404]).toContain((await call(arrived, 'POST', link, { body })).status);
    expectError(await call(rival, 'POST', link, { body }), 404, 'NOT_FOUND');
    expectError(
      await call(custodian, 'POST', link, {
        body: { membership_id: await membershipOf(rival, rivalOrg) },
      }),
      400,
      'INVALID_INPUT',
    );

    const linked = await call(custodian, 'POST', link, { body });
    expect(linked.status, linked.text).toBe(200);
    expect(linked.json as ImportedPerson).toMatchObject({
      source_membership_id: sourceMembershipId,
      target_membership_id: membershipId,
    });
    expect((linked.json as ImportedPerson).linked_at).not.toBeNull();
  });

  it('has validated a real answer from every Sovereign route', () => {
    const sovereign = operations()
      .filter(({ path }) => /\/(license|advisories|exports|imports|imported-people)/.test(path))
      .map(({ method, path }) => operationName(method, path));
    const missing = sovereign.filter((name) => !validated.has(name));
    expect(missing).toEqual([]);
  });
});
