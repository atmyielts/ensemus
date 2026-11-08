import { openAccountExportArchive } from '@ensemus/application/saas/exports';
import { errorCode } from '@ensemus/telemetry';
import { apiLog, apiRoute } from '@/server/api';
import { getStore } from '@/server/runtime';
import { archiveHeaders, archiveStream, exportParams } from '@/server/sovereign-dto';

export const dynamic = 'force-dynamic';

// The archive leaves as sealed parts, a part at a time. This process holds no key that could open one, so
// the only thing it can do with these bytes is pass them on (ADR-030 D6, D7). Being not ready, superseded or
// not permitted is decided before streaming starts, so each of those is still a real status.
export const GET = apiRoute(
  exportParams,
  async ({ requestId, context, database, params }) => {
    const archive = await openAccountExportArchive(database, getStore(), context, params.exportId);
    const body = archiveStream(archive.chunks, (error) =>
      apiLog.error('export.download_failed', { requestId, errorCode: errorCode(error) }),
    );
    return new Response(body, { headers: archiveHeaders(archive) });
  },
  'account',
);
