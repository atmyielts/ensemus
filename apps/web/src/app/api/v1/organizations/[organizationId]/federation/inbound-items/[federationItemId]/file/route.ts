import { readInboundFile } from '@ensemus/application';
import { declaredLength } from '@/lib/declared-length';
import { federationItemParams, federationRoute } from '@/server/federation-api';
import { getStore } from '@/server/runtime';

export const GET = federationRoute(federationItemParams, async ({ database, context, params }) => {
  const file = await readInboundFile(database, getStore(), context, params.federationItemId);
  const filename = encodeURIComponent(file.title).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  const body = new Uint8Array(file.body);
  return new Response(body, {
    headers: {
      ...declaredLength(body.byteLength),
      'Cache-Control': 'private, no-store, no-transform',
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="shared-file"; filename*=UTF-8''${filename}`,
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'X-Content-Type-Options': 'nosniff',
    },
  });
});
