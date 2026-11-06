'use client';

import { usePathname } from 'next/navigation';
import {
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
  useEffect,
  useRef,
  useState,
} from 'react';

// A form that is refused comes back to its own page with an error in the address, and to React that is
// a new page, so everything typed into it is gone. These fields hold on to their text across that one
// move. It stays in this tab's memory, is never written to storage, and goes on reload. With JavaScript
// off they are ordinary fields. Use them only in a form that leaves the page or disappears when it
// succeeds, or the text would wait there for the next visit.
const drafts = new Map<string, { value: string; at: number }>();
const LASTS_MS = 15 * 60 * 1_000;

function useDraft(name: string) {
  const key = `${usePathname()}|${name}`;
  const [value, setValue] = useState(() => {
    const draft = drafts.get(key);
    if (!draft || Date.now() - draft.at > LASTS_MS) return '';
    draft.at = Date.now();
    return draft.value;
  });
  const change = (next: string) => {
    setValue(next);
    drafts.set(key, { value: next, at: Date.now() });
  };
  return [value, change] as const;
}

type Named = { keep: string };

export function KeptInput({
  keep,
  ...props
}: Named & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [value, change] = useDraft(keep);
  return <input {...props} value={value} onChange={(event) => change(event.target.value)} />;
}

export function KeptTextarea({
  keep,
  ...props
}: Named & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'>) {
  const [value, change] = useDraft(keep);
  const field = useRef<HTMLTextAreaElement>(null);
  // Text that came back inside a panel is no use if the panel has closed over it.
  useEffect(() => {
    if (field.current?.value) field.current.closest('details')?.setAttribute('open', '');
  }, []);
  return (
    <textarea
      {...props}
      ref={field}
      value={value}
      onChange={(event) => change(event.target.value)}
    />
  );
}
