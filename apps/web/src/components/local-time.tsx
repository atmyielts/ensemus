'use client';

// A moment, shown in the reader's own time zone. The server cannot know that zone, so it renders the UTC
// wording, which is also what a page without JavaScript keeps; the browser then swaps in local time
// without a hydration mismatch. The exact UTC moment stays in the title and the datetime attribute.
import { useSyncExternalStore } from 'react';

const utcFormat = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});

const subscribe = () => () => {};

function localText(iso: string) {
  const value = new Date(iso);
  const now = new Date();
  const sameYear = value.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
  }).format(value);
}

export const utcText = (value: Date) => `${utcFormat.format(value)} UTC`;

export function LocalTime({ iso }: { iso: string }) {
  const utc = utcText(new Date(iso));
  const text = useSyncExternalStore(
    subscribe,
    () => localText(iso),
    () => utc,
  );
  return (
    <time dateTime={iso} title={utc}>
      {text}
    </time>
  );
}
