import { readImportedArchiveFile, idSchema } from '@ensemus/application';
import { z } from 'zod';
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
  return new Response(new Uint8Array(file.bytes), {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(file.bytes.length),
      'Content-Disposition': `attachment; filename="archived-file"; filename*=UTF-8''${filename}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
    },
  });
});
