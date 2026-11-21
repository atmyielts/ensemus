import 'server-only';
import { runIdempotent, requestHash, type ProposedBusinessAction } from '@ensemus/application';
import type { AppDatabase, TenantContext } from '@ensemus/database';
import { canonicalJson } from '@ensemus/domain/approval';
import { assertConnectorsEnabled, etag, idempotencyKeyReused, proposedDto } from './api';
/** One API key covers the entire real proposal/revision transaction, including its new approval. */
export async function businessProposalResponse(
  request: Request,
  database: AppDatabase,
  context: TenantContext,
  body: unknown,
  perform: (joined: AppDatabase) => Promise<ProposedBusinessAction>,
  version?: number,
) {
  assertConnectorsEnabled();
  const result = await runIdempotent(
    database,
    context,
    {
      key: request.headers.get('idempotency-key') ?? '',
      requestHash: requestHash([
        request.method,
        new URL(request.url).pathname,
        String(version ?? ''),
        canonicalJson(body),
      ]),
    },
    perform,
    (row) => ({ status: 201, body: proposedDto(row) }),
  );
  if (result.kind === 'conflict') throw idempotencyKeyReused();
  return Response.json(result.body, { status: result.status, headers: { ETag: etag(1) } });
}
