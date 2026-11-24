import { disposeInboundItem } from '@ensemus/application';
import { disposeInboundItemSchema } from '@ensemus/contracts/federation';
import { readJson } from '@/server/api';
import {
  federationItemParams,
  federationJson,
  federationRoute,
  inboundItemDto,
} from '@/server/federation-api';

export const POST = federationRoute(
  federationItemParams,
  async ({ database, context, params, request }) => {
    const decision = await readJson(request, disposeInboundItemSchema);
    const item = await disposeInboundItem(database, context, {
      itemId: params.federationItemId,
      disposition: decision.disposition,
      linkedWorkUnitId: decision.linked_work_unit_id ?? null,
      expectedVersion: decision.expected_version,
    });
    return federationJson(inboundItemDto(item));
  },
);
