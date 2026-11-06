// What the image scan decides (ADR-037 D2), apart from the Docker it runs on, so that a unit test can
// check each decision. See tests/unit/scan-rules.test.ts. The policy is a risk decision and it is the
// owner's: it lives here, and not in Grype's --fail-on, so that there is one tested place to change it.

// Both lists are closed on purpose. Grype spelling a severity or a fix state some new way must be
// reported, because the alternative is reading it as "not critical" or "no fix" and passing quietly.
const SEVERITIES = new Set(['Critical', 'High', 'Medium', 'Low', 'Negligible', 'Unknown']);
const FIX_STATES = new Set(['fixed', 'not-fixed', 'wont-fix', 'unknown', '']);

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';
const keyOf = (id, name) => JSON.stringify([id, name]);

/** Why this cannot be Grype's report. Finding nothing proves nothing unless Grype is what said so. */
function reportProblems(report) {
  if (!isRecord(report)) return ['the report is not a Grype report'];
  const { descriptor, matches } = report;
  const problems = [];
  if (!isRecord(descriptor) || descriptor.name !== 'grype' || !isText(descriptor.version)) {
    problems.push('the report has no descriptor from Grype, so the tool may not have run properly');
  }
  if (!Array.isArray(matches)) problems.push('the report has no list of matches');
  return problems;
}

/** A Finding, or the reason this match cannot be judged. One unreadable match does not hide the rest. */
function readMatch(match, index) {
  const vulnerability = isRecord(match) ? match.vulnerability : undefined;
  const artifact = isRecord(match) ? match.artifact : undefined;
  const fix = isRecord(vulnerability) ? vulnerability.fix : undefined;
  if (
    !isRecord(vulnerability) ||
    !isRecord(artifact) ||
    !isRecord(fix) ||
    !isText(vulnerability.id) ||
    !isText(artifact.name) ||
    typeof artifact.version !== 'string' ||
    !Array.isArray(fix.versions)
  ) {
    return { problem: `match ${index} is not in Grype's shape` };
  }
  const { id, severity } = vulnerability;
  if (!SEVERITIES.has(severity)) {
    return { problem: `${id} has a severity this policy does not know: ${String(severity)}` };
  }
  if (!FIX_STATES.has(fix.state)) {
    return { problem: `${id} has a fix state this policy does not know: ${String(fix.state)}` };
  }
  return {
    finding: {
      id,
      severity,
      package: artifact.name,
      version: artifact.version,
      fixedIn: fix.versions,
    },
    fixed: fix.state === 'fixed',
  };
}

// An exception is good until the start of the day it names, in UTC. Earlier rather than later, and the
// same on every machine. Only a real calendar date counts, because Date.parse accepts almost anything,
// including '1', and rolls 2026-02-31 over into March.
function expiryOf(expires) {
  if (typeof expires !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(expires)) return null;
  const date = new Date(`${expires}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(expires) ? date : null;
}

function readExceptions(exceptions, now) {
  if (!isRecord(exceptions) || !Array.isArray(exceptions.exceptions)) {
    return {
      usable: new Map(),
      problems: ['the exceptions file does not hold a list called exceptions'],
    };
  }
  const usable = new Map();
  const seen = new Set();
  const problems = [];
  exceptions.exceptions.forEach((entry, index) => {
    const name = isRecord(entry) && isText(entry.id) ? entry.id : `entry ${index}`;
    if (!isRecord(entry)) {
      problems.push(`exception ${name} is not an object`);
      return;
    }
    const missing = ['id', 'package', 'reason', 'expires'].filter((field) => !isText(entry[field]));
    if (missing.length > 0) {
      problems.push(`exception ${name} is missing ${missing.join(', ')}`);
      return;
    }
    const key = keyOf(entry.id, entry.package);
    if (seen.has(key)) {
      problems.push(`exception ${name} for ${entry.package} is listed twice`);
      return;
    }
    seen.add(key);
    const expiry = expiryOf(entry.expires);
    if (expiry === null) {
      problems.push(`exception ${name} for ${entry.package}: expires is not a YYYY-MM-DD date`);
    } else if (now.getTime() >= expiry.getTime()) {
      problems.push(`exception ${name} for ${entry.package} expired on ${entry.expires}`);
    } else {
      usable.set(key, entry);
    }
  });
  return { usable, problems };
}

/** What is wrong with the exceptions file, apart from whether anything matches it. */
export function exceptionProblems(exceptions, now) {
  return readExceptions(exceptions, now).problems;
}

/**
 * The verdict on each image, with one exceptions file across all of them. `images` is keyed by name,
 * each `{ report, problems? }`, and `problems` holds what stopped a report being made at all. An exception
 * for a package only one image has must not read as unused on the other, which is why an exception is
 * only called unused here, across all of them, and only when every report could be read.
 */
export function evaluateScans(images, exceptions, now) {
  const { usable, problems: fileProblems } = readExceptions(exceptions, now);
  const matched = new Set();
  const verdicts = {};
  for (const [name, { report, problems: earlier = [] }] of Object.entries(images)) {
    const problems = [...earlier];
    const failing = [];
    const listed = [];
    if (report !== null || earlier.length === 0) problems.push(...reportProblems(report));
    const matches = isRecord(report) && Array.isArray(report.matches) ? report.matches : [];
    matches.forEach((match, index) => {
      const { finding, fixed, problem } = readMatch(match, index);
      if (problem) {
        problems.push(problem);
        return;
      }
      const key = keyOf(finding.id, finding.package);
      if (usable.has(key)) matched.add(key);
      const fails = finding.severity === 'Critical' || (finding.severity === 'High' && fixed);
      (fails && !usable.has(key) ? failing : listed).push(finding);
    });
    verdicts[name] = { failing, listed, problems };
  }
  const everyReportRead = Object.values(verdicts).every(({ problems }) => problems.length === 0);
  const unused = everyReportRead
    ? [...usable]
        .filter(([key]) => !matched.has(key))
        .map(([, { id, package: name }]) => `exception ${id} for ${name} matches nothing`)
    : [];
  return { images: verdicts, problems: [...fileProblems, ...unused] };
}

/** The verdict on one report. `failing` and `listed` hold Findings, and any problem fails the scan. */
export function evaluateScan(report, exceptions, now) {
  const { images, problems } = evaluateScans({ image: { report } }, exceptions, now);
  return { ...images.image, problems: [...images.image.problems, ...problems] };
}

/** Grype given an empty SBOM finds nothing and exits 0, so an SBOM that lists nothing is a problem. */
export function sbomProblems(name, text) {
  let sbom;
  try {
    sbom = JSON.parse(text);
  } catch {
    return [`the SBOM for ${name} is not JSON`];
  }
  if (!isRecord(sbom) || !Array.isArray(sbom.packages) || sbom.packages.length === 0) {
    return [`the SBOM for ${name} lists no packages, so a scan of it would prove nothing`];
  }
  return [];
}

/**
 * What a run of Grype produced, from spawnSync's result. A report from a run that exited non-zero is
 * not believed. Neither is one that names no distribution: both images are Debian, and without one
 * their OS packages go unmatched, and the result looks clean.
 */
export function readGrypeRun(name, { error, status, stdout, stderr }) {
  if (error) return { report: null, problems: [`Grype did not run for ${name}: ${error.message}`] };
  if (status !== 0) {
    const said = (stderr ?? '').slice(-500);
    return { report: null, problems: [`Grype exited ${String(status)} for ${name}: ${said}`] };
  }
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    return { report: null, problems: [`Grype wrote no JSON for ${name}`] };
  }
  const distro = isRecord(report) ? report.distro : undefined;
  if (isRecord(report) && !(isRecord(distro) && isText(distro.name))) {
    return {
      report,
      problems: [
        `Grype recognised no Linux distribution for ${name}, so OS packages were not checked`,
      ],
    };
  }
  return { report, problems: [] };
}
