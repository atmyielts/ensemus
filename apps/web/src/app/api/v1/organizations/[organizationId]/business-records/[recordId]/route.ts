import { getBusinessRecord } from '@ensemus/application';
import { apiRoute } from '@/server/api';
import { businessRecordParams, businessRecordDto } from '@/server/business-record-api';
export const dynamic = 'force-dynamic';
export const GET = apiRoute(businessRecordParams, async ({ database, context, params }) =>
  Response.json(businessRecordDto(await getBusinessRecord(database, context, params.recordId))),
);
