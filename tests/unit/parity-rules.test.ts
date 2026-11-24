// COMM-06: what the parity gate decides. A gate that cannot fail is worse than no gate, so these are the
// decisions that make it fail or hold back. The gate itself needs Docker and has not run.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { commercialModes } from '../../packages/config/src/index';
import { PARITY_CATALOG } from '../parity/catalog';
import { ALLOWED_DIFFERENCES, expectedFor, MODE_CONTRACT } from '../parity/contract';
import {
  canonicalObservation,
  COMMERCIAL_MODES,
  type CommercialMode,
  compareReports,
  describeOutcome,
  type FindingKind,
  identifiersIn,
  type ModeReport,
  type ParityScenarioSpec,
  type ScenarioResult,
} from '../parity/rules';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const readDoc = (path: string) => readFileSync(join(root, path), 'utf8');

const SHARED: ParityScenarioSpec = {
  id: 'S-1',
  title: 'shared',
  kind: 'shared',
  modes: COMMERCIAL_MODES,
  file: 'x',
  tickets: [],
  qa: [],
};
const ONLY_SOVEREIGN: ParityScenarioSpec = {
  id: 'C-1',
  title: 'contract',
  kind: 'mode_contract',
  modes: ['sovereign'],
  file: 'x',
  tickets: [],
  qa: [],
  dimension: 'offline_operation',
};
const CATALOG = [SHARED, ONLY_SOVEREIGN];

const pass = (id: string, observed: ScenarioResult['observed'] = { status: 'done' }) =>
  ({ id, outcome: 'pass', observed }) as ScenarioResult;

function report(mode: CommercialMode, over: Partial<ModeReport> = {}): ModeReport {
  return {
    schema: 1,
    mode,
    commit: 'a'.repeat(40),
    dirty: false,
    images: { web: 'sha256:web', worker: 'sha256:worker' },
    network: mode === 'sovereign' ? 'blackholed' : 'open',
    startedAt: '2026-11-06T00:00:00.000Z',
    scenarios: mode === 'sovereign' ? [pass('S-1'), pass('C-1')] : [pass('S-1')],
    ...over,
  };
}
const allThree = (over: Partial<Record<CommercialMode, Partial<ModeReport>>> = {}) =>
  COMMERCIAL_MODES.map((mode) => report(mode, over[mode] ?? {}));

const kinds = (reports: readonly ModeReport[], catalog = CATALOG) =>
  compareReports(reports, catalog).findings.map((finding) => finding.kind);
const verdict = (reports: readonly ModeReport[], catalog = CATALOG) =>
  compareReports(reports, catalog).verdict;

describe('a verdict of proven', () => {
  it('needs every mode to run every scenario, pass, and behave alike', () => {
    const outcome = compareReports(allThree(), CATALOG);
    expect(outcome).toMatchObject({ verdict: 'proven', findings: [], passed: 4, expected: 4 });
  });

  it('is not given for an empty catalog', () => {
    expect(verdict(allThree(), [])).toBe('failed');
  });
});

describe('what leaves it not proven', () => {
  const cases: readonly [string, () => ModeReport[], FindingKind][] = [
    ['a mode that did not run', () => [report('cloud'), report('byom')], 'missing_report'],
    ['a scenario that did not run', () => allThree({ cloud: { scenarios: [] } }), 'missing_result'],
    [
      'a scenario waiting on another milestone',
      () =>
        allThree({
          byom: { scenarios: [{ id: 'S-1', outcome: 'blocked', blockedBy: 'not wired' }] },
        }),
      'scenario_blocked',
    ],
    ['uncommitted changes', () => allThree({ cloud: { dirty: true } }), 'uncommitted_changes'],
    [
      'Sovereign with the network open',
      () => allThree({ sovereign: { network: 'open' } }),
      'open_network',
    ],
  ];

  it.each(cases)('%s', (_, build, kind) => {
    expect(kinds(build())).toContain(kind);
    expect(verdict(build())).toBe('not_proven');
  });

  it('counts a blocked scenario as not passed', () => {
    const reports = allThree({
      cloud: { scenarios: [{ id: 'S-1', outcome: 'blocked', blockedBy: 'not wired' }] },
    });
    expect(compareReports(reports, CATALOG).passed).toBe(3);
  });
});

describe('what fails it', () => {
  const differs = allThree({ byom: { scenarios: [pass('S-1', { status: 'other' })] } });
  const cases: readonly [string, ModeReport[], FindingKind][] = [
    [
      'a scenario that failed',
      allThree({ cloud: { scenarios: [{ id: 'S-1', outcome: 'fail', failure: 'no' }] } }),
      'scenario_failed',
    ],
    ['one behaviour differing between modes', differs, 'behaviour_differs'],
    [
      'a pass that saw nothing',
      allThree({ cloud: { scenarios: [{ id: 'S-1', outcome: 'pass' }] } }),
      'no_observation',
    ],
    [
      'an identifier in what it saw',
      allThree({
        cloud: { scenarios: [pass('S-1', { id: '0d3c6c1e-2f6b-4f7a-9a54-0d3a8f6a1b2c' })] },
      }),
      'identifier_in_observation',
    ],
    ['different commits', allThree({ cloud: { commit: 'b'.repeat(40) } }), 'different_commit'],
    [
      'different images, which would only show that two builds agree',
      allThree({ byom: { images: { web: 'sha256:other', worker: 'sha256:worker' } } }),
      'different_images',
    ],
    [
      'a scenario the catalog does not know',
      allThree({ cloud: { scenarios: [pass('S-1'), pass('ELSE-1')] } }),
      'unknown_scenario',
    ],
    [
      'a scenario that ran where it does not apply',
      allThree({ cloud: { scenarios: [pass('S-1'), pass('C-1')] } }),
      'wrong_mode',
    ],
    [
      'a scenario reported twice',
      allThree({ cloud: { scenarios: [pass('S-1'), pass('S-1')] } }),
      'duplicate_result',
    ],
    ['two reports for one mode', [...allThree(), report('cloud')], 'duplicate_report'],
  ];

  it.each(cases)('%s', (_, reports, kind) => {
    expect(kinds(reports)).toContain(kind);
    expect(verdict(reports)).toBe('failed');
  });

  it('wins over not proven', () => {
    const reports = [report('cloud', { scenarios: [{ id: 'S-1', outcome: 'fail' }] })];
    expect(verdict(reports)).toBe('failed');
  });

  it('does not compare a mode contract across modes, because those are allowed to differ', () => {
    const contract: ParityScenarioSpec = { ...SHARED, kind: 'mode_contract', dimension: 'updates' };
    const reports = COMMERCIAL_MODES.map((mode) =>
      report(mode, { scenarios: [pass('S-1', { value: expectedFor('updates', mode) })] }),
    );
    expect(verdict(reports, [contract])).toBe('proven');
  });

  it('compares a shared scenario only across the modes it lists', () => {
    const customer: ParityScenarioSpec = { ...SHARED, modes: ['byom', 'sovereign'] };
    const reports = [
      report('cloud', { scenarios: [] }),
      report('byom', { scenarios: [pass('S-1', { code: 'A' })] }),
      report('sovereign', { scenarios: [pass('S-1', { code: 'B' })] }),
    ];
    expect(kinds(reports, [customer])).toContain('behaviour_differs');
  });
});

describe('what an observation may hold', () => {
  it.each([
    ['a UUID', '0d3c6c1e-2f6b-4f7a-9a54-0d3a8f6a1b2c'],
    ['an email address', 'someone@example.invalid'],
    ['a timestamp', '2026-11-06T10:00:00Z'],
    ['a long hexadecimal value', 'ab'.repeat(32)],
    ['a URL', 'https://localhost:8443/o/x'],
  ])('refuses %s, however deep it is', (what, value) => {
    expect(identifiersIn({ a: [{ b: value }] })[0]).toContain(what);
    expect(identifiersIn({ [value]: 1 })[0]).toContain(what);
  });

  it('allows statuses, codes, counts and flags', () => {
    expect(
      identifiersIn({ status: 'done', code: 'INVALID_INPUT', effects: 1, sent: false, none: null }),
    ).toEqual([]);
  });

  it('compares by content, whatever order the keys came in', () => {
    expect(canonicalObservation({ a: 1, b: [2, { c: 3, d: 4 }] })).toBe(
      canonicalObservation({ b: [2, { d: 4, c: 3 }], a: 1 }),
    );
  });

  it('keeps list order, because a different order of states is different behaviour', () => {
    expect(canonicalObservation(['open', 'done'])).not.toBe(canonicalObservation(['done', 'open']));
  });
});

describe('what the gate prints', () => {
  it('says not proven in words, with each reason', () => {
    const text = describeOutcome(compareReports([report('cloud')], CATALOG));
    expect(text).toMatch(/^NOT PROVEN/);
    expect(text).toContain('missing_report');
  });
});

describe('what the gate imports', () => {
  it('loads in plain Node with its types stripped, as the gate loads it', () => {
    // The gate needs Docker, so this is the one part of starting it that a unit test can prove.
    const output = execFileSync(
      'node',
      [
        '--input-type=module',
        '-e',
        `const { compareReports, describeOutcome } = await import('./tests/parity/rules.ts');
         const { PARITY_CATALOG } = await import('./tests/parity/catalog.ts');
         console.log(describeOutcome(compareReports([], PARITY_CATALOG)).split('\\n')[0]);`,
      ],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    expect(output).toMatch(/^NOT PROVEN/);
  });
});

describe('the catalog', () => {
  const csv = (path: string) => readDoc(path).split('\n').slice(1);
  const ids = (path: string) => new Set(csv(path).map((line) => line.split(',')[0]));
  const tickets = ids('docs/specifications/implementation-backlog.csv');
  const qa = ids('docs/specifications/qa-scenarios.csv');

  it('uses the same modes as the product', () => {
    expect([...COMMERCIAL_MODES]).toEqual([...commercialModes]);
  });

  it('has each scenario once', () => {
    const all = PARITY_CATALOG.map((spec) => spec.id);
    expect(new Set(all).size).toBe(all.length);
  });

  it.each(PARITY_CATALOG.map((spec) => [spec.id, spec] as const))(
    '%s is well formed',
    (_, spec) => {
      expect(spec.modes.length).toBeGreaterThan(0);
      expect(['work', 'boundary', 'modes']).toContain(spec.file);
      expect(spec.tickets.length).toBeGreaterThan(0);
      for (const ticket of spec.tickets) expect(tickets).toContain(ticket);
      for (const row of spec.qa) expect(qa).toContain(row);
      if (spec.kind === 'mode_contract') {
        expect(Object.keys(MODE_CONTRACT)).toContain(spec.dimension);
      } else {
        expect(spec.dimension).toBeUndefined();
      }
    },
  );

  it('holds core Work Unit semantics to all three modes', () => {
    const work = PARITY_CATALOG.filter((spec) => spec.file === 'work');
    expect(work.length).toBeGreaterThan(0);
    for (const spec of work) {
      expect(spec.kind).toBe('shared');
      expect(spec.modes).toEqual(COMMERCIAL_MODES);
    }
  });

  it('has a scenario for every row of the QA sheet that names a mode difference', () => {
    const covered = new Set(PARITY_CATALOG.flatMap((spec) => spec.qa));
    for (const row of ['QA-009', 'QA-020', 'QA-021', 'QA-022', 'QA-026', 'QA-027']) {
      expect(covered).toContain(row);
    }
  });
});

describe('the mode contract', () => {
  it.each(Object.entries(MODE_CONTRACT))('%s comes from a row in the docs', (_, dimension) => {
    expect(ALLOWED_DIFFERENCES).toContain(dimension.allowedAs);
    expect(readDoc(dimension.source.doc)).toContain(`| ${dimension.source.row} |`);
  });

  it('holds no price, allowance or service level', () => {
    const expected = Object.values(MODE_CONTRACT).map((dimension) => dimension.expected);
    expect(JSON.stringify(expected)).not.toMatch(/\d/);
  });
});
