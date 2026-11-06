import { handleWebhook } from '@/server/webhook-ingress';

export const dynamic = 'force-dynamic';

// Outside /api/v1 and with no apiRoute, because it is not a client API and takes no session. It stores
// bytes and believes none of them, and the connector worker checks the signature later (ADR-027 D4).
export async function POST(request: Request, route: { params: Promise<{ token: string }> }) {
  const { token } = await route.params;
  return handleWebhook(request, token);
}
