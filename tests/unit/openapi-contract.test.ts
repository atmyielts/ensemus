// API-12: the spec against the routes that exist, and the validator against responses that must fail.
// tests/stack/api.test.ts puts every real response through the same validator.
import { describe, expect, it } from 'vitest';
import {
  contractProblems,
  exportedMethods,
  implementedRoutes,
  operationName,
  operations,
  spec,
} from '../helpers/openapi';

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
      'studio/agent-drafts',
      'studio/agent-drafts',
      'studio/agent-drafts/{agent_draft_id}',
      'studio/agent-drafts/{agent_draft_id}',
      'studio/agent-drafts/{agent_draft_id}/simulations',
      'studio/process-drafts',
      'studio/process-drafts',
      'studio/process-drafts/{process_draft_id}',
      'studio/process-drafts/{process_draft_id}',
      'studio/process-drafts/{process_draft_id}/simulations',
      'studio/simulations/{simulation_id}',
      'studio/publish-reviews',
      'studio/publish-reviews',
      'studio/publish-reviews/{publish_review_id}',
      'studio/publish-reviews/{publish_review_id}/decisions',
      'studio/publish-reviews/{publish_review_id}/publication',
      'process-specs',
      'process-runs',
      'process-runs',
      'process-runs/{process_run_id}',
      'process-runs/{process_run_id}/stop',
      'pulse',
      'pulse/signals/{signal_key}',
      'outcome-drafts',
      'outcome-drafts',
      'outcome-drafts/{outcome_draft_id}',
      'outcome-drafts/{outcome_draft_id}',
      'outcome-drafts/{outcome_draft_id}',
      'outcome-drafts/{outcome_draft_id}/authorization',
      'onboarding',
      'onboarding/steps/{step_key}',
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

  it('refuses an unknown path and an undeclared method on an implemented path', () => {
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
        method: 'DELETE',
        path: `/api/v1/organizations/${ORG}/knowledge/search`,
        status: 200,
        headers: json(),
        text: '{}',
      }).problems.join(),
    ).toContain('no such operation');
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
