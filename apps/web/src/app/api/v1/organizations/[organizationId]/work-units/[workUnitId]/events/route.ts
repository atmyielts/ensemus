import { setTimeout as sleep } from 'node:timers/promises';
import { AppError, getWorkFollowState, getWorkFollowStateAsMember } from '@ensemus/application';
import { TenantAccessDenied } from '@ensemus/database';
import { errorCode } from '@ensemus/telemetry';
import { z } from 'zod';
import { apiLog, apiRoute, readQuery, workUnitParams } from '@/server/api';
import { getRestoreGate, getRuntime } from '@/server/runtime';

export const dynamic = 'force-dynamic';

// Live status (API-13, ADR-024 D3). PostgreSQL is the read model, so this survives a web restart and
// works on any replica, and a reconnect resumes from Last-Event-ID. Each poll runs one short transaction
// (ADR-037 D5), and no transaction stays open between polls.
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

// The web page asks for this as well. A file or a decision on a review that does not hold the work
// leaves the version alone, and the page still has to hear of it. Without it, only status events.
const eventsQuery = z.object({ include: z.enum(['evidence']).optional() });

export const GET = apiRoute(
  workUnitParams,
  async ({ request, requestId, userId, context, database, params }) => {
    // Checked before streaming starts, so that a refusal is a real 404 and EventSource stops trying.
    const withEvidence = readQuery(request, eventsQuery).include === 'evidence';
    const asked = { evidence: withEvidence };
    const first = await getWorkFollowState(database, context, params.workUnitId, asked);
    const { organizationId, workUnitId } = params;
    const stop = new AbortController();
    const signal = AbortSignal.any([
      request.signal,
      stop.signal,
      AbortSignal.timeout(MAX_LIFETIME_MS),
    ]);
    const sessionHeaders = new Headers(request.headers);

    /** Access is decided afresh on each pass, and nothing about the person is carried over. */
    async function currentState() {
      const { context: fresh, state } = await getWorkFollowStateAsMember(
        database,
        userId,
        organizationId,
        workUnitId,
        asked,
      );
      // A stream opened before a restore does not outlast it, or it would report a past that is gone.
      // Outside the transaction, because a check can wait on the object store. Nothing has been written yet.
      await getRestoreGate().assertServing(fresh);
      return state;
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
      let state = first;
      let evidenceSent: string | null = null;
      let lastWrite = Date.now();
      let lastSessionCheck = Date.now();
      try {
        write(`retry: ${RECONNECT_MS}\n\n`);
        while (!signal.aborted) {
          const now = Date.now();
          const { version } = state;
          const evidenceMoved = withEvidence && state.evidence !== evidenceSent;
          if (evidenceMoved) {
            // Carries no ID, because Last-Event-ID stays a version whichever events were asked for.
            write(`event: evidence\ndata: ${state.evidence}\n\n`);
            evidenceSent = state.evidence;
            lastWrite = now;
          }
          if (version !== sent) {
            write(`id: ${version}\nevent: status\ndata: ${version}\n\n`);
            sent = version;
            lastWrite = now;
          } else if (!evidenceMoved && now - lastWrite >= HEARTBEAT_MS) {
            write(': keep-alive\n\n');
            lastWrite = now;
          }
          await sleep(POLL_MS, undefined, { signal });
          if (Date.now() - lastSessionCheck >= SESSION_CHECK_MS) {
            if (!(await sessionStillValid())) return;
            lastSessionCheck = Date.now();
          }
          state = await currentState();
        }
      } catch (error) {
        // Disconnects, the lifetime cap, lost access and a restore are all normal ways for this to end.
        const ended =
          error instanceof TenantAccessDenied ||
          (error instanceof AppError &&
            (error.code === 'NOT_FOUND' || error.code === 'RESTORE_PENDING'));
        if (!signal.aborted && !ended) {
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
