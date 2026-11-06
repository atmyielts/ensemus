import { listBreakGlassRequests } from '@ensemus/application/saas/break-glass';
import { apiRoute, organizationParams } from '@/server/api';
import { breakGlassDto } from '../dto';
export const dynamic = 'force-dynamic';
export const GET = apiRoute(
  organizationParams,
  async ({ database, context }) =>
    Response.json({ items: (await listBreakGlassRequests(database, context)).map(breakGlassDto) }),
  'account',
);
