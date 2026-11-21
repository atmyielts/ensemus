import { unsubscribeByToken } from '@ensemus/application/platform-mail';
import { errorCode } from '@ensemus/telemetry';
import { getRuntime } from '@/server/runtime';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' };

/**
 * RFC 8058 one-click unsubscribe: a mail program posts here, with no session, from the List-Unsubscribe
 * header of a message someone chose to get. The token is the permission, for one person and one topic,
 * and 0571 lets it write nothing but `off`. The body is not read. Following it again changes nothing.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  try {
    const outcome = await unsubscribeByToken(getRuntime().app, token);
    return new Response(null, { status: outcome.status === 'done' ? 200 : 404, headers: NO_STORE });
  } catch (error) {
    getRuntime().log.error('mail.unsubscribe_failed', { errorCode: errorCode(error) });
    return new Response(null, { status: 503, headers: NO_STORE });
  }
}

/** Opening the link changes nothing: it shows a page that asks first. */
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return Response.redirect(
    new URL(`/unsubscribe/${encodeURIComponent(token)}`, getRuntime().config.publicUrl),
    303,
  );
}
