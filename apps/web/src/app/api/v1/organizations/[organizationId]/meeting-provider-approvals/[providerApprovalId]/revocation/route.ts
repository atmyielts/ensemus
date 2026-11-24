import { revokeMeetingProvider } from '@ensemus/application';
import { apiRoute } from '@/server/api';
import { providerApprovalParams } from '@/server/meeting-api';

export const dynamic = 'force-dynamic';

export const POST = apiRoute(providerApprovalParams, async ({ database, context, params }) => {
  await revokeMeetingProvider(database, context, params);
  return new Response(null, { status: 204 });
});
