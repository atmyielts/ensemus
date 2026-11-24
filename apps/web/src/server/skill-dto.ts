import type { SkillPackageView } from '@ensemus/application';

export function skillPackageDto(row: SkillPackageView) {
  return {
    id: row.id,
    name: row.name,
    display_name: row.displayName,
    origin: row.origin,
    listing_id: row.listingId,
    state: row.state,
    content_classification: row.contentClassification,
    version: row.version,
    created_at: row.createdAt.toISOString(),
  };
}
