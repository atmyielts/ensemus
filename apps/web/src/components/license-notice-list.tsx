import type { LicenseNotice, LicenseStanding, SupportStatus } from '@ensemus/domain/license';
import type { TrustRootState } from '@/server/sovereign-runtime';

// What the license page says. Each sentence is what is true: a lapse is a support status, a test key is a
// test key, and a missing file is a missing file. Nothing here says what this deployment's network looks like,
// and a test reads these sources to hold that. Every code has words, or this does not typecheck.

export const STANDING_WORDS: Record<LicenseStanding, string> = {
  licensed: 'A license is installed, and its signature checks out against this deployment.',
  unlicensed: 'No license is installed for this organization.',
  unverifiable: 'A license is installed here, and it could not be checked.',
};

export const SUPPORT_WORDS: Record<SupportStatus, string> = {
  no_agreement: 'No maintenance agreement is installed.',
  not_started: 'The maintenance agreement installed here has not started yet.',
  active: 'Maintenance is active.',
  lapsed:
    'Maintenance has lapsed. This is a support status, and the software keeps running as it does today.',
};

const NOTICE_WORDS: Record<LicenseNotice, string> = {
  no_license:
    'No license is installed for this organization. The software keeps running without one.',
  license_unverifiable:
    'A license is installed, and it could not be checked against this deployment. The software keeps running, and only what this page can tell you changes.',
  no_maintenance: 'No maintenance agreement is installed. The license stands without one.',
  maintenance_lapsed:
    'Maintenance has lapsed. This changes your support status, and the software keeps running as it does today.',
  maintenance_not_started:
    'Your maintenance agreement starts later. Until then this page shows no active maintenance.',
  pilot_review_due:
    'This is a pilot license, and its review date has arrived. That date is for people to talk, and nothing stops because of it.',
  signed_with_test_key:
    'Something shown on this page was signed with a generated test key. It is for rehearsal, and nobody was issued it.',
  signed_with_retired_key:
    'This document was signed with a key that has since been retired. It stays good, because it was issued while that key was in use.',
  clock_before_issue:
    "This machine's clock reads earlier than the license's issue date, so the dates on this page may be wrong. Nothing stops because of it.",
  running_release_outside_rights:
    'The release running here is outside the update rights in this license. It keeps running. This only matters when choosing what to install next.',
  seats_above_footprint:
    'More people are using this organization than the seat count this license states. This is shown for your records, and nothing is limited because of it.',
};

const WARNING_NOTICES: ReadonlySet<LicenseNotice> = new Set<LicenseNotice>([
  'no_license',
  'license_unverifiable',
  'maintenance_lapsed',
  'pilot_review_due',
  'clock_before_issue',
  'running_release_outside_rights',
  'seats_above_footprint',
]);

/** Everything an administrator is told. A notice informs, so these are `status`, and never an alert. */
export function LicenseNoticeList({ notices }: { notices: readonly LicenseNotice[] }) {
  // The test key says so at the top of the page, on its own, so it is not said twice.
  const shown = notices.filter((notice) => notice !== 'signed_with_test_key');
  if (shown.length === 0) return null;
  return (
    <div role="status">
      {shown.map((notice) => (
        <p
          key={notice}
          className={WARNING_NOTICES.has(notice) ? 'notice warn' : 'notice'}
          data-notice={notice}
        >
          {NOTICE_WORDS[notice]}
        </p>
      ))}
    </div>
  );
}

/** Said at the very top of the page, before anything a test key has signed can be read as real. */
export function LicenseTestKeyBanner() {
  return (
    <p className="notice warn" role="status" data-notice="signed_with_test_key">
      <strong>Test key.</strong> {NOTICE_WORDS.signed_with_test_key}
    </p>
  );
}

const TRUST_ROOT_WORDS: Record<Exclude<TrustRootState, 'loaded'>, string> = {
  not_configured:
    'This deployment has no trust root set, so signed documents cannot be checked or installed. The software keeps running. Your operator sets ENSEMUS_LICENSE_TRUST_ROOT_FILE to the file delivered with your contract, and restarts the web service.',
  unreadable:
    'The trust root this deployment names could not be read, so signed documents cannot be checked or installed. The software keeps running. Your operator can check the file set in ENSEMUS_LICENSE_TRUST_ROOT_FILE, and restart the web service.',
};

export function LicenseTrustRootNotice({ state }: { state: TrustRootState }) {
  if (state === 'loaded') return null;
  return (
    <p className="notice warn" role="status" data-trust-root={state}>
      {TRUST_ROOT_WORDS[state]}
    </p>
  );
}
