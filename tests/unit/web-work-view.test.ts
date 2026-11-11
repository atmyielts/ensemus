// The sentences the work pages choose between. Run here, because the web app has no test runner of its
// own. The pages themselves are read in tests/stack/pages.test.ts.
import type { CompletionCriterion } from '@ensemus/domain/work-unit';
import { MAX_FILE_BYTES } from '@ensemus/domain/work-unit';
import { describe, expect, it } from 'vitest';
import { messageFor } from '../../apps/web/src/lib/messages';
import {
  doneWhenSentence,
  evidenceSummary,
  fileRefusal,
  homeListNotes,
  homeSummary,
  planNote,
  reopenDraftName,
} from '../../apps/web/src/lib/work-view';

const PRESS_TO_START = 'A plan is attached. It only starts when someone presses Run the plan.';
const nothing = { artifactCount: 0, approvedReviewCount: 0, verifiedReceiptCount: 0 };
const file: CompletionCriterion = { kind: 'artifact_exists' };
const review: CompletionCriterion = { kind: 'reviewer_approved' };

describe('the sentence about a plan', () => {
  const plan = { hasPlan: true, planHolds: false, runRequested: false };

  it.each(['queued', 'ready'] as const)('says how it starts while %s', (status) => {
    expect(planNote(status, plan)).toBe(PRESS_TO_START);
  });

  it('leaves it to the notice once someone has asked it to run', () => {
    expect(planNote('ready', { ...plan, runRequested: true })).toBeNull();
  });

  it.each(['running', 'blocked', 'verifying'] as const)(
    'does not say it still has to be started while %s',
    (status) => {
      expect(planNote(status, plan)).not.toContain('Run the plan');
      expect(planNote(status, { ...plan, planHolds: true })).not.toContain('Run the plan');
    },
  );

  it('says the plan is running while it is', () => {
    expect(planNote('running', { ...plan, planHolds: true })).toContain('The plan is running');
    expect(planNote('running', plan)).toContain('started by hand');
  });

  it('says people do the work when there is no plan', () => {
    expect(planNote('running', { ...plan, hasPlan: false })).toBe(
      'People do this work and update its status.',
    );
  });
});

describe('the notes under Your work on Home', () => {
  const none = { shown: false, workHasMore: false, attentionHasMore: false };

  it('says everything is listed above only when it is', () => {
    expect(homeListNotes(none)).toEqual({
      allListed: 'Everything you are on is listed above.',
      more: null,
    });
  });

  it.each([
    ['more work', { ...none, workHasMore: true }],
    ['more needing attention', { ...none, attentionHasMore: true }],
  ])('does not say so when there is %s', (_, facts) => {
    const notes = homeListNotes(facts);
    expect(notes.allListed).toBeNull();
    expect(notes.more).toContain('there is more');
  });

  it('calls what it shows the most urgent, when it shows some and there is more', () => {
    expect(homeListNotes({ ...none, shown: true, workHasMore: true })).toEqual({
      allListed: null,
      more: 'These are the most urgent.',
    });
  });

  it('says nothing extra when the list is simply all there', () => {
    expect(homeListNotes({ ...none, shown: true })).toEqual({ allListed: null, more: null });
  });
});

describe('the line under the greeting on Home', () => {
  it('counts what needs this person, in words', () => {
    expect(homeSummary({ needsYou: 1, moreNeedYou: false, onWork: true })).toBe(
      'One thing needs you today.',
    );
    expect(homeSummary({ needsYou: 3, moreNeedYou: false, onWork: true })).toBe(
      '3 things need you today.',
    );
  });

  it('does not give an exact count when there is more than it shows', () => {
    expect(homeSummary({ needsYou: 12, moreNeedYou: true, onWork: true })).toBe(
      'More than 12 things need you today.',
    );
  });

  it('never says nothing is waiting to someone who is on work', () => {
    expect(homeSummary({ needsYou: 0, moreNeedYou: false, onWork: true })).toBe(
      'Nothing needs you right now. Here is what you are on.',
    );
    expect(homeSummary({ needsYou: 0, moreNeedYou: false, onWork: false })).toBe(
      'Nothing is waiting for you yet.',
    );
  });
});

describe('what done means, in one sentence', () => {
  it('is the owner’s word when nothing was asked for', () => {
    expect(doneWhenSentence([])).toBe('Owner confirms');
  });

  it('names each check, joined as a sentence', () => {
    expect(doneWhenSentence([file])).toBe('A file is attached');
    expect(doneWhenSentence([file, review])).toBe('A file is attached and a reviewer approves');
    expect(doneWhenSentence([file, review, { kind: 'external_receipt' }])).toBe(
      'A file is attached, a reviewer approves and the outside system confirms it',
    );
  });
});

describe('evidence in a work list', () => {
  it('says the owner confirms when nothing was asked for', () => {
    expect(evidenceSummary('running', [], nothing)).toEqual({ text: 'Owner confirms', tone: null });
  });

  it('counts what is still needed', () => {
    expect(evidenceSummary('running', [file, review], { ...nothing, artifactCount: 1 })).toEqual({
      text: '1 of 2 still needed',
      tone: 'attention',
    });
    expect(evidenceSummary('verifying', [file], nothing)).toEqual({
      text: '1 of 1 still needed',
      tone: 'attention',
    });
  });

  it('says when it is all in place', () => {
    expect(evidenceSummary('verifying', [file], { ...nothing, artifactCount: 1 })).toEqual({
      text: 'In place',
      tone: 'done',
    });
  });

  it('does not say finished work still needs something after a review has run out', () => {
    expect(evidenceSummary('completed', [review], nothing)).toEqual({
      text: 'Met when done',
      tone: 'done',
    });
  });
});

describe('which draft a reason belongs to', () => {
  const history = [
    { id: 'third', toStatus: 'failed' },
    { id: 'second', toStatus: 'running' },
    { id: 'first', toStatus: 'failed' },
  ];

  it('is tied to the latest time the work arrived at this status', () => {
    expect(reopenDraftName('failed', history, 7)).toBe('reopen-third');
  });

  it('starts empty after the work has been round again', () => {
    const before = reopenDraftName('failed', history.slice(2), 3);
    expect(reopenDraftName('failed', history, 7)).not.toBe(before);
  });

  it('stays the same while something else about the work changes', () => {
    expect(reopenDraftName('failed', history, 8)).toBe(reopenDraftName('failed', history, 9));
  });

  it('keeps the two questions apart', () => {
    const done = [{ id: 'fourth', toStatus: 'completed' }, ...history];
    expect(reopenDraftName('completed', done, 9)).not.toBe(reopenDraftName('failed', done, 9));
  });

  it('falls back on the version when the history does not say', () => {
    expect(reopenDraftName('completed', [], 4)).toBe('reopen-v4');
  });
});

describe('a file over the limit', () => {
  it('is refused in the browser in words that name the limit', () => {
    expect(fileRefusal(MAX_FILE_BYTES + 1)).toContain('25 MB');
    expect(fileRefusal(30 * 1024 * 1024)).toContain('25 MB');
  });

  it('is not refused at the limit', () => {
    expect(fileRefusal(MAX_FILE_BYTES)).toBeNull();
    expect(fileRefusal(1)).toBeNull();
  });

  it('gets the same words from the server', () => {
    expect(messageFor('FILE_TOO_LARGE')).toBe(fileRefusal(MAX_FILE_BYTES + 1));
  });
});
