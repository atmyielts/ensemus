// The live status route needs a whole stack to run for real. tests/integration/web-behaviour.test.ts covers
// what it asks for, tests/integration/member-tenant-tx.test.ts what one poll reads, and
// tests/stack/tenant-streams.test.ts what it sends. This pins what none of them can see: a stream that did
// not ask about evidence does not pay for it on every poll, and the order of a poll. A closed gate or a
// refusal ends the stream with nothing written, and that is run here against the route's own code.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, sep } from 'node:path';
import { compileFunction } from 'node:vm';
import { TenantAccessDenied, type TenantContext } from '@ensemus/database';
import { errorCode } from '@ensemus/telemetry';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../packages/application/src/errors';
import { repoRoot } from '../helpers/stack';

const route = readFileSync(
  join(
    repoRoot,
    'apps/web/src/app/api/v1/organizations/[organizationId]/work-units/[workUnitId]/events/route.ts',
  ),
  'utf8',
);

/** The text of `currentState`, which is what runs on every poll. */
function pollBody() {
  const match = /async function currentState\(\) \{([\s\S]*?)\n {4}\}/.exec(route);
  if (!match?.[1]) throw new Error('The poll has moved, so this test no longer sees it.');
  return match[1];
}

describe('a stream of live status', () => {
  it('asks about evidence only if the client did, on its first read and on every poll', () => {
    expect(route).toContain('const asked = { evidence: withEvidence };');
    const reads = [...route.matchAll(/getWorkFollowState(?:AsMember)?\(([^)]*)\)/g)].map(
      (match) => match[1],
    );
    expect(reads).toHaveLength(2);
    // A call long enough to wrap has its arguments on lines of their own, and a comma after the last.
    for (const read of reads) expect(read?.replace(/\s+/g, ' ').trim()).toMatch(/, asked,?$/);
  });

  it('reads as a member on a poll, then asks the gate about the context that read returned', () => {
    const poll = pollBody();
    const read = poll.indexOf('getWorkFollowStateAsMember(');
    const gate = poll.indexOf('getRestoreGate().assertServing(fresh)');
    expect(read).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(read);
    expect(poll).toMatch(/const \{ context: fresh, state \} = await getWorkFollowStateAsMember\(/);
    expect(poll.slice(gate)).toMatch(/return state;/);
  });

  it('no longer checks the membership in a transaction of its own', () => {
    expect(route).not.toContain('resolveTenantContext');
  });

  it('leaves the first read as it was, because the wrapper has just checked the membership', () => {
    expect(route).toMatch(/await getWorkFollowState\(database, context, params\.workUnitId, asked\)/);
  });
});

describe('the second way to bind a tenant', () => {
  const sources = (root: string): string[] =>
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
      .map((entry) => join(entry.parentPath, entry.name));

  const roots = (group: string) =>
    readdirSync(join(repoRoot, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(repoRoot, group, entry.name, 'src'))
      .filter((path) => existsSync(path));

  it('has one caller, because it needs outside review (ADR-037 D5)', () => {
    const everything = [...roots('apps'), ...roots('packages'), ...roots('workers')].flatMap(
      sources,
    );
    const callers = everything
      .filter((path) => /\bwithMemberTenantTx\s*[(<]/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(repoRoot, path).split(sep).join('/'));
    expect(callers.sort()).toEqual([
      'packages/application/src/work.ts',
      'packages/database/src/tenant.ts',
    ]);
  });
});

// The route imports through an alias only Next.js knows about, and a route file can export nothing but
// its handlers. So this compiles the file as it stands and hands it fakes in place of its imports, and
// what runs is the route's real loop. The fakes live here, and no code path outside this test can reach them.
type Read = { version: number; evidence: string | null };
type Poll = { context: TenantContext; state: Read };
type Scope = {
  request: Request;
  requestId: string;
  userId: string;
  context: TenantContext;
  database: object;
  params: { organizationId: string; workUnitId: string };
};

const webRequire = createRequire(join(repoRoot, 'apps/web/package.json'));
const compiledRoute = ts.transpileModule(route, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

const contextNamed = (name: string) => ({ organizationId: name }) as unknown as TenantContext;

const USER = '7f3c2b1a-0000-4000-8000-000000000001';
const ORGANIZATION = '7f3c2b1a-0000-4000-8000-000000000002';
const WORK = '7f3c2b1a-0000-4000-8000-000000000003';

/** Runs one stream to its end. Each entry in `polls` is what one poll's read does. */
async function runStream(options: {
  polls: (() => Poll | Promise<Poll>)[];
  gate?: (context: TenantContext) => Promise<void>;
  session?: () => Promise<{ user: { id: string } } | null>;
  first?: Read;
  url?: string;
  /** How far the clock moves on each sleep, for what the route does only after some time has passed. */
  tick?: number;
}) {
  const log: string[] = [];
  const memberReads: unknown[][] = [];
  const firstRead = vi.fn(
    async (..._args: unknown[]) => options.first ?? { version: 1, evidence: null },
  );
  const remaining = [...options.polls];
  const warnings: unknown[][] = [];
  const session = vi.fn(options.session ?? (async () => ({ user: { id: USER } })));
  let clock = 1_000_000;
  const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);

  const modules: Record<string, unknown> = {
    'node:timers/promises': {
      // No real waiting, but still a turn of the event loop, and it honours the signal as the real one does.
      setTimeout: async (_ms: number, _value: unknown, { signal }: { signal: AbortSignal }) => {
        await new Promise((resolve) => setImmediate(resolve));
        clock += options.tick ?? 1_000;
        if (signal.aborted) throw signal.reason;
      },
    },
    '@ensemus/application': {
      AppError,
      getWorkFollowState: firstRead,
      getWorkFollowStateAsMember: async (...args: unknown[]) => {
        memberReads.push(args);
        log.push('read');
        const next = remaining.shift();
        if (!next) throw new Error('The stream polled more often than this test expected.');
        return next();
      },
    },
    '@ensemus/database': { TenantAccessDenied },
    '@ensemus/telemetry': { errorCode },
    zod: webRequire('zod'),
    '@/server/api': {
      apiLog: { warn: (...args: unknown[]) => warnings.push(args) },
      apiRoute: (_schema: unknown, handler: (scope: Scope) => Promise<Response>) => handler,
      readQuery: (request: Request, schema: { parse: (value: unknown) => unknown }) =>
        schema.parse(Object.fromEntries(new URL(request.url).searchParams)),
      workUnitParams: {},
    },
    '@/server/runtime': {
      getRestoreGate: () => ({
        assertServing: async (context: TenantContext) => {
          log.push(`gate:${context.organizationId}`);
          await options.gate?.(context);
        },
      }),
      getRuntime: () => ({ auth: { api: { getSession: session } } }),
    },
  };

  const exported: { GET?: (scope: Scope) => Promise<Response> } = {};
  compileFunction(compiledRoute, ['require', 'exports'])((id: string) => {
    if (!(id in modules)) throw new Error(`The route imports something new: ${id}`);
    return modules[id];
  }, exported);
  if (!exported.GET) throw new Error('The route has no GET.');

  const database = {};
  const firstContext = contextNamed('first');
  const response = await exported.GET({
    request: new Request(options.url ?? 'http://test.invalid/events'),
    requestId: 'request-1',
    userId: USER,
    context: firstContext,
    database,
    params: { organizationId: ORGANIZATION, workUnitId: WORK },
  });
  const text = await response.text();
  now.mockRestore();
  return { text, log, memberReads, warnings, session, firstRead, database, firstContext };
}

const seen = (version: number, name = 'fresh'): Poll => ({
  context: contextNamed(name),
  state: { version, evidence: null },
});
const denied = () => {
  throw new TenantAccessDenied();
};
const restoring = () => {
  throw new AppError('RESTORE_PENDING');
};

/** What the stream sends for the first read at version 1, and nothing after it. */
const OPENING = 'retry: 3000\n\nid: 1\nevent: status\ndata: 1\n\n';

describe('one poll of a live stream', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads, then asks the gate about the context that read returned, on every poll', async () => {
    const { log, text, memberReads, database, firstRead, firstContext } = await runStream({
      polls: [() => seen(1, 'one'), () => seen(2, 'two'), denied],
    });
    expect(log).toEqual(['read', 'gate:one', 'read', 'gate:two', 'read']);
    expect(text).toBe(`${OPENING}id: 2\nevent: status\ndata: 2\n\n`);
    // Who is asking comes from the session and the path, never from the context of an earlier poll.
    for (const args of memberReads) {
      expect(args).toEqual([database, USER, ORGANIZATION, WORK, { evidence: false }]);
    }
    expect(firstRead).toHaveBeenCalledExactlyOnceWith(database, firstContext, WORK, {
      evidence: false,
    });
  });

  it('passes on that the client asked about the evidence, on every poll', async () => {
    const { memberReads, firstRead, database, firstContext, text } = await runStream({
      url: 'http://test.invalid/events?include=evidence',
      first: { version: 1, evidence: 'a' },
      polls: [
        () => ({ context: contextNamed('fresh'), state: { version: 1, evidence: 'b' } }),
        denied,
      ],
    });
    for (const args of memberReads) expect(args.at(-1)).toEqual({ evidence: true });
    expect(firstRead).toHaveBeenCalledExactlyOnceWith(database, firstContext, WORK, {
      evidence: true,
    });
    expect(text).toContain('event: evidence\ndata: a\n\n');
    expect(text).toContain('event: evidence\ndata: b\n\n');
  });

  it('ends with nothing written when the gate closes after a read that saw something new', async () => {
    const { log, text, warnings } = await runStream({
      polls: [() => seen(2)],
      gate: async () => restoring(),
    });
    expect(log).toEqual(['read', 'gate:fresh']);
    // Version 2 was read and is thrown away: it may be a past the restore has removed.
    expect(text).toBe(OPENING);
    expect(warnings).toEqual([]);
  });

  it('ends with nothing written, and says so, when the gate cannot answer', async () => {
    const { text, warnings } = await runStream({
      polls: [() => seen(2)],
      gate: async () => {
        throw Object.assign(new Error('the object store did not answer'), { code: 'STORE_DOWN' });
      },
    });
    expect(text).toBe(OPENING);
    expect(warnings).toEqual([
      ['api.stream_failed', { requestId: 'request-1', errorCode: 'STORE_DOWN' }],
    ]);
  });

  it('ends without asking the gate for someone who is no longer a member', async () => {
    const { log, text, warnings } = await runStream({ polls: [denied] });
    expect(log).toEqual(['read']);
    expect(text).toBe(OPENING);
    expect(warnings).toEqual([]);
  });

  it('ends without asking the gate when the work can no longer be seen', async () => {
    const { log, text, warnings } = await runStream({
      polls: [
        () => {
          throw new AppError('NOT_FOUND');
        },
      ],
    });
    expect(log).toEqual(['read']);
    expect(text).toBe(OPENING);
    expect(warnings).toEqual([]);
  });

  it('ends with nothing written, and says so, when the database refuses midway', async () => {
    const { log, text, warnings } = await runStream({
      polls: [
        () => {
          throw Object.assign(new Error('terminating connection'), { code: '57P01' });
        },
      ],
    });
    expect(log).toEqual(['read']);
    expect(text).toBe(OPENING);
    expect(warnings).toEqual([['api.stream_failed', { requestId: 'request-1', errorCode: '57P01' }]]);
  });

  it('never tells the log what the database said', async () => {
    const { warnings } = await runStream({
      polls: [
        () => {
          throw new Error(`no such row for ${ORGANIZATION}`);
        },
      ],
    });
    expect(JSON.stringify(warnings)).not.toContain(ORGANIZATION);
  });

  it('still ends for a signed-out session, before it reads again', async () => {
    const { log, text, session } = await runStream({
      polls: [],
      session: async () => null,
      tick: 30_000,
    });
    expect(session).toHaveBeenCalledOnce();
    expect(log).toEqual([]);
    expect(text).toBe(OPENING);
  });

  it('still keeps a quiet stream alive', async () => {
    const { text } = await runStream({ polls: [() => seen(1), denied], tick: 15_000 });
    expect(text).toBe(`${OPENING}: keep-alive\n\n`);
  });
});
