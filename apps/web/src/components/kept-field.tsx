'use client';

import { usePathname } from 'next/navigation';
import {
  createContext,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createDraftBook, type DraftAccount } from '@/lib/drafts';

// A form that is refused comes back to its own page with an error in the address, and to React that is
// a new page, so everything typed into it is gone. These fields hold on to their text across that one
// move, for the person who typed it (see lib/drafts). With JavaScript off they are ordinary fields. Use
// them only in a form that leaves the page or disappears when it succeeds, and give a form that can
// come back a name of its own each time, or the text would wait there for the next visit.
const book = createDraftBook();

const Account = createContext<DraftAccount>(null);

/**
 * Says whose this part of the app is. Drafts for anyone else are forgotten as it renders, so a page
 * with no fields of its own still clears the tab for whoever comes next. Outside any scope, which is
 * where signing out lands, nobody is signed in. A page whose fields hold drafts sets one of its own,
 * because a shared layout is not rendered again when the session changes under an open tab.
 */
export function DraftScope({ account, children }: { account: string; children: ReactNode }) {
  book.settle(account);
  return <Account.Provider value={account}>{children}</Account.Provider>;
}

/** One draft on this page, for whoever is signed in. */
export function useKept<T>(name: string) {
  const account = useContext(Account);
  const key = `${usePathname()}|${name}`;
  return useMemo(
    () => ({
      read: () => book.read<T>(account, key),
      write: (value: T) => book.write(account, key, value),
      forget: () => book.forget(account, key),
    }),
    [account, key],
  );
}

function useDraft(name: string) {
  const kept = useKept<string>(name);
  const [value, setValue] = useState(() => kept.read() ?? '');
  const change = (next: string) => {
    setValue(next);
    kept.write(next);
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
