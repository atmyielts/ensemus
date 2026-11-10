// API-12: the validator compares a status with the ones an operation lists, so an operation answering through
// `default` would refuse every documented refusal (tests/stack/sso-coverage.test.ts saw a 404 refused that way)
// and could hide a status nobody meant. Every operation lists its statuses one by one.
import { describe, expect, it } from 'vitest';
import { contractProblems, operationName, spec } from '../helpers/openapi';

const ORG = '6f1c2c6e-1111-4111-8111-111111111111';
const ID = '6f1c2c6e-2222-4222-8222-222222222222';
const json = (extra: Record<string, string> = {}) =>
  new Headers({ 'content-type': 'application/json', ...extra });
const refusal = (code: string) =>
  JSON.stringify({ code, message: 'x', request_id: ID, retryable: false });
const sso = `/api/v1/organizations/${ORG}/sso-connections/${ID}`;
const METHODS = ['get', 'put', 'post', 'patch', 'delete', 'head', 'options'];

describe('the statuses each operation lists', () => {
  it('names every one, with no default to stand in for the rest', () => {
    const withDefault: string[] = [];
    for (const [path, item] of Object.entries(spec.paths))
      for (const method of METHODS) {
        const operation = item[method] as { responses?: Record<string, unknown> } | undefined;
        if (operation?.responses && 'default' in operation.responses)
          withDefault.push(operationName(method, path));
      }
    expect(withDefault).toEqual([]);
  });

  it('accepts the ordinary missing answer for a company sign-in connection and its tokens', () => {
    for (const [method, path] of [
      ['GET', sso],
      ['PUT', `${sso}/metadata`],
      ['GET', `${sso}/scim-tokens`],
      ['POST', `${sso}/scim-tokens`],
      ['DELETE', `${sso}/scim-tokens/${ID}`],
    ] as const) {
      expect(
        contractProblems({ method, path, status: 404, headers: json(), text: refusal('NOT_FOUND') })
          .problems,
        `${method} ${path}`,
      ).toEqual([]);
      // Still a status it lists, not anything at all.
      expect(
        contractProblems({
          method,
          path,
          status: 418,
          headers: json(),
          text: refusal('X'),
        }).problems.join(),
        `${method} ${path}`,
      ).toContain('does not list this status');
    }
  });

  it('documents the token a SCIM token issue answers with, and nothing more', () => {
    const issued = (body: unknown) =>
      contractProblems({
        method: 'POST',
        path: `${sso}/scim-tokens`,
        status: 201,
        headers: json(),
        text: JSON.stringify(body),
      }).problems;
    expect(issued({ token_id: ID, token: 'ens_scim_generated' })).toEqual([]);
    expect(issued({ token_id: ID }).join()).toContain("required property 'token'");
    expect(issued({ token_id: ID, token: 'x', token_hash: 'y' }).join()).toContain(
      'additional properties',
    );
    expect(issued({ token_id: 'not-an-id', token: 'x' }).join()).toContain('/token_id');
  });
});
