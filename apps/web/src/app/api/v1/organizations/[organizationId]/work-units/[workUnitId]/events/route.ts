import { setTimeout as sleep } from 'node:timers/promises';
import { AppError, getWorkUnit } from '@ensemus/application';
import { resolveTenantContext, TenantAccessDenied } from '@ensemus/database';
import { errorCode } from '@ensemus/telemetry';
import { apiLog, apiRoute, workUnitParams } from '@/server/api';
import { getRuntime } from '@/server/runtime';

export const dynamic = 'force-dynamic';

// Live status (API-13, ADR-024 D3). PostgreSQL is the read model, so this survives a web restart and
// works on any replica, and a reconnect resumes from Last-Event-ID. Each poll runs its own short
// transactions, and no transaction stays open between polls.
const POLL_MS = 1_000;
const HEARTBEAT_MS = 15_000;
const SESSION_CHECK_MS = 30_000;
const MAX_LIFETIME_MS = 15 * 60 * 1_000;
const RECONNECT_MS = 3_000;

/** A malformed value is treated as no value: the client simply gets the current version again. */
function lastEventId(request: Request): number | null {
  const value = request.headers.get('last-event-id');
  return value && /^\d{1,10}$/.test(value) ? Number(value) : null;
}

const encoder = new TextEncoder();

export const GET = apiRoute(
  workUnitParams,
  async ({ request, requestId, userId, context, database, params }) => {
    // Checked before streaming starts, so that a refusal is a real 404 and EventSource stops trying.
    const first = await getWorkUnit(database, context, params.workUnitId);
    const { organizationId, workUnitId } = params;
    const stop = new AbortController();
    const signal = AbortSignal.any([
      request.signal,
      stop.signal,
      AbortSignal.timeout(MAX_LIFETIME_MS),
    ]);
    const sessionHeaders = new Headers(request.headers);

    /** Access is decided afresh on each pass, and nothing about the person is carried over. */
    async function currentVersion() {
      const fresh = await resolveTenantContext(database, userId, organizationId);
      const work = await getWorkUnit(database, fresh, workUnitId);
      return work.version;
    }

    /** A signed-out or expired session ends the stream, even when the membership is still active. */
    async function sessionStillValid() {
      const session = await getRuntime().auth.api.getSession({
        headers: sessionHeaders,
        // Refreshing would need to set a cookie, and the response headers have already gone.
        query: { disableRefresh: true },
      });
      return session?.user.id === userId;
    }

    async function follow(controller: ReadableStreamDefaultController<Uint8Array>) {
      const write = (text: string) => controller.enqueue(encoder.encode(text));
      let sent = lastEventId(request);
      let version = first.version;
      let lastWrite = Date.now();
      let lastSessionCheck = Date.now();
      try {
        write(`retry: ${RECONNECT_MS}\n\n`);
        while (!signal.aborted) {
          const now = Date.now();
          if (version !== sent) {
            write(`id: ${version}\nevent: status\ndata: ${version}\n\n`);
            sent = version;
            lastWrite = now;
          } else if (now - lastWrite >= HEARTBEAT_MS) {
            write(': keep-alive\n\n');
            lastWrite = now;
          }
          await sleep(POLL_MS, undefined, { signal });
          if (Date.now() - lastSessionCheck >= SESSION_CHECK_MS) {
            if (!(await sessionStillValid())) return;
            lastSessionCheck = Date.now();
          }
          version = await currentVersion();
        }
      } catch (error) {
        // Disconnects, the lifetime cap and lost access are all normal ways for this to end.
        const revoked =
          error instanceof TenantAccessDenied ||
          (error instanceof AppError && error.code === 'NOT_FOUND');
        if (!signal.aborted && !revoked) {
          apiLog.warn('api.stream_failed', { requestId, errorCode: errorCode(error) });
        }
      } finally {
        stop.abort();
        try {
          controller.close();
        } catch {
          // The client already went away, so the stream is closed.
        }
      }
    }

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        void follow(controller);
      },
      cancel() {
        stop.abort();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        // no-transform keeps compression from holding events back in a buffer.
        'Cache-Control': 'no-store, no-transform',
        'X-Accel-Buffering': 'no',
      },
    });
  },
);
