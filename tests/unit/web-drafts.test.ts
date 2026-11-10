// A draft is held in a tab's memory for its author, for a short while. The next person in that tab must
// never get it. Run here, because the web app has no test runner of its own.
import { describe, expect, it } from 'vitest';
import { createDraftBook, DRAFT_LASTS_MS } from '../../apps/web/src/lib/drafts';

function book() {
  let now = 1_000;
  const drafts = createDraftBook(() => now);
  return { drafts, pass: (ms: number) => (now += ms) };
}

describe('drafts in a tab', () => {
  it('gives its author the text back', () => {
    const { drafts } = book();
    drafts.write('alice', '/work/1|reason', 'Half a thought');
    expect(drafts.read('alice', '/work/1|reason')).toBe('Half a thought');
  });

  it('holds any shape of draft', () => {
    const { drafts } = book();
    const draft = { title: 'A', objective: 'B' };
    drafts.write('alice', '/work/1|edit', draft);
    expect(drafts.read('alice', '/work/1|edit')).toEqual(draft);
  });

  it('never gives one person what another typed', () => {
    const { drafts } = book();
    drafts.write('alice', '/work/1|reason', 'Alice wrote this');
    expect(drafts.read('bob', '/work/1|reason')).toBeUndefined();
  });

  it('forgets everything when someone else arrives, even if the first person comes back', () => {
    const { drafts } = book();
    drafts.write('alice', '/work/1|reason', 'Alice wrote this');
    drafts.settle('bob');
    expect(drafts.held()).toBe(0);
    expect(drafts.read('alice', '/work/1|reason')).toBeUndefined();
  });

  it('forgets everything on signing out, so signing back in finds nothing', () => {
    const { drafts } = book();
    drafts.write('alice', '/work/1|reason', 'Alice wrote this');
    // The sign-in page is where signing out lands, and it belongs to nobody.
    drafts.settle(null);
    expect(drafts.held()).toBe(0);
    drafts.settle('alice');
    expect(drafts.read('alice', '/work/1|reason')).toBeUndefined();
  });

  it('forgets the address typed at sign-in once that person is in', () => {
    const { drafts } = book();
    drafts.write(null, '/sign-in|email', 'alice@example.invalid');
    expect(drafts.read(null, '/sign-in|email')).toBe('alice@example.invalid');
    drafts.settle('alice');
    drafts.settle(null);
    expect(drafts.read(null, '/sign-in|email')).toBeUndefined();
  });

  it('keeps a refused sign-in’s address for the next try', () => {
    const { drafts } = book();
    drafts.settle(null);
    drafts.write(null, '/sign-in|email', 'alice@example.invalid');
    drafts.settle(null);
    expect(drafts.read(null, '/sign-in|email')).toBe('alice@example.invalid');
  });

  it('stays through someone’s own work, whichever page they are on', () => {
    const { drafts } = book();
    drafts.settle('alice');
    drafts.write('alice', '/work/1|reason', 'Mine');
    drafts.settle('alice');
    expect(drafts.read('alice', '/work/1|reason')).toBe('Mine');
  });

  it('removes what has run out, not only skips it', () => {
    const { drafts, pass } = book();
    drafts.write('alice', '/work/1|reason', 'Old');
    drafts.write('alice', '/work/2|reason', 'Also old');
    pass(DRAFT_LASTS_MS + 1);
    expect(drafts.read('alice', '/work/1|reason')).toBeUndefined();
    expect(drafts.held()).toBe(0);
  });

  it('counts being read back as still in use', () => {
    const { drafts, pass } = book();
    drafts.write('alice', '/work/1|reason', 'Still going');
    pass(DRAFT_LASTS_MS - 1);
    expect(drafts.read('alice', '/work/1|reason')).toBe('Still going');
    pass(DRAFT_LASTS_MS - 1);
    expect(drafts.read('alice', '/work/1|reason')).toBe('Still going');
  });

  it('forgets one draft when asked', () => {
    const { drafts } = book();
    drafts.write('alice', '/work/1|edit', 'Saved now');
    drafts.write('alice', '/work/1|reason', 'Still mine');
    drafts.forget('alice', '/work/1|edit');
    expect(drafts.read('alice', '/work/1|edit')).toBeUndefined();
    expect(drafts.read('alice', '/work/1|reason')).toBe('Still mine');
  });
});
