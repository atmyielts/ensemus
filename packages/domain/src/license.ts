// What a Sovereign license says and what follows from it (COMM-03, SOV-02, SOV-05, ADR-030). Pure, so the
// web tier, the operator commands and the standalone bundle tools all reach the same answer.
//
// The rule this module exists to hold: nothing here can stop purchased software from running. There is no
// function that answers "may this run", and no type with a field for it, because the answer is always
// yes (docs/07-commercial/03-data-portability-and-exit.md section 7). What a lapse, a wrong clock or a bad
// file can change is a status shown to an administrator and a warning on the next upgrade.

/** A calendar day, YYYY-MM-DD, in UTC. Maintenance dates are days, so no clock skew can move one by much. */
export type DateOnly = string;

/**
 * What the holder of a license may install later. Each value is the owner's decision (ADR-030 D5), written
 * into the license at issue as data, so that no code here chooses. A later signed support policy can only
 * add to this, never take away, so issuing the narrow value now can be widened with no new license.
 */
export type UpdateRights = {
  /** Security patches once maintenance has lapsed. `licensed_line` means the line of the licensed release. */
  security_patches_after_lapse: 'none' | 'licensed_line';
  /** Whether maintenance reaches a new major version, or that takes a separate purchase. */
  major_versions_with_maintenance: 'included' | 'separate_purchase';
  /** Whether a release published while maintained can still be installed after the lapse. */
  releases_published_during_maintenance: 'kept_after_lapse' | 'not_kept';
  /**
   * What the install tool does with a bundle these rights do not cover. It only ever affects a new install,
   * never the version already running. `warn` asks the operator to confirm, and keeps a record.
   */
  outside_rights_on_install: 'warn' | 'refuse';
};

export type LicenseTerm =
  | { kind: 'perpetual' }
  /** A pilot's end date is a date for people to talk. It shows as a notice and disables nothing. */
  | { kind: 'pilot'; review_on: DateOnly };

/** Capacity bands from the contract. Null means the license does not state one. Shown, never enforced. */
export type LicenseFootprint = {
  organizations: number | null;
  seats: number | null;
  production_deployments: number | null;
  nonproduction_deployments: number | null;
};

export type LicensedRelease = { line: string; version: string };

/** The signed license. It has no expiry field, and no machine or network binding, on purpose (ADR-030 D2). */
export type LicenseDocument = {
  format: 'ensemus.license';
  format_version: 1;
  license_id: string;
  issued_at: string;
  /** Shown to the customer's administrator. A contract reference, and never contract text. */
  licensee: { display_name: string; contract_reference: string };
  edition: 'sovereign';
  term: LicenseTerm;
  licensed_release: LicensedRelease;
  footprint: LicenseFootprint;
  components: readonly string[];
  update_rights: UpdateRights;
};

/** A signed statement that maintenance runs for a period. Renewing adds one, and changes no license. */
export type MaintenanceDocument = {
  format: 'ensemus.maintenance';
  format_version: 1;
  maintenance_id: string;
  license_id: string;
  issued_at: string;
  starts_on: DateOnly;
  /** The last day covered. */
  ends_on: DateOnly;
};

export const ADVISORY_SEVERITIES = ['low', 'moderate', 'high', 'critical'] as const;
export type AdvisorySeverity = (typeof ADVISORY_SEVERITIES)[number];

/** A signed security notice (SOV-04). The words come from whoever issues it, and are shown as text. */
export type AdvisoryDocument = {
  format: 'ensemus.advisory';
  format_version: 1;
  advisory_id: string;
  issued_at: string;
  severity: AdvisorySeverity;
  title: string;
  summary: string;
  affected_versions: readonly string[];
  fixed_in_versions: readonly string[];
};

export const BRANCH_STATUSES = ['supported', 'security_only', 'end_of_support'] as const;
export type BranchStatus = (typeof BRANCH_STATUSES)[number];

/** The published policy (SOV-05), signed and shipped with each bundle. Every value is the owner's. */
export type SupportPolicyDocument = {
  format: 'ensemus.support_policy';
  format_version: 1;
  policy_id: string;
  issued_at: string;
  branches: readonly { line: string; status: BranchStatus }[];
  /** Adds to what any license grants. It has no way to subtract. */
  security_patches_after_lapse_grant: 'none' | 'licensed_line' | 'any_supported_line';
};

export type ReleaseFacts = {
  version: string;
  line: string;
  kind: 'major' | 'minor' | 'patch';
  security: boolean;
  /** From the signed bundle manifest, not this machine's clock. */
  published_on: DateOnly;
};

/** Numeric major.minor.patch only. Anything else in a signed document is refused when it is parsed. */
const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const isReleaseVersion = (value: string) => VERSION.test(value);
export const isDateOnly = (value: string) =>
  DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

/** Negative if `a` is older than `b`, zero if the same, positive if newer. Throws on anything else. */
export function compareReleaseVersions(a: string, b: string): number {
  const parts = (value: string) => {
    const match = VERSION.exec(value);
    if (!match) throw new Error('Not a release version');
    return [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  };
  const [left, right] = [parts(a), parts(b)];
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

/** Today in UTC. Used for what is shown, and never for what is allowed to run. */
export const dayOf = (now: Date): DateOnly => now.toISOString().slice(0, 10);

export type SupportStatus = 'no_agreement' | 'not_started' | 'active' | 'lapsed';

export type MaintenanceView = {
  status: SupportStatus;
  /** The latest day any agreement covers, shown so a person can see what the status rests on. */
  lastCoveredOn: DateOnly | null;
};

/** SOV-02. Dates are compared as days. A wrong clock changes this status and nothing else. */
export function maintenanceStatus(
  agreements: readonly Pick<MaintenanceDocument, 'starts_on' | 'ends_on'>[],
  today: DateOnly,
): MaintenanceView {
  if (agreements.length === 0) return { status: 'no_agreement', lastCoveredOn: null };
  const lastCoveredOn = agreements.reduce(
    (latest, agreement) => (agreement.ends_on > latest ? agreement.ends_on : latest),
    agreements[0]?.ends_on as DateOnly,
  );
  if (agreements.some(({ starts_on, ends_on }) => starts_on <= today && today <= ends_on)) {
    return { status: 'active', lastCoveredOn };
  }
  return { status: today > lastCoveredOn ? 'lapsed' : 'not_started', lastCoveredOn };
}

export type UpdateRightBasis =
  'licensed_release' | 'maintenance' | 'security_after_lapse' | 'support_policy_grant';

export type UpdateRightVerdict = {
  covered: boolean;
  basis: UpdateRightBasis | null;
  /** What the install tool does. `proceed` when covered, otherwise what the license says. */
  onInstall: 'proceed' | 'warn' | 'refuse';
};

/**
 * Whether a release is within what this customer bought (OPS-11, SOV-05). Coverage rests on signed dates:
 * whether the release was published inside a maintenance period, and not on today's date, except where
 * the license itself asks for that with `not_kept`. Moving a clock can therefore not grant a release.
 */
export function evaluateUpdateRight(input: {
  license: Pick<LicenseDocument, 'licensed_release' | 'update_rights'>;
  agreements: readonly Pick<MaintenanceDocument, 'starts_on' | 'ends_on'>[];
  policies: readonly Pick<
    SupportPolicyDocument,
    'branches' | 'security_patches_after_lapse_grant'
  >[];
  release: ReleaseFacts;
  today: DateOnly;
}): UpdateRightVerdict {
  const { license, agreements, policies, release, today } = input;
  const rights = license.update_rights;
  const covered = (basis: UpdateRightBasis): UpdateRightVerdict => ({
    covered: true,
    basis,
    onInstall: 'proceed',
  });

  // What was bought, or anything older. Going back to it is always within the license.
  if (compareReleaseVersions(release.version, license.licensed_release.version) <= 0) {
    return covered('licensed_release');
  }

  const newMajor =
    Number(release.version.split('.')[0]) > Number(license.licensed_release.version.split('.')[0]);
  const maintenanceReaches = !newMajor || rights.major_versions_with_maintenance === 'included';
  if (maintenanceReaches) {
    const during = agreements.filter(
      ({ starts_on, ends_on }) =>
        starts_on <= release.published_on && release.published_on <= ends_on,
    );
    const kept =
      rights.releases_published_during_maintenance === 'kept_after_lapse'
        ? during.length > 0
        : during.some(({ ends_on }) => today <= ends_on);
    if (kept) return covered('maintenance');
  }

  if (release.security) {
    const sameLine = release.line === license.licensed_release.line;
    if (rights.security_patches_after_lapse === 'licensed_line' && sameLine) {
      return covered('security_after_lapse');
    }
    for (const policy of policies) {
      const grant = policy.security_patches_after_lapse_grant;
      if (grant === 'licensed_line' && sameLine) return covered('support_policy_grant');
      if (
        grant === 'any_supported_line' &&
        !newMajor &&
        policy.branches.some(
          ({ line, status }) => line === release.line && status !== 'end_of_support',
        )
      ) {
        return covered('support_policy_grant');
      }
    }
  }

  return { covered: false, basis: null, onInstall: rights.outside_rights_on_install };
}

export type LicenseStanding =
  /** A license is installed and its signature checks out against this deployment's trust root. */
  | 'licensed'
  /** Nothing is installed yet. */
  | 'unlicensed'
  /** Something is installed and could not be checked, for instance the trust root is missing. */
  | 'unverifiable';

export const LICENSE_NOTICES = [
  'no_license',
  'license_unverifiable',
  'no_maintenance',
  'maintenance_lapsed',
  'maintenance_not_started',
  'pilot_review_due',
  'signed_with_test_key',
  'signed_with_retired_key',
  'clock_before_issue',
  'running_release_outside_rights',
  'seats_above_footprint',
] as const;
export type LicenseNotice = (typeof LICENSE_NOTICES)[number];

/**
 * What an administrator is told. Notices are the only output, on purpose: nothing downstream has anything
 * it could use to refuse a request. Ordered, so a page and a test see the same thing.
 */
export function licenseNotices(input: {
  standing: LicenseStanding;
  license: Pick<LicenseDocument, 'term' | 'issued_at' | 'footprint'> | null;
  maintenance: MaintenanceView;
  today: DateOnly;
  signedWithTestKey: boolean;
  signedWithRetiredKey: boolean;
  runningReleaseCovered: boolean | null;
  seatsInUse: number | null;
}): readonly LicenseNotice[] {
  const notices: LicenseNotice[] = [];
  if (input.standing === 'unlicensed') notices.push('no_license');
  if (input.standing === 'unverifiable') notices.push('license_unverifiable');
  if (input.license) {
    if (input.maintenance.status === 'no_agreement') notices.push('no_maintenance');
    if (input.maintenance.status === 'lapsed') notices.push('maintenance_lapsed');
    if (input.maintenance.status === 'not_started') notices.push('maintenance_not_started');
    const { term, issued_at: issuedAt, footprint } = input.license;
    if (term.kind === 'pilot' && term.review_on <= input.today) notices.push('pilot_review_due');
    if (input.signedWithTestKey) notices.push('signed_with_test_key');
    if (input.signedWithRetiredKey) notices.push('signed_with_retired_key');
    // A machine with a dead battery. Noted, because the status above may be wrong, and nothing more.
    if (input.today < issuedAt.slice(0, 10)) notices.push('clock_before_issue');
    if (input.runningReleaseCovered === false) notices.push('running_release_outside_rights');
    if (
      footprint.seats !== null &&
      input.seatsInUse !== null &&
      input.seatsInUse > footprint.seats
    ) {
      notices.push('seats_above_footprint');
    }
  }
  return notices;
}
