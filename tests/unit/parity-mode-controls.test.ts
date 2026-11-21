// Scratch, never committed: runs the modes scenarios against in-memory fakes, to see them pass on right
// behaviour and fail on wrong behaviour. This shows the scenario logic only, and nothing about the product.
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({
  scenarios: {} as Record<string, (context: never) => Promise<unknown>>,
  file: '',
  statement: '',
  work: new Map<string, string>(),
  names: [] as string[],
  titles: new Map<string, string>(),
  stopped: false,
}));

// The scenarios only run once M4 is merged, and M4 changes this file, so its version is the one to check.
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    readFileSync: (path: string, ...rest: never[]) =>
      fs.readFileSync(
        String(path).endsWith('agent-definition.schema.json')
          ? (process.env.PARITY_M4_SCHEMA as string)
          : path,
        ...rest,
      ),
  };
});

vi.mock('../parity/harness', async (original) => ({
  ...(await original<object>()),
  describeParity: (file: string, scenarios: typeof captured.scenarios) => {
    captured.file = file;
    captured.scenarios = scenarios;
  },
}));

const LABEL: Record<string, string> = {
  created: 'Waiting to start',
  ready: 'Ready',
  running: 'In progress',
  verifying: 'Checking',
  completed: 'Done',
};

vi.mock('../helpers/forms', () => {
  const redirect = (location: string, body = '') =>
    new Response(body, { status: 303, headers: { location } });
  return {
    BASE: 'https://localhost:8443',
    PASSWORD: 'correct horse battery staple',
    tokenIn: (html: string) => /\/invite\/(\w+)/.exec(html)?.[1],
    signUp: async () => ({ jar: { cookie: 'x.session_token=abc.sig' }, name: 'n', email: 'e' }),
    join: async () => ({ jar: { cookie: '' }, name: 'm', email: 'm' }),
    read: async (path: string) => {
      if (path === '/') return { status: 200, location: null, html: captured.statement };
      const id = /\/work\/([0-9a-f-]{36})$/.exec(path)?.[1];
      if (id) {
        const status = LABEL[captured.work.get(id) ?? ''];
        return {
          status: 200,
          location: null,
          html: `<dt>Status</dt><dd><span class="badge x">${status}</span>`,
        };
      }
      return { status: 200, location: null, html: captured.names.join(' ') };
    },
    submit: async (path: string, _jar: unknown, match: unknown, values: Record<string, string>) => {
      if (captured.stopped) return new Response('', { status: 403 });
      if (path.endsWith('/work/new')) {
        const id = randomUUID();
        captured.work.set(id, 'created');
        captured.titles.set(values.title ?? '', //o/([^/]+)/.exec(path)?.[1] ?? '');
        return redirect(`${path.replace('/new', '')}/${id}`);
      }
      if (path.endsWith('/clients')) {
        captured.names.push(values.displayName ?? values.name ?? '');
        return redirect(path);
      }
      if (path.endsWith('/people')) return redirect(path, '/invite/abcdef');
      if (typeof match === 'function') {
        const id = /([0-9a-f-]{36})$/.exec(path)?.[1] ?? '';
        for (const to of Object.keys(LABEL)) {
          if ((match as (form: unknown) => boolean)({ html: '', hidden: new Map([['to', to]]) })) {
            captured.work.set(id, to);
          }
        }
      }
      return redirect(path);
    },
  };
});

type Tenant = { organization: string; owner: { jar: { cookie: string } } };

function fakeWorld(overrides: Record<string, Record<string, unknown>> = {}, ledgerRows: unknown[] = []) {
  const state = {
    calls: 0,
    behaviour: new Map<string, string>(),
    versions: new Map<string, number>(),
    published: new Set<string>(),
    sources: new Map<string, { org: string; revoked: boolean }>(),
    archiveText: new Map<string, string>(),
    titles: new Map<string, string[]>(),
    ledger: new Map<string, unknown[]>(),
  };
  const orgOf = (t: Tenant) => t.organization;
  const seams: Record<string, Record<string, unknown>> = {
    agentRuns: {
      publishManifest: async (t: Tenant, manifest: { id?: string; version?: number; tools?: { allow?: string[]; deny?: string[] }; skills?: string[] } & Record<string, unknown>) => {
        const validate = (world.validate ??= new Ajv2020({ strict: false }).compile(world.schema));
        if (!validate(manifest)) return 'INVALID_INPUT';
        const allow = manifest.tools?.allow ?? [];
        const known = ['work.read', 'artifact.read_text', 'artifact.draft.create', 'email.send', 'agent.delegate'];
        if (allow.some((tool) => !known.includes(tool))) return 'TOOL_DENIED';
        if (allow.some((tool) => manifest.tools?.deny?.includes(tool))) return 'TOOL_DENIED';
        if ((manifest.skills ?? []).length > 0) return 'SKILLS_NOT_SUPPORTED';
        const key = `${orgOf(t)}:${manifest.id}:${manifest.version}`;
        if (state.published.has(key)) return 'CONFLICT';
        state.published.add(key);
        state.versions.set(orgOf(t), (state.versions.get(orgOf(t)) ?? 0) + 1);
        return null;
      },
      runOverBudget: async () => ({ end: 'budget_exceeded', code: 'BUDGET_EXHAUSTED' }),
      delegateBeyondParent: async () => ({ end: 'denied', code: 'DELEGATION_DENIED' }),
      emergencyStop: async () => ({ queued: 'stopped', running: 'stopped' }),
    },
    knowledge: {
      ingest: async (t: Tenant) => {
        const source = randomUUID();
        state.sources.set(source, { org: orgOf(t), revoked: false });
        return { source };
      },
      serves: async (t: Tenant, _p: unknown, source: string) => {
        const found = state.sources.get(source);
        return found?.org === orgOf(t) && !found.revoked;
      },
      revoke: async (_t: Tenant, _p: unknown, source: string) => {
        const found = state.sources.get(source);
        if (found) found.revoked = true;
      },
      conflictingFactState: async () => 'disputed',
    },
    portability: {
      exportOrganization: async (t: Tenant) => {
        const archive = randomUUID();
        state.archiveText.set(archive, orgOf(t));
        return { archive, counts: { work: 2, clients: 1, projects: 1, people: 2, relations: 1 } };
      },
      importOrganization: async () => ({ work: 2, clients: 1, projects: 1, people: 2, relations: 1 }),
      archiveContains: async (archive: string, value: string) =>
        value.startsWith('Parity connection') ||
        (captured.titles.has(value) && captured.titles.get(value) === state.archiveText.get(archive)),
    },
    modelSupply: {
      arrange: async (t: Tenant, behaviour: string) => void state.behaviour.set(orgOf(t), behaviour),
      invoke: async (t: Tenant) => {
        if (state.behaviour.get(orgOf(t)) !== 'answers') {
          return { result: 'denied', code: 'MODEL_UNAVAILABLE' };
        }
        state.calls += 1;
        state.ledger.set(orgOf(t), ledgerRows);
        return { result: 'answered' };
      },
      callsReceived: async () => state.calls,
      supplierUsed: async () => world.supplier,
      rotateCustomerKey: async () => undefined,
      customerKeyVisibleToMembers: async () => false,
    },
    entitlement: {
      installLicense: async () => undefined,
      lapseMaintenance: async () => undefined,
      licenseCheck: async () => ({ valid: true, outsideContact: false }),
      verifyBundle: async (variant: string) => (variant === 'intact' ? 'accepted' : 'refused'),
      exhaustAllowance: async () => undefined,
      afterExhaustion: async () => ({ run: 'paused', chargedWithoutAsking: false }),
      inferenceBilledTo: async () => world.billedTo,
    },
    outbound: { attemptsDuringRound: async () => 0 },
  };
  for (const [seam, fields] of Object.entries(overrides)) Object.assign(seams[seam] as object, fields);
  const su = {
    query: async (sql: string, params: unknown[] = []) => {
      const org = params[0] as string;
      if (sql.includes('ai.agent_versions')) return { rows: [{ versions: state.versions.get(org) ?? 0 }] };
      if (sql.includes('work.work_units')) return { rows: [{ units: 2 }] };
      if (sql.includes('platform.usage_ledger')) return { rows: state.ledger.get(org) ?? [] };
      if (sql.includes('identity.accounts')) return { rows: [{ password: 'hash-value' }] };
      return { rows: [] };
    },
  };
  const world = {
    seams,
    su,
    schema: {} as object,
    validate: undefined as undefined | ((value: unknown) => boolean),
    supplier: 'customer_providers',
    billedTo: 'customer_direct',
  };
  return world;
}

const M4_SCHEMA = process.env.PARITY_M4_SCHEMA ?? '';

const contextFor = (mode: string, world: ReturnType<typeof fakeWorld>, expectedFor: (d: never, m: never) => string) => ({
  mode,
  su: world.su,
  tenant: async () => ({
    organization: randomUUID(),
    owner: { jar: { cookie: 'better-auth.session_token=abc.sig' }, name: 'o', email: 'o' },
  }),
  seam: (name: string) => world.seams[name],
  expected: (dimension: never) => expectedFor(dimension, mode as never),
});

const statementFor = (mode: string) => {
  const source = readFileSync('apps/web/src/app/page.tsx', 'utf8');
  const block = new RegExp(`\\n  ${mode}: \\{([\\s\\S]*?)\\n  \\},`).exec(source)?.[1] ?? '';
  const name = /name: '([^']+)'/.exec(block)?.[1];
  const points = [...block.matchAll(/^\s+'(.+)',$/gm)].map((m) => `<p>${m[1]}</p>`).join('');
  return `<main><section class="panel" aria-labelledby="responsibility-heading"><h2>Who is responsible for your data</h2><p>This deployment is <!-- -->${name}<!-- -->.</p>${points}</section></main>`;
};

describe('the modes scenarios on fakes', async () => {
  await import('../parity/scenarios/modes.parity');
  const { PARITY_CATALOG } = await import('../parity/catalog');
  const { expectedFor, MODE_CONTRACT } = await import('../parity/contract');
  const { canonicalObservation, identifiersIn } = await import('../parity/rules');
  const { SeamNotWired, seamFrom } = await import('../parity/seams');
  const specs = PARITY_CATALOG.filter((spec) => spec.file === 'modes');

  const prepare = (mode: string, overrides = {}, ledgerRows?: unknown[]) => {
    const billedTo = expectedFor('inference_billing', mode as never);
    const rows =
      ledgerRows ??
      ['model_input_tokens', 'model_output_tokens'].map((meter) => ({
        meter,
        billable: billedTo === 'ensemus',
        commercial_mode: mode,
        entries: 1,
      }));
    const world = fakeWorld(overrides, rows);
    world.schema = JSON.parse(readFileSync(M4_SCHEMA, 'utf8'));
    world.supplier = expectedFor('model_supply', mode as never);
    world.billedTo = billedTo;
    captured.statement = statementFor(mode);
    return world;
  };
  const run = (id: string, mode: string, world: ReturnType<typeof fakeWorld>) =>
    (captured.scenarios[id] as unknown as (c: unknown) => Promise<unknown>)(
      contextFor(mode, world, expectedFor as never),
    );

  beforeEach(() => {
    captured.work.clear();
    captured.names.length = 0;
    captured.titles.clear();
    captured.stopped = false;
  });

  it('implements every catalog ID of the file, and no other', () => {
    expect(captured.file).toBe('modes');
    expect(Object.keys(captured.scenarios).sort()).toEqual(specs.map((spec) => spec.id).sort());
  });

  it('names a real dimension in each contract', () => {
    for (const spec of specs) {
      if (spec.dimension) expect(Object.keys(MODE_CONTRACT)).toContain(spec.dimension);
    }
  });

  const allCases = specs.flatMap((spec) => spec.modes.map((mode) => [spec.id, mode] as const));

  it.each(allCases)('%s passes on right behaviour in %s, and holds no identifier', async (id, mode) => {
    const observed = await run(id, mode, prepare(mode));
    expect(identifiersIn(observed as never)).toEqual([]);
    expect(JSON.stringify(observed)).not.toMatch(/\$|price|allowance/i);
  });

  it.each(specs.filter((s) => s.kind === 'shared').map((s) => [s.id, s.modes] as const))(
    '%s observes the same thing in each of its modes',
    async (id, modes) => {
      const seen = new Set<string>();
      for (const mode of modes) {
        captured.work.clear();
        seen.add(canonicalObservation((await run(id, mode, prepare(mode))) as never));
      }
      expect(seen.size).toBe(1);
    },
  );

  it.each(
    specs.filter((s) => s.kind === 'mode_contract').flatMap((s) => s.modes.map((m) => [s.id, m, s.dimension] as const)),
  )('%s in %s returns the contract value', async (id, mode, dimension) => {
    const observed = (await run(id, mode, prepare(mode))) as Record<string, unknown>;
    expect(observed[dimension as string]).toBe(expectedFor(dimension as never, mode as never));
  });

  it.each(specs.filter((s) => s.id !== 'PAR-MODE-01').map((s) => [s.id, s.modes[0]] as const))(
    '%s is blocked before any setup when its seam is unplugged',
    async (id, mode) => {
      const tenant = vi.fn();
      const context = {
        mode,
        su: { query: vi.fn() },
        tenant,
        expected: vi.fn(),
        seam: (name: never) => seamFrom({}, name),
      };
      await expect(
        (captured.scenarios[id] as unknown as (c: unknown) => Promise<unknown>)(context),
      ).rejects.toBeInstanceOf(SeamNotWired);
      expect(tenant).not.toHaveBeenCalled();
      expect(context.su.query).not.toHaveBeenCalled();
    },
  );

  const answered = { result: 'answered' };
  const wrong: readonly [string, string, string, Record<string, Record<string, unknown>>][] = [
    ['PAR-AGENT-01', 'cloud', 'accepts everything', { agentRuns: { publishManifest: async () => null } }],
    ['PAR-AGENT-01', 'cloud', 'refuses with a sentence', { agentRuns: { publishManifest: async () => 'It was refused.' } }],
    ['PAR-AGENT-02', 'byom', 'keeps going', { agentRuns: { runOverBudget: async () => ({ end: 'completed', code: 'BUDGET_EXHAUSTED' }) } }],
    ['PAR-AGENT-02', 'byom', 'no code', { agentRuns: { runOverBudget: async () => ({ end: 'budget_exceeded', code: '' }) } }],
    ['PAR-AGENT-03', 'sovereign', 'child allowed', { agentRuns: { delegateBeyondParent: async () => ({ end: 'completed', code: 'X_Y' }) } }],
    ['PAR-AGENT-04', 'cloud', 'running keeps going', { agentRuns: { emergencyStop: async () => ({ queued: 'stopped', running: 'completed' }) } }],
    ['PAR-AGENT-04', 'cloud', 'stops everyone', { agentRuns: { runOverBudget: async () => ({ end: 'stopped', code: 'HALTED' }) } }],
    ['PAR-KNOW-01', 'cloud', 'still served after revoke', { knowledge: { revoke: async () => undefined } }],
    ['PAR-KNOW-01', 'cloud', 'never served', { knowledge: { serves: async () => false } }],
    ['PAR-KNOW-01', 'cloud', 'always served', { knowledge: { serves: async () => true } }],
    ['PAR-KNOW-02', 'byom', 'settled by itself', { knowledge: { conflictingFactState: async () => 'verified' } }],
    ['PAR-PORT-01', 'cloud', 'loses a record', { portability: { importOrganization: async () => ({ work: 1 }) } }],
    ['PAR-PORT-01', 'cloud', 'search finds nothing', { portability: { archiveContains: async () => false } }],
    ['PAR-PORT-01', 'cloud', 'search finds everything', { portability: { archiveContains: async () => true } }],
    ['PAR-PORT-01', 'cloud', 'exports nothing', { portability: { exportOrganization: async () => ({ archive: 'a', counts: {} }), importOrganization: async () => ({}) } }],
    ['PAR-PORT-02', 'cloud', 'search finds nothing', { portability: { archiveContains: async () => false } }],
    ['PAR-PORT-02', 'cloud', 'secret in the archive', { portability: { archiveContains: async () => true } }],
    ['PAR-MODEL-01', 'byom', 'falls back and answers', { modelSupply: { invoke: async () => answered } }],
    ['PAR-MODEL-01', 'sovereign', 'switches supplier', { modelSupply: { supplierUsed: async () => 'ensemus_providers' } }],
    ['PAR-MODEL-02', 'byom', 'shows the key', { modelSupply: { customerKeyVisibleToMembers: async () => true } }],
    ['PAR-MODE-02', 'cloud', 'wrong supplier', { modelSupply: { supplierUsed: async () => 'customer_providers' } }],
    ['PAR-MODE-02', 'byom', 'wrong supplier', { modelSupply: { supplierUsed: async () => 'ensemus_providers' } }],
    ['PAR-MODE-03', 'byom', 'bills Ensemus', { entitlement: { inferenceBilledTo: async () => 'ensemus' } }],
    ['PAR-MODE-04', 'cloud', 'keeps running', { entitlement: { afterExhaustion: async () => ({ run: 'continued', chargedWithoutAsking: false }) } }],
    ['PAR-MODE-04', 'cloud', 'charges anyway', { entitlement: { afterExhaustion: async () => ({ run: 'paused', chargedWithoutAsking: true }) } }],
    ['PAR-MODE-05', 'sovereign', 'one attempt out', { outbound: { attemptsDuringRound: async () => 1 } }],
    ['PAR-MODE-06', 'sovereign', 'license dies', { entitlement: { licenseCheck: async () => ({ valid: false, outsideContact: false }) } }],
    ['PAR-MODE-07', 'sovereign', 'phones home', { entitlement: { licenseCheck: async () => ({ valid: true, outsideContact: true }) } }],
    ['PAR-MODE-08', 'sovereign', 'takes a tampered bundle', { entitlement: { verifyBundle: async () => 'accepted' } }],
    ['PAR-MODE-08', 'sovereign', 'refuses everything', { entitlement: { verifyBundle: async () => 'refused' } }],
    ['PAR-MODE-09', 'sovereign', 'telemetry', { outbound: { attemptsDuringRound: async () => 2 } }],
  ];

  it.each(wrong)('%s in %s fails when it %s', async (id, mode, _what, overrides) => {
    await expect(run(id, mode, prepare(mode, overrides))).rejects.toThrow();
  });

  it.each([
    ['byom', 'charged by Ensemus too', [{ meter: 'model_input_tokens', billable: true, commercial_mode: 'byom', entries: 1 }, { meter: 'model_output_tokens', billable: false, commercial_mode: 'byom', entries: 1 }]],
    ['cloud', 'charged twice', [{ meter: 'model_input_tokens', billable: true, commercial_mode: 'cloud', entries: 2 }]],
    ['cloud', 'never recorded', []],
    ['byom', 'never recorded', []],
    ['cloud', 'another mode wrote it', [{ meter: 'model_input_tokens', billable: true, commercial_mode: 'byom', entries: 1 }]],
  ] as const)('PAR-MODE-03 fails in %s when %s', async (mode, _what, rows) => {
    await expect(run('PAR-MODE-03', mode, prepare(mode, {}, [...rows]))).rejects.toThrow();
  });

  it.each([
    ['cloud', 'sovereign'],
    ['sovereign', 'cloud'],
    ['byom', 'cloud'],
    ['cloud', 'byom'],
  ])('PAR-MODE-01 in %s fails on the statement of %s', async (mode, other) => {
    const world = prepare(mode);
    captured.statement = statementFor(other);
    await expect(run('PAR-MODE-01', mode, world)).rejects.toThrow();
  });

  it('PAR-MODE-01 fails when the statement says both, or nothing', async () => {
    const world = prepare('sovereign');
    captured.statement = statementFor('sovereign').replace('</section>', '<p>Ensemus hosts this service</p></section>');
    await expect(run('PAR-MODE-01', 'sovereign', world)).rejects.toThrow();
    captured.statement = '<main></main>';
    await expect(run('PAR-MODE-01', 'sovereign', world)).rejects.toThrow();
  });

  it('PAR-MODE-06 fails when work stops after the lapse', async () => {
    const world = prepare('sovereign', {
      entitlement: {
        lapseMaintenance: async () => {
          captured.stopped = true;
        },
      },
    });
    await expect(run('PAR-MODE-06', 'sovereign', world)).rejects.toThrow();
  });

  void writeFileSync;
  void mkdtempSync;
  void tmpdir;
  void joinPath;
});
