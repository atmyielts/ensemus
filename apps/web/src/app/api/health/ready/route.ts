import { pingDatabase } from '@ensemus/database';
import { errorCode } from '@ensemus/telemetry';
import { getRuntime } from '@/server/runtime';

export const dynamic = 'force-dynamic';

// Reports readiness only. It names no dependency or version, because anyone can call it.
export async function GET() {
  const { app, log } = getRuntime();
  try {
    await pingDatabase(app);
    return Response.json({ status: 'ready' });
  } catch (error) {
    log.warn('health.not_ready', { errorCode: errorCode(error) });
    return Response.json({ status: 'not_ready' }, { status: 503 });
  }
}
