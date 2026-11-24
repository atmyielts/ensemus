// COMM-06: what the mode parity gate decides, apart from the Docker it runs on, so that a unit test can
// check each decision (tests/unit/parity-rules.test.ts). The gate imports this file straight from Node
// with its types stripped, so it has no relative imports and only erasable syntax.
//
// Three verdicts, because "nothing failed" and "it was proven" are different claims:
//   proven      every scenario ran in every mode it applies to, passed, and shared ones behaved alike
//   not_proven  nothing contradicts parity, but something did not run, or ran somewhere that does not count
//   failed      something ran and contradicts parity

export const COMMERCIAL_MODES = ['cloud', 'byom', 'sovereign'] as const;
export type CommercialMode = (typeof COMMERCIAL_MODES)[number];

/** Plain data a scenario saw. It is compared across modes, and kept as release evidence. */
export type Observation =
  | string
  | number
  | boolean
  | null
  | readonly Observation[]
  | { readonly [key: string]: Observation };

export type ScenarioKind =
  /** One behaviour. Every listed mode must pass and must observe the same thing. */
  | 'shared'
  /** A difference the commercial contract allows, so each mode is held to its own expected result. */
  | 'mode_contract';

export interface ParityScenarioSpec {
  readonly id: string;
  readonly title: string;
  readonly kind: ScenarioKind;
  readonly modes: readonly CommercialMode[];
  /** The tests/parity/scenarios/<file>.parity.ts that implements it. */
  readonly file: string;
  /** Backlog tickets this scenario holds to. */
  readonly tickets: readonly string[];
  /** Rows of docs/specifications/qa-scenarios.csv it covers. */
  readonly qa: readonly string[];
  /** For a mode_contract scenario, the dimension of MODE_CONTRACT that allows the difference. */
  readonly dimension?: string;
}

export type ScenarioOutcome = 'pass' | 'fail' | 'blocked';

export interface ScenarioResult {
  readonly id: string;
  readonly outcome: ScenarioOutcome;
  readonly observed?: Observation;
  /** A blocked scenario names what it waited for, which is the seam and the tickets that own it. */
  readonly blockedBy?: string;
  readonly failure?: string;
}

export interface ModeReport {
  readonly schema: 1;
  readonly mode: CommercialMode;
  readonly commit: string;
  /** Uncommitted changes mean these results do not describe the commit they name. */
  readonly dirty: boolean;
  /** Image IDs of what really ran. One release runs in every mode (ADR-010). */
  readonly images: { readonly web: string; readonly worker: string };
  /** The Sovereign round only counts with outside names unreachable. */
  readonly network: 'open' | 'blackholed';
  readonly startedAt: string;
  readonly scenarios: readonly ScenarioResult[];
}

export type FindingKind =
  // These mean the run contradicts parity, or that its evidence cannot be trusted.
  | 'scenario_failed'
  | 'behaviour_differs'
  | 'no_observation'
  | 'identifier_in_observation'
  | 'different_commit'
  | 'different_images'
  | 'unknown_scenario'
  | 'wrong_mode'
  | 'duplicate_result'
  | 'duplicate_report'
  | 'empty_catalog'
  // These mean it was not shown either way.
  | 'missing_report'
  | 'missing_result'
  | 'scenario_blocked'
  | 'uncommitted_changes'
  | 'open_network';

const NOT_SHOWN: ReadonlySet<FindingKind> = new Set<FindingKind>([
  'missing_report',
  'missing_result',
  'scenario_blocked',
  'uncommitted_changes',
  'open_network',
]);

export interface ParityFinding {
  readonly kind: FindingKind;
  readonly detail: string;
  readonly scenario?: string;
  readonly mode?: CommercialMode;
}

export type ParityVerdict = 'proven' | 'not_proven' | 'failed';

export interface ParityOutcome {
  readonly verdict: ParityVerdict;
  readonly findings: readonly ParityFinding[];
  /** Results that passed, out of the results the catalog asks for. */
  readonly passed: number;
  readonly expected: number;
}

// Anything that identifies one run instead of describing a behaviour. A UUID in an observation would
// make two modes differ for no reason, and would put real identifiers into release evidence.
const IDENTIFIERS: readonly (readonly [string, RegExp])[] = [
  ['a UUID', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ['an email address', /[^\s@]+@[^\s@]+\.[^\s@]+/],
  ['a timestamp', /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/],
  ['a long hexadecimal value', /\b[0-9a-f]{32,}\b/i],
  ['a URL', /\bhttps?:\/\//i],
];

/** What in an observation stops it describing only a behaviour. Empty means it can be compared. */
export function identifiersIn(observed: Observation, path = '$'): string[] {
  if (typeof observed === 'string') {
    return IDENTIFIERS.filter(([, pattern]) => pattern.test(observed)).map(
      ([what]) => `${what} at ${path}`,
    );
  }
  if (observed === null || typeof observed !== 'object') return [];
  if (isList(observed)) {
    return observed.flatMap((item, index) => identifiersIn(item, `${path}[${index}]`));
  }
  return Object.entries(observed).flatMap(([key, value]) => [
    ...IDENTIFIERS.filter(([, pattern]) => pattern.test(key)).map(
      ([what]) => `${what} in the key at ${path}`,
    ),
    ...identifiersIn(value, `${path}.${key}`),
  ]);
}

const isList = (value: object): value is readonly Observation[] => Array.isArray(value);

/** One text for equal observations, whatever order their keys came in. List order is kept: it can matter. */
export function canonicalObservation(observed: Observation): string {
  if (observed === null || typeof observed !== 'object') return JSON.stringify(observed);
  if (isList(observed)) return `[${observed.map(canonicalObservation).join(',')}]`;
  const entries = Object.entries(observed).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([key, value]) => `${JSON.stringify(key)}:${canonicalObservation(value)}`)
    .join(',')}}`;
}

function checkRuns(reports: readonly ModeReport[], findings: ParityFinding[]) {
  const seen = new Set<CommercialMode>();
  for (const report of reports) {
    if (seen.has(report.mode)) {
      findings.push({
        kind: 'duplicate_report',
        mode: report.mode,
        detail: `There are two reports for ${report.mode}, and only one can be the result.`,
      });
    }
    seen.add(report.mode);
    if (report.dirty) {
      findings.push({
        kind: 'uncommitted_changes',
        mode: report.mode,
        detail: 'The tree had uncommitted changes, so this does not describe the commit it names.',
      });
    }
    if (report.mode === 'sovereign' && report.network !== 'blackholed') {
      findings.push({
        kind: 'open_network',
        mode: report.mode,
        detail: 'Sovereign ran with the outside network reachable, so this round does not count.',
      });
    }
  }
  for (const mode of COMMERCIAL_MODES) {
    if (!seen.has(mode)) {
      findings.push({ kind: 'missing_report', mode, detail: `No report for ${mode}.` });
    }
  }
  const commits = new Set(reports.map((report) => report.commit));
  if (commits.size > 1) {
    findings.push({
      kind: 'different_commit',
      detail: `The modes ran different commits: ${[...commits].sort().join(', ')}.`,
    });
  }
  // Same images, or this would only show that two builds agree. Modes differ by configuration alone.
  for (const image of ['web', 'worker'] as const) {
    const ids = new Set(reports.map((report) => report.images[image]));
    if (ids.size > 1) {
      findings.push({
        kind: 'different_images',
        detail: `The modes ran different ${image} images: ${[...ids].sort().join(', ')}.`,
      });
    }
  }
}

function checkResults(
  report: ModeReport,
  catalog: ReadonlyMap<string, ParityScenarioSpec>,
  findings: ParityFinding[],
): number {
  let passed = 0;
  const reported = new Set<string>();
  for (const result of report.scenarios) {
    const where = { scenario: result.id, mode: report.mode };
    const spec = catalog.get(result.id);
    if (!spec) {
      findings.push({
        kind: 'unknown_scenario',
        ...where,
        detail: `${result.id} is not in the catalog, so nothing says what it should prove.`,
      });
      continue;
    }
    if (reported.has(result.id)) {
      findings.push({
        kind: 'duplicate_result',
        ...where,
        detail: `${result.id} was reported twice for ${report.mode}.`,
      });
      continue;
    }
    reported.add(result.id);
    if (!spec.modes.includes(report.mode)) {
      findings.push({
        kind: 'wrong_mode',
        ...where,
        detail: `${result.id} does not apply to ${report.mode}, but it ran there.`,
      });
      continue;
    }
    if (result.outcome === 'fail') {
      findings.push({
        kind: 'scenario_failed',
        ...where,
        detail: result.failure ?? `${result.id} failed in ${report.mode}.`,
      });
      continue;
    }
    if (result.outcome === 'blocked') {
      findings.push({
        kind: 'scenario_blocked',
        ...where,
        detail: result.blockedBy ?? `${result.id} could not run in ${report.mode}.`,
      });
      continue;
    }
    // A pass with nothing to compare would make "they behaved alike" true by saying nothing.
    if (result.observed === undefined) {
      findings.push({
        kind: 'no_observation',
        ...where,
        detail: `${result.id} passed in ${report.mode} without saying what it saw.`,
      });
      continue;
    }
    const identifiers = identifiersIn(result.observed);
    if (identifiers.length > 0) {
      findings.push({
        kind: 'identifier_in_observation',
        ...where,
        detail: `${result.id} in ${report.mode} observed ${identifiers.join('; ')}.`,
      });
      continue;
    }
    passed += 1;
  }
  for (const spec of catalog.values()) {
    if (spec.modes.includes(report.mode) && !reported.has(spec.id)) {
      findings.push({
        kind: 'missing_result',
        scenario: spec.id,
        mode: report.mode,
        detail: `${spec.id} did not run in ${report.mode}.`,
      });
    }
  }
  return passed;
}

function checkSharedBehaviour(
  reports: readonly ModeReport[],
  catalog: ReadonlyMap<string, ParityScenarioSpec>,
  findings: ParityFinding[],
) {
  for (const spec of catalog.values()) {
    if (spec.kind !== 'shared') continue;
    const seen = reports.flatMap((report) => {
      const result = report.scenarios.find((candidate) => candidate.id === spec.id);
      if (!spec.modes.includes(report.mode)) return [];
      if (result?.outcome !== 'pass' || result.observed === undefined) return [];
      return [[report.mode, canonicalObservation(result.observed)] as const];
    });
    if (new Set(seen.map(([, text]) => text)).size > 1) {
      findings.push({
        kind: 'behaviour_differs',
        scenario: spec.id,
        detail: `${spec.id} behaved differently: ${seen
          .map(([mode, text]) => `${mode} saw ${text}`)
          .join('; ')}.`,
      });
    }
  }
}

/** The decision the gate reports. It reads reports only, and has no way to run or skip anything. */
export function compareReports(
  reports: readonly ModeReport[],
  specs: readonly ParityScenarioSpec[],
): ParityOutcome {
  const findings: ParityFinding[] = [];
  if (specs.length === 0) {
    findings.push({ kind: 'empty_catalog', detail: 'An empty catalog proves nothing.' });
  }
  const catalog = new Map(specs.map((spec) => [spec.id, spec]));
  checkRuns(reports, findings);
  let passed = 0;
  for (const report of reports) passed += checkResults(report, catalog, findings);
  checkSharedBehaviour(reports, catalog, findings);
  const expected = specs.reduce((total, spec) => total + spec.modes.length, 0);
  const contradicted = findings.some((finding) => !NOT_SHOWN.has(finding.kind));
  return {
    verdict: contradicted ? 'failed' : findings.length > 0 ? 'not_proven' : 'proven',
    findings,
    passed,
    expected,
  };
}

/** One readable block for the gate's log and the evidence file. */
export function describeOutcome(outcome: ParityOutcome): string {
  const words: Record<ParityVerdict, string> = {
    proven: 'PROVEN: every scenario ran and passed in every mode it applies to.',
    not_proven: 'NOT PROVEN: nothing contradicts parity, but it has not been shown.',
    failed: 'FAILED: the run contradicts parity.',
  };
  return [
    words[outcome.verdict],
    `${outcome.passed} of ${outcome.expected} results passed.`,
    ...outcome.findings.map((finding) => `- ${finding.kind}: ${finding.detail}`),
  ].join('\n');
}
