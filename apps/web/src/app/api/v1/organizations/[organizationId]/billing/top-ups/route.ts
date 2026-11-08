import { AppError } from '@ensemus/application';
import { listTopUpOffers } from '@ensemus/application/saas/catalog';
import { requestTopUp } from '@ensemus/application/saas/top-ups';
import { loadSaasConfig } from '@ensemus/config';
import { requestTopUpSchema } from '@ensemus/contracts/saas';
import { quoteHash } from '@ensemus/saas/credits';
import { apiRoute, organizationParams, readJson } from '@/server/api';

export const dynamic = 'force-dynamic';
export const GET = apiRoute(
  organizationParams,
  async ({ database, context }) => {
    const offers = await listTopUpOffers(database, context);
    return Response.json({
      offers: offers.map((offer) => ({
        offer_id: offer.offerId,
        microcredits: offer.microcredits.toString(),
        price_micros: offer.priceMicros.toString(),
        currency: offer.currency,
        quote_hash: quoteHash(offer),
      })),
    });
  },
  'account',
);
export const POST = apiRoute(
  organizationParams,
  async ({ request, database, context }) => {
    if (!loadSaasConfig().billingEnabled) throw new AppError('BILLING_NOT_ENABLED');
    const body = await readJson(request, requestTopUpSchema);
    const result = await requestTopUp(database, context, {
      offerId: body.offer_id,
      quoteHash: body.quote_hash,
      requestKey: body.request_key,
    });
    return Response.json(
      { top_up_id: result.topUpId, invoice_id: result.invoiceId },
      { status: 201 },
    );
  },
  'account',
);
