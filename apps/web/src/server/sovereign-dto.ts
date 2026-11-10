import 'server-only';
import {
  idSchema,
  type AdvisoryView,
  type ExportArchive,
  type ImportedPersonView,
  type InstalledDocument,
  type LicenseStatusView,
  type OrganizationExportView,
  type OrganizationImportView,
} from '@ensemus/application';
import type { components } from '@ensemus/contracts/openapi';
import { requestExportSchema } from '@ensemus/contracts/sovereign';
import { z } from 'zod';

// The public shapes of licensing and the organization archive (ADR-030). Listed fields only, so nothing
// new in a service's view leaves through the API until it is added to the spec as well. A license's update
// rights and component list stay out, because the page is where a person reads them.

type Schemas = components['schemas'];

export const exportParams = z.object({ organizationId: idSchema, exportId: idSchema });
export const importParams = z.object({ organizationId: idSchema, importId: idSchema });
export const importedPersonParams = z.object({
  organizationId: idSchema,
  sourceMembershipId: idSchema,
});

export function licenseStatusDto(view: LicenseStatusView): Schemas['LicenseStatus'] {
  const { license, runningRelease } = view;
  return {
    standing: view.standing,
    license: license
      ? {
          license_id: license.licenseId,
          licensee_name: license.licensee.displayName,
          contract_reference: license.licensee.contractReference,
          term:
            license.term.kind === 'pilot'
              ? { kind: 'pilot', review_on: license.term.review_on }
              : { kind: 'perpetual' },
          licensed_version: license.licensedRelease.version,
          footprint_seats: license.footprint.seats,
          issued_at: license.issuedAt.toISOString(),
          test_key: license.testKey,
          retired_key: license.retiredKey,
        }
      : null,
    maintenance: {
      status: view.maintenance.status,
      last_covered_on: view.maintenance.lastCoveredOn,
    },
    running_release: runningRelease
      ? { version: runningRelease.version, covered: runningRelease.verdict?.covered ?? null }
      : null,
    seats_in_use: view.seatsInUse,
    notices: [...view.notices],
  };
}

export const installedDocumentDto = (view: InstalledDocument): Schemas['InstalledDocument'] => ({
  type: view.type,
  id: view.id,
  created: view.created,
  test_key: view.testKey,
});

export const advisoryDto = (view: AdvisoryView): Schemas['Advisory'] => ({
  advisory_id: view.advisoryId,
  severity: view.severity,
  title: view.title,
  summary: view.summary,
  affected_versions: [...view.affectedVersions],
  fixed_in_versions: [...view.fixedInVersions],
  issued_at: view.issuedAt.toISOString(),
  affects_this_release: view.affectsThisRelease,
  test_key: view.testKey,
});

export const organizationExportDto = (
  view: OrganizationExportView,
): Schemas['OrganizationExport'] => ({
  id: view.id,
  status: view.status,
  scope: view.scope,
  recipient_key_id: view.recipientKeyId,
  requested_at: view.requestedAt.toISOString(),
  finished_at: view.finishedAt?.toISOString() ?? null,
  expires_at: view.expiresAt?.toISOString() ?? null,
  part_count: view.partCount,
  record_count: view.recordCount,
  archive_bytes: view.archiveBytes,
  excluded: {
    restricted_work: view.excluded.restrictedWork,
    restricted_artifacts: view.excluded.restrictedArtifacts,
    restricted_clients: view.excluded.restrictedClients,
  },
  failure_code: view.failureCode,
  downloadable: view.downloadable,
});

export const organizationImportDto = (
  view: OrganizationImportView,
): Schemas['OrganizationImport'] => ({
  id: view.id,
  status: view.status,
  requested_at: view.requestedAt.toISOString(),
  finished_at: view.finishedAt?.toISOString() ?? null,
  source_organization_id: view.sourceOrganizationId,
  exported_at: view.exportedAt?.toISOString() ?? null,
  source_release: view.sourceRelease,
  applied_counts: { ...view.appliedCounts },
  warning_counts: { ...view.warningCounts },
  failure_code: view.failureCode,
});

export const importedPersonDto = (view: ImportedPersonView): Schemas['ImportedPerson'] => ({
  source_membership_id: view.sourceMembershipId,
  display_name: view.displayName,
  email: view.email,
  source_role: view.sourceRole,
  target_membership_id: view.targetMembershipId,
  linked_at: view.linkedAt?.toISOString() ?? null,
});

/** What the archive route says about the file. The name is the service's, and is still kept to safe characters. */
export function archiveHeaders(archive: Pick<ExportArchive, 'fileName' | 'totalBytes'>) {
  const name = archive.fileName.replace(/[^A-Za-z0-9._-]/g, '_') || 'organization-export.tar';
  return {
    'Content-Type': 'application/x-tar',
    'Content-Disposition': `attachment; filename="${name}"`,
    'Content-Length': String(archive.totalBytes),
    // application/x-tar is a type the app's own compression gzips, and an encoded archive leaves with no
    // Content-Length, so a cut-off download would look whole. no-transform keeps the bytes as declared.
    'Cache-Control': 'no-store, no-transform',
    'X-Content-Type-Options': 'nosniff',
  };
}

/**
 * Hands the archive over a chunk at a time, asking for the next only when the last has gone, so the web
 * process holds no more than one sealed part. A failure part way aborts the response: the headers have left
 * by then, and a client must see a broken download and not a shorter file that looks whole.
 */
export function archiveStream(
  chunks: AsyncIterable<Uint8Array>,
  onFailure: (error: unknown) => void,
): ReadableStream<Uint8Array> {
  const iterator = chunks[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await iterator.next();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        onFailure(error);
        controller.error(new Error('The archive could not be read'));
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

/** What was typed into the export form's key field, kept apart so that a test can reach it. */
export type RecipientKeyField =
  { ok: true; key: string } | { ok: false; reason: 'private_key' | 'invalid' };

/**
 * Reads the public key field. Someone may paste the wrong half of the pair, which is worth saying plainly.
 * Whatever is refused goes no further: it is not kept, repeated back or logged.
 */
export function readRecipientKeyField(value: string): RecipientKeyField {
  const key = value.trim();
  if (/PRIVATE\s+KEY/i.test(key)) return { ok: false, reason: 'private_key' };
  // The API's own rule for this field, so the form and the API cannot drift apart.
  const parsed = requestExportSchema.shape.recipient_public_key.safeParse(key);
  return parsed.success ? { ok: true, key: parsed.data } : { ok: false, reason: 'invalid' };
}
