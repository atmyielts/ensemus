import type { PackCatalogEntry, PackInstallationView } from '@ensemus/application/packs';
import { idSchema } from '@ensemus/application';
import { z } from 'zod';
import { etag } from '@/server/api';

export const installationParams = z.object({ organizationId: idSchema, installationId: idSchema });

/** The public shape of an installation. A capability says what was decided, and it grants nothing. */
export function installationDto(view: PackInstallationView) {
  return {
    id: view.id,
    pack_key: view.packKey,
    pack_version: view.packVersion,
    manifest_sha256: view.manifestSha256,
    status: view.status,
    capabilities: view.capabilities.map((capability) => ({
      key: capability.key,
      kind: capability.kind,
      subject: capability.subject,
      risk: capability.risk,
      required_by: capability.requiredBy,
      decision: capability.decision,
      decided_by_membership_id: capability.decidedByMembershipId,
    })),
    items: view.items.map((item) => ({ kind: item.kind, key: item.key, id: item.id })),
    version: view.version,
  };
}

export function catalogEntryDto(entry: PackCatalogEntry) {
  return {
    key: entry.key,
    version: entry.version,
    name: entry.name,
    description: entry.description,
    installation: entry.installation,
    upgrade: entry.upgrade && {
      from_version: entry.upgrade.fromVersion,
      to_version: entry.upgrade.toVersion,
      steps: entry.upgrade.steps,
      needs_review: entry.upgrade.needsReview,
      refused: entry.upgrade.refused,
    },
  };
}

export const installationResponse = (view: PackInstallationView, status = 200) =>
  Response.json(installationDto(view), { status, headers: { ETag: etag(view.version) } });
