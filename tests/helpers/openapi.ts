// API-12: checks real responses against docs/specifications/openapi.yaml, with a JSON Schema 2020-12
// validator over the file itself. Nothing here is written by hand from the spec, so a change to either
// the spec or a route that makes them disagree fails a test.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { join, relative, sep } from 'node:path';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import ts from 'typescript';
import { parse } from 'yaml';
import { repoRoot } from './stack';

type Json = Record<string, unknown>;
type Response = {
  content?: Record<string, { schema?: Json }>;
  headers?: Record<string, Json>;
};
type Operation = { responses: Record<string, Json>; 'x-ensemus-status'?: string };

const ROOT = 'urn:ensemus:openapi';
const METHODS = ['get', 'put', 'post', 'patch', 'delete', 'head', 'options'] as const;

export const spec = parse(
  readFileSync(join(repoRoot, 'docs/specifications/openapi.yaml'), 'utf8'),
) as {
  security: unknown[];
  paths: Record<string, Record<string, unknown>>;
  components: {
    securitySchemes: Record<string, Json>;
    schemas: Record<string, { properties: Record<string, Json> }>;
  };
};

/** Makes every local reference absolute, so a schema taken out of the file still resolves. */
function absolute(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(absolute);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [
      key,
      key === '$ref' && typeof inner === 'string' ? `${ROOT}${inner}` : absolute(inner),
    ]),
  );
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
(addFormats as unknown as (instance: typeof ajv) => void)(ajv);
const document = absolute(spec) as Json;
ajv.addSchema(document, ROOT);

/** Follows a reference to a place in the file, such as a shared response. */
function resolve<T>(node: Json): T {
  const ref = node.$ref;
  if (typeof ref !== 'string') return node as T;
  const pointer = ref.slice(`${ROOT}#/`.length).split('/');
  return resolve(pointer.reduce((at: Json, key) => at[key] as Json, document));
}

const compiled = new WeakMap<object, ValidateFunction>();
function validatorFor(schema: Json) {
  let validate = compiled.get(schema);
  if (!validate) {
    validate = ajv.compile(schema);
    compiled.set(schema, validate);
  }
  return validate;
}

const templates = Object.keys(spec.paths).map((template) => ({
  template,
  pattern: new RegExp(`^${template.replaceAll(/\{[^}]+\}/g, '[^/]+')}$`),
}));

/** Every operation in the spec, with the state it claims to be in. */
export function operations() {
  return Object.entries(spec.paths).flatMap(([path, item]) =>
    METHODS.filter((method) => item[method]).map((method) => ({
      method: method.toUpperCase(),
      path,
      status: (item[method] as Operation)['x-ensemus-status'],
    })),
  );
}

export const operationName = (method: string, path: string) => `${method.toUpperCase()} ${path}`;

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

function boundNames(name: ts.BindingName): string[] {
  return ts.isIdentifier(name)
    ? [name.text]
    : name.elements.flatMap((element) =>
        ts.isBindingElement(element) ? boundNames(element.name) : [],
      );
}

/**
 * The HTTP methods a route module exports, in every form Next.js accepts: a variable, a destructured
 * one, a function, or a name in an export list. It parses the file, so a comment or a string that only
 * looks like an export does not count. A form this misses is a route the spec check cannot see.
 */
export function exportedMethods(source: string): string[] {
  const names = ts
    .createSourceFile('route.ts', source, ts.ScriptTarget.Latest)
    .statements.flatMap((statement) => {
      if (ts.isExportDeclaration(statement)) {
        const clause = statement.exportClause;
        return clause && ts.isNamedExports(clause)
          ? clause.elements.map((element) => element.name.text)
          : [];
      }
      const exported =
        ts.canHaveModifiers(statement) &&
        ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (!exported) return [];
      if (ts.isFunctionDeclaration(statement)) return statement.name ? [statement.name.text] : [];
      if (!ts.isVariableStatement(statement)) return [];
      return statement.declarationList.declarations.flatMap((item) => boundNames(item.name));
    });
  return [...new Set(names.filter((name) => HTTP_METHODS.has(name)))];
}

/** The Route Handlers that exist, as `METHOD /path` in the spec's own naming. */
export function implementedRoutes() {
  const api = join(repoRoot, 'apps/web/src/app/api/v1');
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const full = join(directory, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry === 'route.ts') {
        const segments = relative(api, directory).split(sep);
        const path = `/${segments
          .map((segment) =>
            segment.replace(
              /^\[(.+)\]$/,
              (_, name: string) =>
                `{${name.replaceAll(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}}`,
            ),
          )
          .join('/')}`;
        for (const method of exportedMethods(readFileSync(full, 'utf8'))) {
          found.push(operationName(method, path));
        }
      }
    }
  };
  walk(api);
  return found;
}

/** A length limit the spec states for a field of a request body. */
export function requestLimit(
  path: string,
  method: string,
  field: string,
  limit: 'minLength' | 'maxLength',
): number {
  const operation = (document.paths as Record<string, Json>)[path]?.[method] as {
    requestBody: { content: Record<string, { schema: Json }> };
  };
  const body = resolve<{ properties: Record<string, Json> }>(
    operation.requestBody.content['application/json']?.schema as Json,
  );
  return body.properties[field]?.[limit] as number;
}

export type ObservedResponse = {
  method: string;
  /** The path as it was requested, from /api/v1 onward, with or without a query. */
  path: string;
  status: number;
  headers: Headers;
  /** The body. Leave it out for a stream, which only has its type checked. */
  text?: string;
};

const API_PREFIX = '/api/v1';

/**
 * API-12's record: every operation a real response under 400 has been seen for, matching the spec. Each stack
 * test file runs in a worker of its own, so a record kept in memory holds what one file saw and nothing more.
 * With ENSEMUS_API_RECORD_DIR set, as infrastructure/scripts/air-gap-gate.mjs sets it for one run, every file
 * appends to the same record, and validatedOperations() reads them all back.
 */
const RECORD_FILE = 'validated-operations.txt';
const recordedHere = new Set<string>();

function recordValidated(operation: string) {
  if (recordedHere.has(operation)) return;
  recordedHere.add(operation);
  const folder = process.env.ENSEMUS_API_RECORD_DIR;
  if (!folder) return;
  mkdirSync(folder, { recursive: true });
  // One short line per append, so files writing at once cannot interleave within a line.
  appendFileSync(join(folder, RECORD_FILE), `${operation}\n`);
}

/**
 * The operations validated so far: in this file, and, with a shared record, in every file of this run. `shared`
 * says which, so a check can say why it saw so little.
 */
export function validatedOperations(): { operations: Set<string>; shared: boolean } {
  const operations = new Set(recordedHere);
  const folder = process.env.ENSEMUS_API_RECORD_DIR;
  const file = folder ? join(folder, RECORD_FILE) : undefined;
  if (file && existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) if (line) operations.add(line);
  }
  return { operations, shared: Boolean(folder) };
}

/**
 * What is wrong with this response, by the spec. An empty list means it matches, and a matching response
 * under 400 is recorded as validated for its operation.
 */
export function contractProblems(observed: ObservedResponse): {
  operation?: string;
  problems: string[];
} {
  const result = checkResponse(observed);
  if (result.operation && result.problems.length === 0 && observed.status < 400) {
    recordValidated(result.operation);
  }
  return result;
}

function checkResponse(observed: ObservedResponse): {
  operation?: string;
  problems: string[];
} {
  const path = observed.path.split('?')[0]?.replace(API_PREFIX, '') ?? '';
  const match = templates.find(({ pattern }) => pattern.test(path));
  const label = `${observed.method} ${path} answered ${observed.status}`;
  if (!match) return { problems: [`${label}: no such path in the spec`] };
  const operation = (document.paths as Record<string, Json>)[match.template]?.[
    observed.method.toLowerCase()
  ] as Operation | undefined;
  const name = operationName(observed.method, match.template);
  if (!operation) return { problems: [`${label}: the spec has no such operation`] };
  if (operation['x-ensemus-status'] === 'planned') {
    return { problems: [`${label}: the spec says this operation does not exist yet`] };
  }
  const declared = operation.responses[String(observed.status)];
  if (!declared) {
    return { operation: name, problems: [`${label}: the spec does not list this status`] };
  }
  const response = resolve<Response>(declared);
  const problems: string[] = [];

  for (const [header, reference] of Object.entries(response.headers ?? {})) {
    const definition = resolve<{ required?: boolean; schema?: Json }>(reference);
    const value = observed.headers.get(header);
    if (value === null) {
      if (definition.required) problems.push(`${label}: missing header ${header}`);
    } else if (definition.schema && !validatorFor(definition.schema)(value)) {
      problems.push(`${label}: header ${header} does not match its schema`);
    }
  }

  const contentType = observed.headers.get('content-type')?.split(';')[0]?.trim();
  if (!response.content) {
    if (observed.text) problems.push(`${label}: the spec says no body, and there was one`);
    return { operation: name, problems };
  }
  const media = contentType ? response.content[contentType] : undefined;
  if (!media) {
    problems.push(`${label}: the spec does not list content type ${contentType}`);
    return { operation: name, problems };
  }
  if (contentType !== 'application/json' || observed.text === undefined) {
    return { operation: name, problems };
  }
  let body: unknown;
  try {
    body = JSON.parse(observed.text);
  } catch {
    problems.push(`${label}: the body is not JSON`);
    return { operation: name, problems };
  }
  const validate = validatorFor(media.schema as Json);
  if (!validate(body)) {
    for (const error of validate.errors ?? []) {
      problems.push(`${label}: ${error.instancePath || 'body'} ${error.message}`);
    }
  }
  return { operation: name, problems };
}
