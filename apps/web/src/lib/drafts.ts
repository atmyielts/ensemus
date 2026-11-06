// What someone has typed and not sent, held for them in this tab's memory for a short while. It is
// never written to storage, and it goes on reload. A tab can pass from one person to the next, because
// signing out and in does not reload the page, so a draft belongs to one account, and when the tab
// belongs to anyone else, nobody signed in included, all of it is forgotten.

export const DRAFT_LASTS_MS = 15 * 60 * 1_000;

/** Who the tab belongs to now: an account's ID, or null when nobody is signed in. */
export type DraftAccount = string | null;

export function createDraftBook(clock: () => number = Date.now) {
  const drafts = new Map<string, { value: unknown; at: number }>();
  let holder: DraftAccount = null;
  const keyOf = (account: DraftAccount, name: string) => `${account ?? ''}|${name}`;

  function settle(account: DraftAccount) {
    if (account === holder) return;
    drafts.clear();
    holder = account;
  }

  function sweep() {
    const now = clock();
    for (const [key, draft] of drafts) {
      if (now - draft.at > DRAFT_LASTS_MS) drafts.delete(key);
    }
  }

  return {
    settle,
    read<T>(account: DraftAccount, name: string): T | undefined {
      settle(account);
      sweep();
      const draft = drafts.get(keyOf(account, name));
      if (!draft) return undefined;
      draft.at = clock();
      return draft.value as T;
    },
    write(account: DraftAccount, name: string, value: unknown) {
      settle(account);
      drafts.set(keyOf(account, name), { value, at: clock() });
    },
    forget(account: DraftAccount, name: string) {
      drafts.delete(keyOf(account, name));
    },
    held: () => drafts.size,
  };
}
