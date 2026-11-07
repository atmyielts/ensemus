// Owned by the license slice (COMM-03, SOV-02, SOV-05). See docs/06-delivery/m6-slices.md and ADR-030 D2.
// Installing and reading signed documents, per tenant, through row-level security. Nothing here is a gate:
// no request anywhere is refused because of what this returns (a test in tests/unit holds that).
//
// A row proves nothing. Its columns are for finding it, and every value in a view comes from an envelope
// checked against the trust root as it is read, so anything writing a row directly has only stored a file.
import { createHash } from 'node:crypto';
import type { AppDatabase, TenantContext } from '@ensemus/database';
import {
  appendAudit,
  licenseRecords,
  memberships,
  signedDocuments,
  withTenantTx,
  type Tx,
} from '@ensemus/database';
import {
  dayOf,
  evaluateUpdateRight,
  licenseNotices,
  maintenanceStatus,
  type LicenseFootprint,
  type LicenseNotice,
  type LicenseStanding,
  type LicenseTerm,
  type LicensedRelease,
  type MaintenanceView,
  type ReleaseFacts,
  type UpdateRightVerdict,
  type UpdateRights,
} from '@ensemus/domain/license';
import type { AdvisorySeverity } from '@ensemus/domain/license';
import { can } from '@ensemus/domain/policy';
import { AGGREGATE_LICENSE, LICENSE_DOCUMENT_INSTALLED } from '@ensemus/domain/sovereign-events';
import type { DocumentFor } from '@ensemus/sovereign/documents';
import { MAX_ENVELOPE_BYTES, PAYLOAD_TYPES } from '@ensemus/sovereign/envelope';
import type { TrustRoot } from '@ensemus/sovereign/trust-root';
import {
  verifyDocument,
  type DocumentRefusal,
  type DocumentVerdict,
} from '@ensemus/sovereign/verify';
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { AppError } from './errors';
import { emit } from './events';

export type LicenseDeps = {
  /**
   * Null where no trust root is configured, which is an answer: anything installed is `unverifiable`, and
   * this never crashes. With nothing installed the standing is still `unlicensed`.
   */
  trustRoot: TrustRoot | null;
  /** What this deployment is running, from its own bundle manifest. Null where that is not known. */
  runningRelease: ReleaseFacts | null;
  now?: () => Date;
};

export type InstalledDocument = {
  type: 'license' | 'maintenance' | 'advisory' | 'support_policy';
  /** This deployment's own record of the document. An advisory's own ID is not a UUID, and this always is. */
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

type InstallableKind = 'license' | 'maintenance' | 'advisory' | 'support_policy';

type CheckedAs<K extends InstallableKind> = {
  type: K;
  document: DocumentFor<K>;
  /** The ID the document gives itself, which is what its signature covers. */
  documentId: string;
  keyIds: readonly string[];
  testKey: boolean;
  retiredKey: boolean;
};

export type CheckedDocument = { [K in InstallableKind]: CheckedAs<K> }[InstallableKind];
export type DocumentCheck =
  { ok: true; checked: CheckedDocument } | { ok: false; code: DocumentRefusal };

function checkedAs<K extends InstallableKind>(
  type: K,
  verdict: DocumentVerdict<K>,
  idOf: (document: DocumentFor<K>) => string,
): { ok: false; code: DocumentRefusal } | { ok: true; checked: CheckedAs<K> } {
  if (!verdict.ok) return verdict;
  const { document, keyIds, testKey, retiredKey } = verdict;
  return {
    ok: true,
    checked: { type, document, documentId: idOf(document), keyIds, testKey, retiredKey },
  };
}

/**
 * Works out what a file is from its payload type, then verifies it as that and nothing else. It also runs
 * with no database, for the operator's command on a first boot. It holds no clock, and it never throws: a
 * bad file is an answer, so one damaged row can never take a page down with it.
 */
export function checkSignedDocument(text: string, root: TrustRoot): DocumentCheck {
  try {
    if (Buffer.byteLength(text) > MAX_ENVELOPE_BYTES) return { ok: false, code: 'TOO_LARGE' };
    const payloadType = (JSON.parse(text) as { payloadType?: unknown } | null)?.payloadType;
    switch (payloadType) {
      case PAYLOAD_TYPES.license:
        return checkedAs('license', verifyDocument('license', text, root), (d) => d.license_id);
      case PAYLOAD_TYPES.maintenance:
        return checkedAs(
          'maintenance',
          verifyDocument('maintenance', text, root),
          (d) => d.maintenance_id,
        );
      case PAYLOAD_TYPES.advisory:
        return checkedAs('advisory', verifyDocument('advisory', text, root), (d) => d.advisory_id);
      case PAYLOAD_TYPES.support_policy:
        return checkedAs(
          'support_policy',
          verifyDocument('support_policy', text, root),
          (d) => d.policy_id,
        );
      default:
        // A bundle manifest is signed too, and it has its own tool. It is not installed here.
        return { ok: false, code: 'WRONG_TYPE' };
    }
  } catch {
    return { ok: false, code: 'MALFORMED' };
  }
}

/** What verifies, of one kind, out of whatever was stored. What does not is skipped, and never named. */
function verifiedOfKind<K extends InstallableKind>(
  kind: K,
  envelopes: readonly string[],
  root: TrustRoot | null,
): readonly CheckedAs<K>[] {
  if (!root) return [];
  const found: CheckedAs<K>[] = [];
  for (const envelope of envelopes) {
    const check = checkSignedDocument(envelope, root);
    if (check.ok && check.checked.type === kind) found.push(check.checked as CheckedAs<K>);
  }
  return found;
}

const issuedTime = (document: { issued_at: string }) => Date.parse(document.issued_at);

/** The latest license that verifies, with a stable answer if two were issued at the same moment. */
function latestLicense(licenses: readonly CheckedAs<'license'>[]): CheckedAs<'license'> | null {
  let latest: CheckedAs<'license'> | null = null;
  for (const license of licenses) {
    const difference = latest ? issuedTime(license.document) - issuedTime(latest.document) : 1;
    if (difference > 0 || (difference === 0 && latest && license.documentId > latest.documentId)) {
      latest = license;
    }
  }
  return latest;
}

function toLicenseView(license: CheckedAs<'license'>): LicenseView {
  const { document, keyIds, testKey, retiredKey } = license;
  return {
    licenseId: document.license_id,
    licensee: {
      displayName: document.licensee.display_name,
      contractReference: document.licensee.contract_reference,
    },
    term: document.term,
    licensedRelease: document.licensed_release,
    footprint: document.footprint,
    components: document.components,
    updateRights: document.update_rights,
    issuedAt: new Date(document.issued_at),
    keyIds,
    testKey,
    retiredKey,
  };
}

/** The envelopes a tenant has stored, as read. Nothing about them is believed yet. */
export type StoredEnvelopes = {
  licenses: readonly string[];
  documents: readonly string[];
};

/**
 * The standing, from nothing but stored files and what this deployment was told. Kept apart from the
 * database so the promise it holds can be tested on its own: whatever the files, the clock or the trust
 * root say, this returns a status, and a status is all it can return.
 */
export function licenseStatusFromDocuments(
  stored: StoredEnvelopes,
  seatsInUse: number,
  deps: LicenseDeps,
): LicenseStatusView {
  const today = dayOf(deps.now?.() ?? new Date());
  const license = latestLicense(verifiedOfKind('license', stored.licenses, deps.trustRoot));
  const standing: LicenseStanding = license
    ? 'licensed'
    : stored.licenses.length > 0
      ? 'unverifiable'
      : 'unlicensed';

  // The license it names is read from the signed statement. The row's own column is only for finding it.
  const agreements = license
    ? verifiedOfKind('maintenance', stored.documents, deps.trustRoot).filter(
        ({ document }) => document.license_id === license.document.license_id,
      )
    : [];
  const policies = verifiedOfKind('support_policy', stored.documents, deps.trustRoot);
  const maintenance = maintenanceStatus(
    agreements.map(({ document }) => document),
    today,
  );

  let verdict: UpdateRightVerdict | null = null;
  if (license && deps.runningRelease) {
    try {
      verdict = evaluateUpdateRight({
        license: license.document,
        agreements: agreements.map(({ document }) => document),
        policies: policies.map(({ document }) => document),
        release: deps.runningRelease,
        today,
      });
    } catch {
      // A running release with a version nothing can compare, such as an unreleased build. No answer.
      verdict = null;
    }
  }

  // Anything this status rests on counts, so a real license with a test statement still says so.
  const restsOn = license ? [license, ...agreements, ...policies] : [];
  return {
    standing,
    license: license ? toLicenseView(license) : null,
    maintenance,
    runningRelease: deps.runningRelease ? { version: deps.runningRelease.version, verdict } : null,
    seatsInUse,
    notices: licenseNotices({
      standing,
      license: license ? license.document : null,
      maintenance,
      today,
      signedWithTestKey: restsOn.some(({ testKey }) => testKey),
      signedWithRetiredKey: restsOn.some(({ retiredKey }) => retiredKey),
      runningReleaseCovered: verdict ? verdict.covered : null,
      seatsInUse,
    }),
  };
}

/** Advisories that verify, newest first. A reissue under the same ID replaces the older one. */
export function advisoriesFromDocuments(
  envelopes: readonly string[],
  deps: Pick<LicenseDeps, 'trustRoot' | 'runningRelease'>,
): readonly AdvisoryView[] {
  const newest = new Map<string, CheckedAs<'advisory'>>();
  for (const advisory of verifiedOfKind('advisory', envelopes, deps.trustRoot)) {
    const held = newest.get(advisory.documentId);
    if (!held || issuedTime(advisory.document) > issuedTime(held.document)) {
      newest.set(advisory.documentId, advisory);
    }
  }
  return [...newest.values()]
    .sort(
      (a, b) =>
        issuedTime(b.document) - issuedTime(a.document) || a.documentId.localeCompare(b.documentId),
    )
    .map(({ document, testKey }) => ({
      advisoryId: document.advisory_id,
      severity: document.severity,
      title: document.title,
      summary: document.summary,
      affectedVersions: document.affected_versions,
      fixedInVersions: document.fixed_in_versions,
      issuedAt: new Date(document.issued_at),
      affectsThisRelease: deps.runningRelease
        ? document.affected_versions.includes(deps.runningRelease.version)
        : null,
      testKey,
    }));
}

/** Far more than a tenant's documents in any real life, and it stops a page verifying without limit. */
const MAX_ROWS_READ = 500;

async function readLicenseEnvelopes(tx: Tx, context: TenantContext): Promise<string[]> {
  const rows = await tx
    .select({ envelope: licenseRecords.envelope })
    .from(licenseRecords)
    .where(eq(licenseRecords.organizationId, context.organizationId))
    .orderBy(desc(licenseRecords.issuedAt), desc(licenseRecords.id))
    .limit(MAX_ROWS_READ);
  return rows.map(({ envelope }) => envelope);
}

async function readDocumentEnvelopes(
  tx: Tx,
  context: TenantContext,
  types: readonly string[],
): Promise<string[]> {
  const rows = await tx
    .select({ envelope: signedDocuments.envelope })
    .from(signedDocuments)
    .where(
      and(
        eq(signedDocuments.organizationId, context.organizationId),
        inArray(signedDocuments.documentType, [...types]),
      ),
    )
    .orderBy(desc(signedDocuments.issuedAt), desc(signedDocuments.id))
    .limit(MAX_ROWS_READ);
  return rows.map(({ envelope }) => envelope);
}

/** Inserts the row for a document. Null when this exact file is already here. */
async function insertDocument(
  tx: Tx,
  context: TenantContext,
  checked: CheckedDocument,
  envelope: string,
  envelopeSha256: string,
  installedByMembershipId: string | null,
): Promise<string | null> {
  const shared = {
    organizationId: context.organizationId,
    keyIds: [...checked.keyIds],
    envelope,
    envelopeSha256,
    issuedAt: new Date(checked.document.issued_at),
    installedByMembershipId,
  };
  const inserted =
    checked.type === 'license'
      ? await tx
          .insert(licenseRecords)
          .values({
            ...shared,
            licenseId: checked.document.license_id,
            edition: checked.document.edition,
            licensedVersion: checked.document.licensed_release.version,
            termKind: checked.document.term.kind,
          })
          .onConflictDoNothing({
            target: [licenseRecords.organizationId, licenseRecords.envelopeSha256],
          })
          .returning({ id: licenseRecords.id })
      : await tx
          .insert(signedDocuments)
          .values({
            ...shared,
            documentType: checked.type,
            documentId: checked.documentId,
            subjectLicenseId: checked.type === 'maintenance' ? checked.document.license_id : null,
          })
          .onConflictDoNothing({
            target: [signedDocuments.organizationId, signedDocuments.envelopeSha256],
          })
          .returning({ id: signedDocuments.id });
  return inserted[0]?.id ?? null;
}

async function findInstalled(
  tx: Tx,
  context: TenantContext,
  type: InstallableKind,
  envelopeSha256: string,
): Promise<string> {
  const [row] =
    type === 'license'
      ? await tx
          .select({ id: licenseRecords.id })
          .from(licenseRecords)
          .where(
            and(
              eq(licenseRecords.organizationId, context.organizationId),
              eq(licenseRecords.envelopeSha256, envelopeSha256),
            ),
          )
      : await tx
          .select({ id: signedDocuments.id })
          .from(signedDocuments)
          .where(
            and(
              eq(signedDocuments.organizationId, context.organizationId),
              eq(signedDocuments.envelopeSha256, envelopeSha256),
            ),
          );
  // The insert just found this row, and nothing can delete from an append-only table.
  if (!row) throw new AppError('LICENSE_NOT_VALID');
  return row.id;
}

/**
 * Checks a signed file and stores it as delivered, whichever kind it is, working that out from its payload
 * type. Needs `license.manage`, or a service context from an operator's command. Refuses anything that does
 * not verify, with `LICENSE_NOT_VALID`, and stores nothing. Writes an audit row and `emit`
 * (`LICENSE_DOCUMENT_INSTALLED`) in the same transaction. A maintenance statement for a license not
 * installed here is refused the same way.
 */
export async function installSignedDocument(
  database: AppDatabase,
  context: TenantContext,
  input: { envelope: string },
  deps: Pick<LicenseDeps, 'trustRoot'>,
): Promise<InstalledDocument> {
  const isOperator = context.actorType === 'service';
  // Before anything is looked at, so someone without the right learns nothing about a file.
  if (!isOperator && !can(context.role, 'license.manage')) throw new AppError('FORBIDDEN');
  const { trustRoot } = deps;
  if (!trustRoot) throw new AppError('LICENSE_NOT_VALID');
  const { envelope } = input;
  const check = checkSignedDocument(envelope, trustRoot);
  if (!check.ok) throw new AppError('LICENSE_NOT_VALID');
  const { checked } = check;
  const envelopeSha256 = createHash('sha256').update(envelope).digest('hex');

  return withTenantTx(database, context, async (tx) => {
    if (checked.type === 'maintenance') {
      // Installed means a license here that verifies now and says so itself, and not a row that says so.
      const candidates = await tx
        .select({ envelope: licenseRecords.envelope })
        .from(licenseRecords)
        .where(
          and(
            eq(licenseRecords.organizationId, context.organizationId),
            eq(licenseRecords.licenseId, checked.document.license_id),
          ),
        )
        .limit(MAX_ROWS_READ);
      const known = verifiedOfKind(
        'license',
        candidates.map((row) => row.envelope),
        trustRoot,
      ).some(({ document }) => document.license_id === checked.document.license_id);
      if (!known) throw new AppError('LICENSE_NOT_VALID');
    }

    const id = await insertDocument(
      tx,
      context,
      checked,
      envelope,
      envelopeSha256,
      isOperator ? null : context.membershipId,
    );
    if (id === null) {
      return {
        type: checked.type,
        id: await findInstalled(tx, context, checked.type, envelopeSha256),
        created: false,
        testKey: checked.testKey,
      };
    }

    await appendAudit(tx, {
      organizationId: context.organizationId,
      ...(isOperator
        ? { actorType: 'service' as const }
        : { actorType: 'user' as const, actorId: context.membershipId }),
      action: LICENSE_DOCUMENT_INSTALLED,
      targetRef: `${checked.type}:${id}`,
      decision: 'allow',
    });
    await emit(tx, context, {
      eventType: LICENSE_DOCUMENT_INSTALLED,
      aggregateType: AGGREGATE_LICENSE,
      aggregateId: id,
      aggregateVersion: 1,
      classification: 'internal',
      payload: {
        documentType: checked.type,
        documentId: checked.documentId,
        testKey: checked.testKey,
      },
    });
    return { type: checked.type, id, created: true, testKey: checked.testKey };
  });
}

/**
 * What an administrator is shown. Needs `license.view`, and an operator's command may read it too, since
 * it has just been asked to install something and has to say where that left things. Re-verifies every
 * stored envelope against the trust root as it reads it: the one with the latest `issued_at` that verifies
 * is the license, rows that do not verify are skipped and turn the standing to `unverifiable` only if none
 * verifies, and every date comes from a verified document, never from a column. Maintenance, policies and
 * `evaluateUpdateRight` are worked out here so that a page cannot get them wrong. This never throws for a
 * bad document.
 */
export async function getLicenseStatus(
  database: AppDatabase,
  context: TenantContext,
  deps: LicenseDeps,
): Promise<LicenseStatusView> {
  if (context.actorType !== 'service' && !can(context.role, 'license.view')) {
    throw new AppError('FORBIDDEN');
  }
  // Read first and verify afterwards, so no transaction stays open while signatures are checked.
  const { stored, seatsInUse } = await withTenantTx(database, context, async (tx) => {
    const licenses = await readLicenseEnvelopes(tx, context);
    const documents = await readDocumentEnvelopes(tx, context, ['maintenance', 'support_policy']);
    const [seats] = await tx
      .select({ n: count() })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.status, 'active'),
        ),
      );
    return { stored: { licenses, documents }, seatsInUse: seats?.n ?? 0 };
  });
  return licenseStatusFromDocuments(stored, seatsInUse, deps);
}

/** Advisories that verify, newest first. Needs `license.view`. Reading one changes nothing. */
export async function listAdvisories(
  database: AppDatabase,
  context: TenantContext,
  deps: LicenseDeps,
): Promise<readonly AdvisoryView[]> {
  if (!can(context.role, 'license.view')) throw new AppError('FORBIDDEN');
  const envelopes = await withTenantTx(database, context, (tx) =>
    readDocumentEnvelopes(tx, context, ['advisory']),
  );
  return advisoriesFromDocuments(envelopes, deps);
}

/**
 * M4's `Entitlements` port (ADR-028 FD-8), for a Sovereign deployment, in that port's shape so it needs no
 * import from a branch not yet merged. `@ensemus/commercial` delegates here when the organization's mode is
 * `sovereign`, at the final merge. Its return type has no way to refuse, because a purchased version keeps
 * working whatever the license, the maintenance dates or the clock say (ADR-030 D2). Inference is the
 * customer's own, so nothing here is billable.
 */
export function createSovereignEntitlements() {
  return {
    async check(
      _context: TenantContext,
      _feature: string,
    ): Promise<{ ok: true; billable: false; commercialMode: 'sovereign' }> {
      return { ok: true, billable: false, commercialMode: 'sovereign' };
    },
  };
}

/**
 * The facts a later check may use, such as showing footprint in M8's views. A narrow read with no permission
 * check, since nothing it returns is shown by itself, and with no way to say "stop": where nothing verifies
 * it answers null, and a Sovereign deployment keeps running.
 */
export async function readVerifiedLicenseFacts(
  database: AppDatabase,
  context: TenantContext,
  deps: Pick<LicenseDeps, 'trustRoot'>,
): Promise<{
  licenseId: string;
  components: readonly string[];
  footprint: LicenseFootprint;
} | null> {
  const envelopes = await withTenantTx(database, context, (tx) =>
    readLicenseEnvelopes(tx, context),
  );
  const license = latestLicense(verifiedOfKind('license', envelopes, deps.trustRoot));
  if (!license) return null;
  return {
    licenseId: license.document.license_id,
    components: license.document.components,
    footprint: license.document.footprint,
  };
}
