// API-12: the spec against the routes that exist, and the validator against responses that must fail.
// tests/stack/api.test.ts puts every real response through the same validator.
import { describe, expect, it, vi } from 'vitest';
import {
  contractProblems,
  exportedMethods,
  implementedRoutes,
  operationName,
  operations,
  spec,
} from '../helpers/openapi';

// Importing the real package from outside a server component throws, which is what it is for.
vi.mock('../../apps/web/node_modules/server-only/index.js', () => ({}));

const dto = await import('../../apps/web/src/server/sovereign-dto');

describe('which methods a route file exports', () => {
  it.each([
    ['a const', 'export const GET = route(handler);', ['GET']],
    ['a function', 'export function POST(request: Request) {}', ['POST']],
    ['an async function', 'export async function PATCH(request: Request) {}', ['PATCH']],
    ['an export list', 'const handler = 1;\nexport { handler as DELETE, PUT };', ['DELETE', 'PUT']],
    ['a destructured const', 'export const { GET, POST } = handlers;', ['GET', 'POST']],
    ['a renamed destructured const', 'export const { get: GET } = handlers;', ['GET']],
    ['two in one statement', 'export const GET = a, POST = b;', ['GET', 'POST']],
    ['a typed const', 'export const GET: Handler = a;', ['GET']],
    ['a list from elsewhere', "export { PUT, x as DELETE } from './handlers';", ['DELETE', 'PUT']],
    ['several forms', 'export const GET = a;\nexport async function POST() {}', ['GET', 'POST']],
  ])('sees %s', (_, source, methods) => {
    expect(exportedMethods(source).sort()).toEqual(methods);
  });

  it('ignores anything that is not an exported HTTP method', () => {
    expect(exportedMethods('export const dynamic = 1;\nexport function helper() {}')).toEqual([]);
    expect(exportedMethods('const GET = 1;')).toEqual([]);
    expect(exportedMethods('function POST() {}\nexport { POST as helper };')).toEqual([]);
    expect(exportedMethods("// export const GET = a;\nconst s = 'export const POST = b';")).toEqual(
      [],
    );
  });
});

const ORG = '6f1c2c6e-1111-4111-8111-111111111111';
const ID = '6f1c2c6e-2222-4222-8222-222222222222';
const workPath = `/api/v1/organizations/${ORG}/work-units/${ID}`;

const workUnit = {
  id: ID,
  organization_id: ORG,
  title: 'A title',
  status: 'queued',
  version: 1,
  due_at: null,
};

const json = (extra: Record<string, string> = {}) =>
  new Headers({ 'content-type': 'application/json; charset=utf-8', ...extra });

const problems = (status: number, body: unknown, headers = json({ etag: '"1"' })) =>
  contractProblems({
    method: 'GET',
    path: workPath,
    status,
    headers,
    text: JSON.stringify(body),
  }).problems;

describe('the spec and the routes', () => {
  const routes = implementedRoutes();

  it('finds the routes that exist', () => {
    expect(routes).toContain('GET /organizations/{organization_id}/work-units');
    expect(routes).toContain('PATCH /organizations/{organization_id}/work-units/{work_unit_id}');
    expect(routes).toContain(
      'POST /organizations/{organization_id}/approvals/{approval_id}/decisions',
    );
  });

  it('has every operation either implemented or marked planned, and never both', () => {
    for (const { method, path, status } of operations()) {
      const name = operationName(method, path);
      if (status === undefined) expect(routes, `${name} has no route`).toContain(name);
      else {
        expect(status, name).toBe('planned');
        expect(routes, `${name} is marked planned, but a route exists`).not.toContain(name);
      }
    }
  });

  it('has every route in the spec', () => {
    const inSpec = operations().map(({ method, path }) => operationName(method, path));
    for (const route of routes) expect(inSpec, `${route} is not in the spec`).toContain(route);
  });

  it('marks what does not exist yet', () => {
    const planned = operations().filter((operation) => operation.status === 'planned');
    expect(planned.map(({ path }) => path.split('/').slice(3).join('/'))).toEqual([
      'agent-runs',
      'agent-runs/{agent_run_id}',
      // M3 until each route lands. The receipts slice removes these as it builds them (ADR-027).
      'work-units/{work_unit_id}/external-actions',
      'external-actions',
      'external-actions/{external_action_id}',
      'external-actions/{external_action_id}/revisions',
      'external-actions/{external_action_id}/resolution',
      'external-actions/{external_action_id}/retries',
      'connections',
      'connections',
      'connections/{connection_id}',
      'connections/{connection_id}',
      'connections/{connection_id}/sync',
      'connections/{connection_id}/webhook-endpoints',
      'knowledge/search',
      'model-profiles',
      'entitlements',
    ]);
  });
});

describe('how the API says you sign in', () => {
  it('asks for the session cookie and nothing else', () => {
    expect(spec.security).toEqual([{ sessionCookie: [] }]);
    expect(spec.components.securitySchemes).toEqual({
      sessionCookie: expect.objectContaining({
        type: 'apiKey',
        in: 'cookie',
        name: '__Secure-better-auth.session_token',
      }),
    });
    for (const scheme of Object.values(spec.components.securitySchemes)) {
      expect(scheme.type).not.toBe('http');
    }
  });

  it('does not let any one operation ask for something else', () => {
    for (const item of Object.values(spec.paths)) {
      for (const operation of Object.values(item)) {
        if (operation && typeof operation === 'object' && 'security' in operation) {
          expect(operation.security).toEqual([{ sessionCookie: [] }]);
        }
      }
    }
  });
});

describe('the validator', () => {
  it('accepts a response that matches', () => {
    expect(problems(200, workUnit)).toEqual([]);
  });

  it('refuses a field the spec does not have, which is how an internal column would leak', () => {
    expect(problems(200, { ...workUnit, owner_membership_id: ID }).join()).toContain(
      'additional properties',
    );
  });

  it('refuses a missing field, a wrong type and a value outside its list', () => {
    const { title: _title, ...untitled } = workUnit;
    expect(problems(200, untitled).join()).toContain("required property 'title'");
    expect(problems(200, { ...workUnit, version: 'one' }).join()).toContain('/version');
    expect(problems(200, { ...workUnit, status: 'nearly' }).join()).toContain('/status');
    expect(problems(200, { ...workUnit, id: 'not-an-id' }).join()).toContain('/id');
    expect(problems(200, { ...workUnit, due_at: 'tomorrow' }).join()).toContain('/due_at');
  });

  it('checks an error against the shared Error schema, through its reference', () => {
    const error = { code: 'NOT_FOUND', message: 'x', request_id: ID, retryable: false };
    expect(problems(404, error, json())).toEqual([]);
    expect(problems(404, { ...error, stack: 'at x' }, json()).join()).toContain(
      'additional properties',
    );
    const { retryable: _retryable, ...incomplete } = error;
    expect(problems(404, incomplete, json()).join()).toContain('retryable');
  });

  it('refuses a status the operation does not list', () => {
    expect(problems(418, {}, json()).join()).toContain('does not list this status');
  });

  it('refuses a missing or malformed declared header', () => {
    expect(problems(200, workUnit, json()).join()).toContain('missing header ETag');
    expect(problems(200, workUnit, json({ etag: 'W/"1"' })).join()).toContain('header ETag');
  });

  it('refuses a body where the spec says none, and a type the spec does not list', () => {
    const decided = `/api/v1/organizations/${ORG}/approvals/${ID}/decisions`;
    expect(
      contractProblems({
        method: 'POST',
        path: decided,
        status: 200,
        headers: json(),
        text: '{"ok":true}',
      }).problems.join(),
    ).toContain('no body');
    expect(
      contractProblems({
        method: 'GET',
        path: workPath,
        status: 200,
        headers: new Headers({ 'content-type': 'text/html', etag: '"1"' }),
        text: '<html>',
      }).problems.join(),
    ).toContain('content type');
  });

  it('refuses a path that is not in the spec, and an operation it says does not exist', () => {
    expect(
      contractProblems({
        method: 'GET',
        path: `/api/v1/organizations/${ORG}/nothing-here`,
        status: 200,
        headers: json(),
        text: '{}',
      }).problems.join(),
    ).toContain('no such path');
    expect(
      contractProblems({
        method: 'GET',
        path: `/api/v1/organizations/${ORG}/entitlements`,
        status: 200,
        headers: json(),
        text: '{}',
      }).problems.join(),
    ).toContain('does not exist yet');
  });

  it('ignores a query string when finding the operation', () => {
    const { operation, problems: found } = contractProblems({
      method: 'GET',
      path: `/api/v1/organizations/${ORG}/work-units?status=queued`,
      status: 200,
      headers: json(),
      text: JSON.stringify({ items: [workUnit], next_cursor: null }),
    });
    expect(operation).toBe('GET /organizations/{organization_id}/work-units');
    expect(found).toEqual([]);
  });
});

// COMM-03, COMM-05: the shapes the Sovereign routes answer with, against the spec. tests/stack/sovereign-api.test.ts
// puts real responses through the same validator.
describe('what the Sovereign routes answer with', () => {
  const organizationPath = `/api/v1/organizations/${ORG}`;
  const answer = (method: string, path: string, status: number, body: unknown) =>
    contractProblems({
      method,
      path: `${organizationPath}/${path}`,
      status,
      headers: json(),
      text: JSON.stringify(body),
    }).problems;

  const when = new Date('2027-03-01T10:00:00.000Z');
  const license = {
    licenseId: ID,
    licensee: { displayName: 'Test Licensee', contractReference: 'TEST-1' },
    term: { kind: 'pilot', review_on: '2027-06-01' },
    licensedRelease: { line: '2.0', version: '2.0.0' },
    footprint: {
      organizations: null,
      seats: 12,
      production_deployments: null,
      nonproduction_deployments: null,
    },
    components: ['web'],
    updateRights: {
      security_patches_after_lapse: 'none',
      major_versions_with_maintenance: 'separate_purchase',
      releases_published_during_maintenance: 'kept_after_lapse',
      outside_rights_on_install: 'warn',
    },
    issuedAt: when,
    keyIds: ['test-key'],
    testKey: true,
    retiredKey: false,
  } as const;
  const status = {
    standing: 'licensed',
    license,
    maintenance: { status: 'lapsed', lastCoveredOn: '2027-01-31' },
    runningRelease: {
      version: '2.0.0',
      verdict: { covered: false, basis: null, onInstall: 'warn' },
    },
    seatsInUse: 3,
    notices: ['maintenance_lapsed', 'signed_with_test_key'],
  } as const;
  const exportView = {
    id: ID,
    status: 'ready',
    scope: 'standard',
    recipientKeyId: 'a'.repeat(32),
    requestedAt: when,
    finishedAt: when,
    expiresAt: when,
    partCount: 2,
    recordCount: 9,
    archiveBytes: 1024,
    excluded: { restrictedWork: 1, restrictedArtifacts: 0, restrictedClients: 2 },
    failureCode: null,
    downloadable: true,
  } as const;
  const importView = {
    id: ID,
    status: 'completed_with_warnings',
    requestedAt: when,
    finishedAt: when,
    sourceOrganizationId: ORG,
    exportedAt: when,
    sourceRelease: '2.0.0',
    appliedCounts: { work_units: 4 },
    warningCounts: { PERSON_NOT_LINKED: 2 },
    failureCode: null,
  } as const;
  const person = {
    sourceMembershipId: ID,
    displayName: 'A Person',
    email: 'person@example.invalid',
    sourceRole: 'admin',
    targetMembershipId: null,
    linkedAt: null,
  } as const;

  it('matches for a license, with every field the spec lists and no others', () => {
    const body = dto.licenseStatusDto(status);
    expect(answer('GET', 'license', 200, body)).toEqual([]);
    expect(body.license).toMatchObject({
      term: { kind: 'pilot', review_on: '2027-06-01' },
      footprint_seats: 12,
      test_key: true,
    });
    expect(body.running_release).toEqual({ version: '2.0.0', covered: false });
    // A person reads these on the page. They are not part of what the API promises.
    expect(JSON.stringify(body)).not.toMatch(/update_rights|updateRights|components/);
  });

  it('matches with nothing installed, and with a running release no rights were checked for', () => {
    const empty = dto.licenseStatusDto({
      ...status,
      standing: 'unlicensed',
      license: null,
      maintenance: { status: 'no_agreement', lastCoveredOn: null },
      runningRelease: { version: '2.0.0', verdict: null },
      notices: ['no_license'],
    });
    expect(answer('GET', 'license', 200, empty)).toEqual([]);
    expect(empty.running_release).toEqual({ version: '2.0.0', covered: null });
    expect(
      answer('GET', 'license', 200, dto.licenseStatusDto({ ...status, runningRelease: null })),
    ).toEqual([]);
  });

  it('matches for a document that was installed, once and again', () => {
    const body = dto.installedDocumentDto({
      type: 'license',
      id: ID,
      created: true,
      testKey: true,
    });
    expect(answer('POST', 'license/documents', 201, body)).toEqual([]);
    expect(answer('POST', 'license/documents', 200, { ...body, created: false })).toEqual([]);
  });

  it('matches for advisories', () => {
    const item = dto.advisoryDto({
      advisoryId: 'ADV-1',
      severity: 'high',
      title: 'A title',
      summary: 'A summary',
      affectedVersions: ['2.0.0'],
      fixedInVersions: ['2.0.1'],
      issuedAt: when,
      affectsThisRelease: null,
      testKey: false,
    });
    expect(answer('GET', 'advisories', 200, { items: [item] })).toEqual([]);
  });

  it('matches for an export at every status, finished or not', () => {
    const ready = dto.organizationExportDto(exportView);
    expect(answer('POST', 'exports', 202, ready)).toEqual([]);
    expect(answer('GET', 'exports', 200, { items: [ready] })).toEqual([]);
    expect(answer('GET', `exports/${ID}`, 200, ready)).toEqual([]);
    expect(ready.excluded).toEqual({
      restricted_work: 1,
      restricted_artifacts: 0,
      restricted_clients: 2,
    });
    const waiting = dto.organizationExportDto({
      ...exportView,
      status: 'requested',
      finishedAt: null,
      expiresAt: null,
      downloadable: false,
    });
    expect(answer('GET', `exports/${ID}`, 200, waiting)).toEqual([]);
    const failed = dto.organizationExportDto({
      ...exportView,
      status: 'failed',
      failureCode: 'BYTES_CHANGED',
      downloadable: false,
    });
    expect(answer('GET', `exports/${ID}`, 200, failed)).toEqual([]);
  });

  it('matches for an import and for the people in it', () => {
    const done = dto.organizationImportDto(importView);
    expect(answer('GET', `imports/${ID}`, 200, done)).toEqual([]);
    const fresh = dto.organizationImportDto({
      ...importView,
      status: 'requested',
      finishedAt: null,
      sourceOrganizationId: null,
      exportedAt: null,
      sourceRelease: null,
      appliedCounts: {},
      warningCounts: {},
    });
    expect(answer('POST', 'imports', 201, fresh)).toEqual([]);
    const listed = dto.importedPersonDto(person);
    expect(answer('GET', 'imported-people', 200, { items: [listed] })).toEqual([]);
    const linked = dto.importedPersonDto({ ...person, targetMembershipId: ID, linkedAt: when });
    expect(answer('POST', `imported-people/${ID}/link`, 200, linked)).toEqual([]);
  });

  it('declares every failure a route can give, as the implemented routes do', () => {
    const sovereign = operations().filter(({ path }) =>
      /\/(license|advisories|exports|imports|imported-people)/.test(path),
    );
    expect(sovereign).toHaveLength(11);
    for (const { method, path } of sovereign) {
      const { responses } = spec.paths[path]?.[method.toLowerCase()] as {
        responses: Record<string, unknown>;
      };
      for (const code of ['400', '401', '403', '404', '500', '503']) {
        expect(responses, `${method} ${path} lists ${code}`).toHaveProperty(code);
      }
    }
  });

  it('sends the archive as a download that is never stored, with a name that is safe', () => {
    const headers = new Headers(
      dto.archiveHeaders({ fileName: 'export "x"\r\nSet-Cookie: a.tar', totalBytes: 12 }),
    );
    expect(headers.get('content-type')).toBe('application/x-tar');
    expect(headers.get('cache-control')).toBe('no-store');
    expect(headers.get('content-length')).toBe('12');
    expect(headers.get('content-disposition')).toMatch(/^attachment; filename="[A-Za-z0-9._-]+"$/);
    expect(
      contractProblems({
        method: 'GET',
        path: `${organizationPath}/exports/${ID}/archive`,
        status: 200,
        headers,
      }).problems,
    ).toEqual([]);
  });

  it('refuses an archive response that would be kept, or that is shown rather than saved', () => {
    const headers = new Headers(dto.archiveHeaders({ fileName: 'a.tar', totalBytes: 1 }));
    headers.set('cache-control', 'public');
    expect(
      contractProblems({
        method: 'GET',
        path: `${organizationPath}/exports/${ID}/archive`,
        status: 200,
        headers,
      }).problems.join(),
    ).toContain('Cache-Control');
    headers.set('cache-control', 'no-store');
    headers.set('content-disposition', 'inline');
    expect(
      contractProblems({
        method: 'GET',
        path: `${organizationPath}/exports/${ID}/archive`,
        status: 200,
        headers,
      }).problems.join(),
    ).toContain('Content-Disposition');
  });
});

describe('streaming an archive', () => {
  const noFailure = () => {
    throw new Error('Nothing should have failed');
  };

  it('asks for a chunk only when the last has gone, and passes the bytes on unchanged', async () => {
    let asked = 0;
    async function* chunks() {
      for (const text of ['one', 'two', 'three']) {
        asked += 1;
        yield Buffer.from(text);
      }
    }
    const reader = dto.archiveStream(chunks(), noFailure).getReader();
    const first = await reader.read();
    expect(Buffer.from(first.value as Uint8Array).toString()).toBe('one');
    // The stream may hold one chunk ready, and never reads ahead by more than that.
    expect(asked).toBeLessThanOrEqual(2);
    const rest: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest.push(Buffer.from(value).toString());
    }
    expect(rest).toEqual(['two', 'three']);
  });

  it('breaks the download when the store fails, so a short file never looks whole', async () => {
    async function* chunks() {
      yield Buffer.from('one');
      throw Object.assign(new Error('secret store text'), { code: 'STORE_DOWN' });
    }
    const failures: unknown[] = [];
    const reader = dto
      .archiveStream(chunks(), (error) => failures.push(error))
      .getReader();
    const reading = (async () => {
      for (;;) {
        const { done } = await reader.read();
        if (done) return 'finished';
      }
    })();
    await expect(reading).rejects.toThrow('The archive could not be read');
    expect(failures).toHaveLength(1);
  });

  it('stops reading from the store when the person cancels', async () => {
    let stopped = false;
    async function* chunks() {
      try {
        for (;;) yield Buffer.from('more');
      } finally {
        stopped = true;
      }
    }
    const reader = dto.archiveStream(chunks(), noFailure).getReader();
    await reader.read();
    await reader.cancel();
    expect(stopped).toBe(true);
  });
});

describe('the key field on the export form', () => {
  const PUBLIC_KEY = Buffer.from('a public key, as a test value').toString('base64');

  it('takes a key, without the spaces a paste brings', () => {
    expect(dto.readRecipientKeyField(`  ${PUBLIC_KEY}\n`)).toEqual({ ok: true, key: PUBLIC_KEY });
  });

  it.each([
    '-----BEGIN PRIVATE KEY-----\nMC4CAQ\n-----END PRIVATE KEY-----',
    '-----BEGIN ENCRYPTED PRIVATE KEY-----',
    'private key',
  ])('says so when someone pastes the private half, and gives none of it back', (value) => {
    const refused = dto.readRecipientKeyField(value);
    expect(refused).toEqual({ ok: false, reason: 'private_key' });
    expect(JSON.stringify(refused)).not.toContain('MC4CAQ');
  });

  it.each(['', '   ', 'not base64 at all!', 'A'.repeat(513)])('refuses %j', (value) => {
    expect(dto.readRecipientKeyField(value)).toEqual({ ok: false, reason: 'invalid' });
  });
});
