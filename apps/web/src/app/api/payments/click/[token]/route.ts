import { handleCheckoutCall } from '@/server/checkout-ingress';

export const dynamic = 'force-dynamic';

// Click's SHOP API sends Prepare and Complete here and waits for the answer (ADR-032 D4a). Outside /api/v1,
// with no session: it stores bytes, believes none of them, and relays the answer the connector worker stored.
export async function POST(request: Request, route: { params: Promise<{ token: string }> }) {
  const { token } = await route.params;
  return handleCheckoutCall('click', request, token);
}
