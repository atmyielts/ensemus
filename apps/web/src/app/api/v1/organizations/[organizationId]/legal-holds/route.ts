import {
  listLegalHolds,
  placeLegalHold,
  type LegalHoldView,
} from '@ensemus/application/saas/legal-holds';
import { placeLegalHoldSchema } from '@ensemus/contracts/saas';
import { apiRoute, etag, organizationParams, readJson } from '@/server/api';
export const dynamic = 'force-dynamic';
const dto = (row: LegalHoldView) => ({
  id: row.id,
  matter_ref: row.matterRef,
  status: row.status,
  scopes: row.scopes,
  placed_at: row.placedAt.toISOString(),
  released_at: row.releasedAt?.toISOString() ?? null,
  release_reason_code: row.releaseReasonCode,
  version: row.version,
});
export const GET = apiRoute(
  organizationParams,
  async ({ database, context }) =>
    Response.json({ items: (await listLegalHolds(database, context)).map(dto) }),
  'account',
);
export const POST = apiRoute(
  organizationParams,
  async ({ request, database, context }) => {
    const body = await readJson(request, placeLegalHoldSchema);
    const result = await placeLegalHold(database, context, {
      matterRef: body.matter_ref,
      scopes: body.scopes,
    });
    const row = (await listLegalHolds(database, context)).find(
      (hold) => hold.id === result.holdId,
    )!;
    return Response.json(dto(row), { status: 201, headers: { etag: etag(row.version) } });
  },
  'account',
);
