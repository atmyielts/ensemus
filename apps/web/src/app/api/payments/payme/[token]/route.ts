import { paymeFallbackReply } from '@ensemus/saas/checkout';
import { handleCheckoutCall } from '@/server/checkout-ingress';

export const dynamic = 'force-dynamic';

// Payme's Merchant API calls this and waits for its JSON-RPC answer (ADR-032 D4a). Outside /api/v1, with no
// session: it stores bytes, believes none of them, and relays the answer the connector worker stored.
export async function POST(request: Request, route: { params: Promise<{ token: string }> }) {
  const { token } = await route.params;
  return handleCheckoutCall('payme', request, token);
}

// Payme's protocol answers a request that is not POST with its own code, in a 200. It names no order.
export async function GET() {
  return new Response(paymeFallbackReply('not_post'), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
