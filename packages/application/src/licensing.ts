// Owned by the license slice (COMM-03, SOV-02, SOV-05). See docs/06-delivery/m6-slices.md and ADR-030 D2.
// Installing and reading signed documents, per tenant, through row-level security. Nothing here is a gate:
// no request anywhere is refused because of what this returns (a test in tests/unit holds that).
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type {
  LicenseFootprint,
  LicenseNotice,
  LicenseStanding,
  LicenseTerm,
  LicensedRelease,
  MaintenanceView,
  ReleaseFacts,
  UpdateRightVerdict,
  UpdateRights,
} from '@ensemus/domain/license';
import type { AdvisorySeverity } from '@ensemus/domain/license';
import type { TrustRoot } from '@ensemus/sovereign/trust-root';

export type LicenseDeps = {
  /** Null where no trust root is configured, which is an answer: `unverifiable`, and never a crash. */
  trustRoot: TrustRoot | null;
  /** What this deployment is running, from its own bundle manifest. Null where that is not known. */
  runningRelease: ReleaseFacts | null;
  now?: () => Date;
};

export type InstalledDocument = {
  type: 'license' | 'maintenance' | 'advisory' | 'support_policy';
  id: string;
  /** False when this exact file was already installed. Installing is safe to repeat. */
  created: boolean;
  testKey: boolean;
};

export type LicenseView = {
  licenseId: string;
  licensee: { displayName: string; contractReference: string };
  term: LicenseTerm;
  licensedRelease: LicensedRelease;
  footprint: LicenseFootprint;
  components: readonly string[];
  updateRights: UpdateRights;
  issuedAt: Date;
  keyIds: readonly string[];
  testKey: boolean;
  retiredKey: boolean;
};

export type LicenseStatusView = {
  standing: LicenseStanding;
  license: LicenseView | null;
  maintenance: MaintenanceView;
  runningRelease: { version: string; verdict: UpdateRightVerdict | null } | null;
  seatsInUse: number;
  notices: readonly LicenseNotice[];
};

export type AdvisoryView = {
  advisoryId: string;
  severity: AdvisorySeverity;
  title: string;
  summary: string;
  affectedVersions: readonly string[];
  fixedInVersions: readonly string[];
  issuedAt: Date;
  /** Whether the running release is one the advisory names. Null where the running release is not known. */
  affectsThisRelease: boolean | null;
  testKey: boolean;
};

/**
 * Checks a signed file and stores it as delivered, whichever kind it is, working that out from its payload
 * type. Needs `license.manage`, or a service context from an operator's command. Refuses anything that does
 * not verify, with `LICENSE_NOT_VALID`, and stores nothing. Writes `auditAction` and `emit`
 * (`LICENSE_DOCUMENT_INSTALLED`) in the same transaction. A maintenance statement for a license not
 * installed here is refused the same way.
 */
export function installSignedDocument(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { envelope: string },
  _deps: Pick<LicenseDeps, 'trustRoot'>,
): Promise<InstalledDocument> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * What an administrator is shown. Needs `license.view`. Re-verifies every stored envelope against the trust
 * root as it reads it: the one with the latest `issued_at` that verifies is the license, rows that do not
 * verify are skipped and turn the standing to `unverifiable` only if none verifies, and every date comes
 * from a verified document, never from a column. Maintenance, policies and `evaluateUpdateRight` are
 * worked out here so that a page cannot get them wrong. This never throws for a bad document.
 */
export function getLicenseStatus(
  _database: AppDatabase,
  _context: TenantContext,
  _deps: LicenseDeps,
): Promise<LicenseStatusView> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Advisories that verify, newest first. Needs `license.view`. Reading one changes nothing. */
export function listAdvisories(
  _database: AppDatabase,
  _context: TenantContext,
  _deps: LicenseDeps,
): Promise<readonly AdvisoryView[]> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * The facts a later entitlement check may use (M8, `docs/07-commercial/02-entitlements-and-billing.md`
 * section 6). A narrow read with no permission check, since nothing it returns is shown by itself, and with
 * no way to say "stop": where nothing verifies it answers null, and a Sovereign deployment keeps running.
 */
export function readVerifiedLicenseFacts(
  _database: AppDatabase,
  _context: TenantContext,
  _deps: Pick<LicenseDeps, 'trustRoot'>,
): Promise<{
  licenseId: string;
  components: readonly string[];
  footprint: LicenseFootprint;
} | null> {
  throw new Error('NOT_IMPLEMENTED');
}
