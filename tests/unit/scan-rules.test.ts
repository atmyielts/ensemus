// FOUND-01, ADR-037 D2: what the image scan decides. The scan needs Docker and a vulnerability database
// and has never run, so these are the decisions that make it fail, on a hand-written report whose IDs
// are made up. Nothing here says what Grype will find in the real images.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  evaluateScan,
  evaluateScans,
  exceptionProblems,
  readGrypeRun,
  sbomProblems,
} from '../../infrastructure/scripts/scan-rules.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'grype-report.json'), 'utf8')) as {
  matches: unknown[];
  descriptor: unknown;
};
const repositoryFile = (...path: string[]) => join(here, '..', '..', ...path);

const NOW = new Date('2026-11-06T12:00:00Z');
const NONE = { exceptions: [] };
const ids = (findings: { id: string; package: string }[]) =>
  findings.map((finding) => `${finding.id} ${finding.package}`);

const report = (...matches: unknown[]) => ({ ...fixture, matches });
const match = (id: string, severity: string, state: string, name = 'pkg', versions: string[] = []) => ({
  vulnerability: { id, severity, fix: { versions, state } },
  artifact: { name, version: '1.0.0', type: 'npm' },
});
const exception = (fields: Record<string, unknown> = {}) => ({
  id: 'CVE-0000-0002',
  package: 'pkg-high-fixed',
  reason: 'A test reason.',
  expires: '2026-12-01',
  ...fields,
});

describe('the policy', () => {
  it('fails a critical with no fix', () => {
    const { failing, listed } = evaluateScan(
      report(match('CVE-0000-0001', 'Critical', 'not-fixed')),
      NONE,
      NOW,
    );
    expect(ids(failing)).toEqual(['CVE-0000-0001 pkg']);
    expect(listed).toEqual([]);
  });

  it('fails a critical whatever its fix state says', () => {
    for (const state of ['fixed', 'wont-fix', 'unknown', '']) {
      const { failing } = evaluateScan(report(match('CVE-0000-0001', 'Critical', state)), NONE, NOW);
      expect(ids(failing)).toEqual(['CVE-0000-0001 pkg']);
    }
  });

  it('fails a high with a fix', () => {
    const { failing, listed } = evaluateScan(
      report(match('CVE-0000-0002', 'High', 'fixed')),
      NONE,
      NOW,
    );
    expect(ids(failing)).toEqual(['CVE-0000-0002 pkg']);
    expect(listed).toEqual([]);
  });

  it('lists a high with no fix', () => {
    for (const state of ['not-fixed', 'wont-fix', 'unknown', '']) {
      const { failing, listed } = evaluateScan(report(match('CVE-0000-0003', 'High', state)), NONE, NOW);
      expect(failing).toEqual([]);
      expect(ids(listed)).toEqual(['CVE-0000-0003 pkg']);
    }
  });

  it('lists a medium and everything below, even with a fix', () => {
    for (const severity of ['Medium', 'Low', 'Negligible', 'Unknown']) {
      const { failing, listed } = evaluateScan(report(match('CVE-0000-0004', severity, 'fixed')), NONE, NOW);
      expect(failing).toEqual([]);
      expect(ids(listed)).toEqual(['CVE-0000-0004 pkg']);
    }
  });

  it('sorts the whole fixture, and gives each finding its full shape', () => {
    const { failing, listed, problems } = evaluateScan(fixture, NONE, NOW);
    expect(problems).toEqual([]);
    expect(ids(failing)).toEqual([
      'CVE-0000-0001 pkg-critical-nofix',
      'CVE-0000-0002 pkg-high-fixed',
      'CVE-0000-0005 pkg-shared-a',
      'CVE-0000-0005 pkg-shared-b',
    ]);
    expect(ids(listed)).toEqual(['CVE-0000-0003 pkg-high-nofix', 'CVE-0000-0004 pkg-medium']);
    expect(failing[1]).toEqual({
      id: 'CVE-0000-0002',
      severity: 'High',
      package: 'pkg-high-fixed',
      version: '2.0.0',
      fixedIn: ['2.0.1', '3.0.1'],
    });
  });
});

describe('an exception', () => {
  it('moves one finding from failing to listed, and says nothing is wrong', () => {
    const { failing, listed, problems } = evaluateScan(fixture, { exceptions: [exception()] }, NOW);
    expect(problems).toEqual([]);
    expect(ids(failing)).not.toContain('CVE-0000-0002 pkg-high-fixed');
    expect(ids(listed)).toContain('CVE-0000-0002 pkg-high-fixed');
    expect(failing).toHaveLength(3);
    expect(listed).toHaveLength(3);
  });

  it('does not move the same vulnerability in another package', () => {
    const { failing, listed, problems } = evaluateScan(
      fixture,
      { exceptions: [exception({ id: 'CVE-0000-0005', package: 'pkg-shared-a' })] },
      NOW,
    );
    expect(problems).toEqual([]);
    expect(ids(listed)).toContain('CVE-0000-0005 pkg-shared-a');
    expect(ids(failing)).toContain('CVE-0000-0005 pkg-shared-b');
    expect(ids(listed)).not.toContain('CVE-0000-0005 pkg-shared-b');
  });

  it('does not move another vulnerability in the same package', () => {
    const scan = report(
      match('CVE-0000-0006', 'Critical', 'fixed', 'pkg-one'),
      match('CVE-0000-0007', 'Critical', 'fixed', 'pkg-one'),
    );
    const { failing } = evaluateScan(
      scan,
      { exceptions: [exception({ id: 'CVE-0000-0006', package: 'pkg-one' })] },
      NOW,
    );
    expect(ids(failing)).toEqual(['CVE-0000-0007 pkg-one']);
  });

  it('is a problem once it has expired, and no longer moves anything', () => {
    const { failing, problems } = evaluateScan(
      fixture,
      { exceptions: [exception({ expires: '2026-11-01' })] },
      NOW,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/CVE-0000-0002.*expired/);
    expect(ids(failing)).toContain('CVE-0000-0002 pkg-high-fixed');
  });

  it('has expired from the start of the day it names, in UTC', () => {
    const expiring = { exceptions: [exception({ expires: '2026-11-06' })] };
    expect(exceptionProblems(expiring, new Date('2026-11-05T23:59:59Z'))).toEqual([]);
    expect(exceptionProblems(expiring, new Date('2026-11-06T00:00:00Z'))).toHaveLength(1);
  });

  it('is a problem if it matches nothing, so the list cannot rot', () => {
    const { problems } = evaluateScan(
      fixture,
      { exceptions: [exception({ id: 'CVE-0000-9999' })] },
      NOW,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/CVE-0000-9999.*matches nothing/);
  });

  it.each(['id', 'package', 'reason', 'expires'])('is a problem with no %s', (field) => {
    const missing = exception();
    delete (missing as Record<string, unknown>)[field];
    expect(exceptionProblems({ exceptions: [missing] }, NOW)).toEqual([
      expect.stringContaining(field),
    ]);
    const blank = exception({ [field]: '   ' });
    expect(exceptionProblems({ exceptions: [blank] }, NOW)).toEqual([
      expect.stringContaining(field),
    ]);
  });

  it('moves nothing while it is missing a field, so no package can mean every package', () => {
    const noPackage = exception({ id: 'CVE-0000-0005' });
    delete (noPackage as Record<string, unknown>).package;
    const { failing, problems } = evaluateScan(fixture, { exceptions: [noPackage] }, NOW);
    expect(ids(failing)).toContain('CVE-0000-0005 pkg-shared-a');
    expect(ids(failing)).toContain('CVE-0000-0005 pkg-shared-b');
    expect(problems).toHaveLength(1);
  });

  it('moves nothing with no reason, and is reported once and not also as unused', () => {
    const { failing, problems } = evaluateScan(
      fixture,
      { exceptions: [exception({ reason: '' })] },
      NOW,
    );
    expect(ids(failing)).toContain('CVE-0000-0002 pkg-high-fixed');
    expect(problems).toHaveLength(1);
    expect(problems[0]).not.toMatch(/matches nothing/);
  });

  it.each(['soon', '1', '2026-13-01', '2026-02-31', '01/12/2026', 20261201, null])(
    'is a problem with an expiry of %s, which is not a date anyone can check',
    (expires) => {
      expect(exceptionProblems({ exceptions: [exception({ expires })] }, NOW)).toEqual([
        expect.stringContaining('expires'),
      ]);
    },
  );

  it('is a problem if it is listed twice', () => {
    const problems = exceptionProblems({ exceptions: [exception(), exception()] }, NOW);
    expect(problems).toEqual([expect.stringContaining('twice')]);
  });

  it.each([[null], [undefined], ['text'], [[]], [{}], [{ exceptions: 'none' }], [{ exceptions: [1] }]])(
    'reads %j as a problem and never as no exceptions',
    (file) => {
      expect(exceptionProblems(file, NOW).length).toBeGreaterThan(0);
      expect(evaluateScan(report(), file, NOW).problems.length).toBeGreaterThan(0);
    },
  );

  it('the file that ships starts empty, and is valid', () => {
    const file = JSON.parse(
      readFileSync(repositoryFile('infrastructure/security/image-scan-exceptions.json'), 'utf8'),
    ) as unknown;
    expect(file).toEqual({ exceptions: [] });
    expect(exceptionProblems(file, NOW)).toEqual([]);
  });
});

describe('a report that cannot be trusted', () => {
  it('is a problem with no descriptor, even though it holds no findings', () => {
    const { failing, listed, problems } = evaluateScan({ matches: [] }, NONE, NOW);
    expect(failing).toEqual([]);
    expect(listed).toEqual([]);
    expect(problems).toEqual([expect.stringContaining('descriptor')]);
  });

  it('is a problem when the descriptor names another tool or no version', () => {
    for (const descriptor of [
      {},
      null,
      'grype',
      { name: 'not-grype', version: '1.0.0' },
      { name: 'grype' },
      { name: 'grype', version: '' },
    ]) {
      const { problems } = evaluateScan({ matches: [], descriptor }, NONE, NOW);
      expect(problems).toEqual([expect.stringContaining('descriptor')]);
    }
  });

  it.each([[null], [undefined], ['{}'], [[]], [7]])('is a problem when the report is %j', (scan) => {
    expect(evaluateScan(scan, NONE, NOW).problems.length).toBeGreaterThan(0);
  });

  it('is a problem when matches is absent or not a list', () => {
    const { descriptor } = fixture;
    for (const scan of [{ descriptor }, { descriptor, matches: null }, { descriptor, matches: {} }]) {
      const { problems } = evaluateScan(scan, NONE, NOW);
      expect(problems).toEqual([expect.stringContaining('matches')]);
    }
  });

  it('is a problem when a match is malformed, and the rest are still read', () => {
    const bad = [
      {},
      { vulnerability: {}, artifact: { name: 'pkg', version: '1.0.0' } },
      { vulnerability: { id: 'CVE-0000-0008', severity: 'High' }, artifact: { name: 'pkg', version: '1.0.0' } },
      match('CVE-0000-0008', 'High', 'fixed', ''),
      { ...match('CVE-0000-0008', 'High', 'fixed'), artifact: undefined },
      {
        vulnerability: { id: 'CVE-0000-0008', severity: 'High', fix: { state: 'fixed' } },
        artifact: { name: 'pkg', version: '1.0.0' },
      },
    ];
    for (const entry of bad) {
      const { failing, problems } = evaluateScan(
        report(entry, match('CVE-0000-0001', 'Critical', 'fixed')),
        NONE,
        NOW,
      );
      expect(problems).toHaveLength(1);
      expect(ids(failing)).toEqual(['CVE-0000-0001 pkg']);
    }
  });

  it('is a problem with a severity it does not know, which must not read as merely listed', () => {
    const { listed, problems } = evaluateScan(report(match('CVE-0000-0009', 'CRITICAL', 'fixed')), NONE, NOW);
    expect(listed).toEqual([]);
    expect(problems).toEqual([expect.stringContaining('CRITICAL')]);
  });

  it('is a problem with a fix state it does not know, which must not read as no fix', () => {
    const { listed, problems } = evaluateScan(report(match('CVE-0000-0010', 'High', 'Fixed')), NONE, NOW);
    expect(listed).toEqual([]);
    expect(problems).toEqual([expect.stringContaining('Fixed')]);
  });

  it('does not call an exception unused when the report could not be read', () => {
    const { problems } = evaluateScan({ matches: [] }, { exceptions: [exception()] }, NOW);
    expect(problems).toEqual([expect.stringContaining('descriptor')]);
  });

  it('still reports an expired exception when the report could not be read', () => {
    const { problems } = evaluateScan(
      { matches: [] },
      { exceptions: [exception({ expires: '2026-01-01' })] },
      NOW,
    );
    expect(problems).toHaveLength(2);
  });
});

describe('a clean report', () => {
  it('is clean with no matches and a valid descriptor', () => {
    expect(evaluateScan(report(), NONE, NOW)).toEqual({ failing: [], listed: [], problems: [] });
  });
});

describe('both images together', () => {
  const web = report(match('CVE-0000-0011', 'Critical', 'fixed', 'pkg-web'));
  const worker = report(match('CVE-0000-0012', 'Critical', 'fixed', 'pkg-worker'));
  const forWeb = { exceptions: [exception({ id: 'CVE-0000-0011', package: 'pkg-web' })] };

  it('does not call an exception unused because only one image has the package', () => {
    const { images, problems } = evaluateScans({ web: { report: web }, worker: { report: worker } }, forWeb, NOW);
    expect(problems).toEqual([]);
    expect(ids(images.web!.listed)).toEqual(['CVE-0000-0011 pkg-web']);
    expect(images.web!.failing).toEqual([]);
    expect(ids(images.worker!.failing)).toEqual(['CVE-0000-0012 pkg-worker']);
  });

  it('calls an exception unused when neither image has the package', () => {
    const { problems } = evaluateScans(
      { web: { report: report() }, worker: { report: report() } },
      forWeb,
      NOW,
    );
    expect(problems).toEqual([expect.stringContaining('matches nothing')]);
  });

  it('does not claim an exception is unused when one image was never scanned', () => {
    const { images, problems } = evaluateScans(
      { web: { report: report() }, worker: { report: null, problems: ['worker did not scan'] } },
      forWeb,
      NOW,
    );
    expect(problems).toEqual([]);
    expect(images.worker!.problems).toEqual(['worker did not scan']);
  });

  it('never reads an image with no report and no reason as clean', () => {
    const { images } = evaluateScans({ web: { report: null } }, NONE, NOW);
    expect(images.web!.problems.length).toBeGreaterThan(0);
  });
});

describe('the SBOM', () => {
  it('is fine with packages in it', () => {
    expect(sbomProblems('web', JSON.stringify({ packages: [{ name: 'pkg' }] }))).toEqual([]);
  });

  it.each([
    ['nothing was written', ''],
    ['it is not JSON', 'not json'],
    ['it has no list of packages', '{}'],
    ['the list is empty, and Grype would call that clean', '{"packages":[]}'],
  ])('is a problem when %s', (_case, text) => {
    expect(sbomProblems('web', text)).toEqual([expect.stringContaining('web')]);
  });
});

describe('what Grype answered', () => {
  const answered = (fields: object) => ({
    status: 0,
    stdout: JSON.stringify(fixture),
    stderr: '',
    ...fields,
  });
  const withDistro = (distro: unknown) => JSON.stringify({ ...fixture, distro });

  it('hands on a report from a run that worked', () => {
    const { report: read, problems } = readGrypeRun('web', {
      ...answered({ stdout: withDistro({ name: 'debian', version: '12' }) }),
    });
    expect(problems).toEqual([]);
    expect(read).toMatchObject({ descriptor: { name: 'grype' } });
  });

  it('is a problem when the tool could not start', () => {
    const { report: read, problems } = readGrypeRun('web', {
      status: null,
      stdout: '',
      stderr: '',
      error: new Error('spawn docker ENOENT'),
    });
    expect(read).toBeNull();
    expect(problems).toEqual([expect.stringContaining('ENOENT')]);
  });

  it('is a problem when it exits non-zero, even with a report on its output', () => {
    const { report: read, problems } = readGrypeRun(
      'web',
      answered({ status: 1, stderr: 'failed to load vulnerability db' }),
    );
    expect(read).toBeNull();
    expect(problems).toEqual([expect.stringContaining('failed to load vulnerability db')]);
  });

  it('is a problem when it was killed, which leaves no exit status', () => {
    expect(readGrypeRun('web', answered({ status: null })).problems.length).toBe(1);
  });

  it('is a problem when its output is not JSON, or is empty', () => {
    for (const stdout of ['', 'not json']) {
      const { report: read, problems } = readGrypeRun('web', answered({ stdout }));
      expect(read).toBeNull();
      expect(problems).toHaveLength(1);
    }
  });

  it('is a problem when it recognised no distribution, since OS packages then go unmatched', () => {
    for (const distro of [undefined, null, {}, { name: '', version: '' }]) {
      const { problems } = readGrypeRun('web', answered({ stdout: withDistro(distro) }));
      expect(problems).toEqual([expect.stringContaining('distribution')]);
    }
  });

  it('limits what it repeats of the tool’s own error output', () => {
    const { problems } = readGrypeRun('web', answered({ status: 1, stderr: 'x'.repeat(5000) }));
    expect(problems[0]!.length).toBeLessThan(1000);
  });
});
