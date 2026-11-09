import { readImportedArchiveFile, idSchema } from '@ensemus/application';
import { z } from 'zod';
import { declaredLength } from '@/lib/declared-length';
import { apiRoute } from '@/server/api';
import { getStore } from '@/server/runtime';

export const dynamic = 'force-dynamic';
const params = z.object({
  organizationId: idSchema,
  importId: idSchema,
  sourceArtifactId: idSchema,
});
export const GET = apiRoute(params, async ({ database, context, params }) => {
  const file = await readImportedArchiveFile(database, getStore(), context, params);
  const filename = encodeURIComponent(file.name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  const body = new Uint8Array(file.bytes);
  return new Response(body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      // Next.js drops Content-Length from a route's response, so the proxy restores it from this.
      ...declaredLength(body.byteLength),
      'Content-Disposition': `attachment; filename="archived-file"; filename*=UTF-8''${filename}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
    },
  });
});
