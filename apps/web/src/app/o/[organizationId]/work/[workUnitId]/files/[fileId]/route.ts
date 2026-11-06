import { AppError, readArtifact } from '@ensemus/application';
import { errorCode } from '@ensemus/telemetry';
import { unstable_rethrow } from 'next/navigation';
import { z } from 'zod';
import { getRuntime, getStore } from '@/server/runtime';
import { requireTenant } from '@/server/tenant';

export const dynamic = 'force-dynamic';

const pathIds = z.object({
  organizationId: z.uuid(),
  workUnitId: z.uuid(),
  fileId: z.uuid(),
});

// The stored type is whatever the uploader's browser claimed, so it is only ever used to pick from
// this list. Types a browser can run or script, such as HTML, SVG and XML, are not on it.
const SAFE_TYPES = new Set([
  'application/pdf',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
  'text/csv',
  'text/plain',
]);

function safeContentType(stored: string) {
  const type = stored.split(';')[0]?.trim().toLowerCase() ?? '';
  return SAFE_TYPES.has(type) ? type : 'application/octet-stream';
}

/** RFC 6266 with RFC 5987: a plain ASCII name for old clients, and the real one for the rest. */
function contentDisposition(name: string) {
  // Control characters could split the header, and format characters can disguise the extension.
  // Lone surrogates would make encodeURIComponent throw.
  const clean = name.replace(/[\p{Cc}\p{Cf}\p{Cs}/\\]/gu, '_').trim() || 'download';
  const ascii = clean.replace(/[^A-Za-z0-9._ -]/g, '_');
  // encodeURIComponent leaves these four characters alone, and RFC 5987 does not allow them.
  const encoded = encodeURIComponent(clean).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

const NO_STORE = { 'Cache-Control': 'private, no-store' };
const notFoundResponse = () => new Response('Not found', { status: 404, headers: NO_STORE });

export async function GET(
  _request: Request,
  route: { params: Promise<{ organizationId: string; workUnitId: string; fileId: string }> },
) {
  const ids = pathIds.safeParse(await route.params);
  if (!ids.success) return notFoundResponse();
  try {
    const { context, database } = await requireTenant(ids.data.organizationId);
    const file = await readArtifact(database, getStore(), context, {
      workUnitId: ids.data.workUnitId,
      artifactId: ids.data.fileId,
    });
    return new Response(file.body as Uint8Array<ArrayBuffer>, {
      headers: {
        ...NO_STORE,
        'Content-Type': safeContentType(file.mimeType),
        'Content-Disposition': contentDisposition(file.name),
        'Content-Length': String(file.body.length),
        'X-Content-Type-Options': 'nosniff',
        // If anything ever does render this, it runs nothing and fetches nothing.
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    });
  } catch (error) {
    // requireTenant signals sign-in and not-found with errors that Next.js itself must handle.
    unstable_rethrow(error);
    if (error instanceof AppError && error.code === 'NOT_FOUND') return notFoundResponse();
    getRuntime().log.error('file.download_failed', { errorCode: errorCode(error) });
    return new Response('Something went wrong', { status: 500, headers: NO_STORE });
  }
}
