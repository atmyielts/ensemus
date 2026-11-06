'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { runSignature } from './run-view';

const CHECK_EVERY_MS = 4_000;
const LONGEST_WAIT_MS = 30_000;

/**
 * Keeps a live run's page true. Each check asks PostgreSQL through the API, so any replica answers the
 * same, and a page that lost contact catches up from the first answer it gets. While there is no answer
 * it says so, because a screen that goes on showing "Running" would otherwise be stating something
 * nobody knows. Being told this person may not see it any more ends the checks, and the refresh shows
 * that. If this never runs, the page is still correct when reloaded, and it has a link to do that.
 */
export function RunWatcher({
  runUrl,
  stepsUrl,
  signature,
}: {
  runUrl: string;
  stepsUrl: string;
  signature: string;
}) {
  const router = useRouter();
  const [lostContact, setLostContact] = useState(false);
  const latest = useRef(signature);
  latest.current = signature;

  useEffect(() => {
    const stop = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wait = CHECK_EVERY_MS;

    async function check() {
      const [run, steps] = await Promise.all([
        fetch(runUrl, { signal: stop.signal }),
        fetch(stepsUrl, { signal: stop.signal }),
      ]);
      if ((run.status >= 400 && run.status < 500) || (steps.status >= 400 && steps.status < 500)) {
        return 'gone';
      }
      if (!run.ok || !steps.ok) throw new Error('Not answered');
      const next = runSignature(await run.json(), (await steps.json()).items);
      if (next !== latest.current) {
        latest.current = next;
        router.refresh();
      }
      return 'answered';
    }

    function later() {
      timer = setTimeout(async () => {
        // Nobody is looking, so there is nothing to keep true. Coming back checks soon enough.
        if (document.visibilityState !== 'visible') return later();
        try {
          if ((await check()) === 'gone') return router.refresh();
          setLostContact(false);
          wait = CHECK_EVERY_MS;
        } catch {
          if (stop.signal.aborted) return;
          setLostContact(true);
          wait = Math.min(wait * 2, LONGEST_WAIT_MS);
        }
        later();
      }, wait);
    }

    later();
    return () => {
      stop.abort();
      clearTimeout(timer);
    };
  }, [runUrl, stepsUrl, router]);

  return (
    <p className={lostContact ? 'notice warn' : 'visually-hidden'} role="status">
      {lostContact
        ? 'We have lost contact with Ensemus, so what you see here may be out of date. The run itself is not affected. Trying again.'
        : ''}
    </p>
  );
}
