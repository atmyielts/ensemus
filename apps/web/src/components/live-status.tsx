'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';

const FIRST_RETRY_MS = 2_000;
const LONGEST_RETRY_MS = 30_000;

/**
 * Refreshes the page when this Work Unit changes. The browser reconnects by itself when a connection
 * drops, but it gives up for good on any error answer, and an error answer is what the proxy gives
 * while web restarts. So this tries again itself, asking first whether there is still something to
 * follow: an answer that this person may not see it ends the attempts. If this never runs, the page
 * is still correct when reloaded.
 */
export function LiveStatus({ url, version }: { url: string; version: number }) {
  const router = useRouter();
  const latest = useRef(version);
  latest.current = version;

  useEffect(() => {
    let source: EventSource | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wait = FIRST_RETRY_MS;
    const stop = new AbortController();

    async function stillThere() {
      try {
        const answer = await fetch(url, { signal: stop.signal });
        await answer.body?.cancel();
        return answer.ok ? 'yes' : answer.status >= 500 ? 'not yet' : 'no';
      } catch {
        return 'not yet';
      }
    }

    function tryAgainLater() {
      timer = setTimeout(async () => {
        const answer = await stillThere();
        if (stop.signal.aborted || answer === 'no') return;
        if (answer === 'yes') connect();
        else tryAgainLater();
      }, wait);
      wait = Math.min(wait * 2, LONGEST_RETRY_MS);
    }

    function connect() {
      source = new EventSource(url);
      source.addEventListener('open', () => {
        wait = FIRST_RETRY_MS;
      });
      source.addEventListener('status', (event) => {
        const next = Number((event as MessageEvent<string>).data);
        if (next > latest.current) {
          latest.current = next;
          router.refresh();
        }
      });
      source.addEventListener('error', () => {
        if (source?.readyState === EventSource.CLOSED) tryAgainLater();
      });
    }

    connect();
    return () => {
      stop.abort();
      clearTimeout(timer);
      source?.close();
    };
  }, [url, router]);

  return null;
}
