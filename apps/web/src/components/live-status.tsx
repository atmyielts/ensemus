'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';

/**
 * Refreshes the page when this Work Unit changes. The browser reconnects on its own, resuming from
 * the last version it saw. If this never runs, the page is still correct when reloaded.
 */
export function LiveStatus({ url, version }: { url: string; version: number }) {
  const router = useRouter();
  const latest = useRef(version);
  latest.current = version;

  useEffect(() => {
    const source = new EventSource(url);
    source.addEventListener('status', (event) => {
      const next = Number((event as MessageEvent<string>).data);
      if (next > latest.current) {
        latest.current = next;
        router.refresh();
      }
    });
    return () => source.close();
  }, [url, router]);

  return null;
}
