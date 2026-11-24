// Which sentence the work pages say, kept apart from the pages so each choice can be tested.
import {
  MAX_FILE_BYTES,
  unmetCriteria,
  type CompletionCriterion,
  type CompletionEvidence,
  type WorkState,
} from '@ensemus/domain/work-unit';
import { FILE_TOO_LARGE } from './messages';

/** Who actually does the work, in words true of where it stands now. Null when a notice covers it. */
export function planNote(
  status: WorkState,
  plan: { hasPlan: boolean; planHolds: boolean; runRequested: boolean },
): string | null {
  if (!plan.hasPlan) return 'People do this work and update its status.';
  if (plan.planHolds) {
    return 'The plan is running. It does not mark this work done: a person does that once the evidence is in place.';
  }
  switch (status) {
    case 'queued':
      return 'A plan is attached. It only starts when someone presses Run the plan.';
    case 'ready':
      return plan.runRequested
        ? null
        : 'A plan is attached. It only starts when someone presses Run the plan.';
    case 'blocked':
      return 'A plan is attached. It can only start once this is ready again.';
    case 'running':
      return 'A plan is attached, but this was started by hand, so people do this work and update its status.';
    default:
      return 'A plan is attached, and it does not mark work done. A person does that once the evidence is in place.';
  }
}

/** The one line under Home's greeting: how much needs this person, in words, never "0 things". */
export function homeSummary(facts: {
  needsYou: number;
  moreNeedYou: boolean;
  onWork: boolean;
}): string {
  if (facts.needsYou === 0) {
    return facts.onWork
      ? 'Nothing needs you right now. Here is what you are on.'
      : 'Nothing is waiting for you yet.';
  }
  if (facts.moreNeedYou) return `More than ${facts.needsYou} things need you today.`;
  return facts.needsYou === 1
    ? 'One thing needs you today.'
    : `${facts.needsYou} things need you today.`;
}

/** What Home says under Your work. It only says everything is listed when nothing was left out. */
export function homeListNotes(facts: {
  shown: boolean;
  workHasMore: boolean;
  attentionHasMore: boolean;
}): { allListed: string | null; more: string | null } {
  if (facts.workHasMore || facts.attentionHasMore) {
    return {
      allListed: null,
      more: facts.shown
        ? 'These are the most urgent.'
        : 'The most urgent are listed above, and there is more.',
    };
  }
  return { allListed: facts.shown ? null : 'Everything you are on is listed above.', more: null };
}

/** What "done" means for a piece of work, as one plain sentence. */
export function doneWhenSentence(criteria: readonly CompletionCriterion[]): string {
  if (criteria.length === 0) return 'Owner confirms';
  const parts = criteria.map((criterion) => DONE_WHEN[criterion.kind]);
  const joined =
    parts.length === 1
      ? (parts[0] ?? '')
      : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

const DONE_WHEN: Record<CompletionCriterion['kind'], string> = {
  artifact_exists: 'a file is attached',
  reviewer_approved: 'a reviewer approves',
  external_receipt: 'the outside system confirms it',
};

/** How a work list says where its "done when" checks stand, by the same rule the work's page uses. */
export function evidenceSummary(
  status: WorkState,
  criteria: readonly CompletionCriterion[],
  evidence: CompletionEvidence,
): { text: string; tone: 'attention' | 'done' | null } {
  if (criteria.length === 0) return { text: 'Owner confirms', tone: null };
  // A review can run out after the work is done. Finishing needed the evidence, so it was there then.
  if (status === 'completed') return { text: 'Met when done', tone: 'done' };
  const missing = unmetCriteria(criteria, evidence).length;
  return missing === 0
    ? { text: 'In place', tone: 'done' }
    : { text: `${missing} of ${criteria.length} still needed`, tone: 'attention' };
}

/**
 * The name of the draft for why finished work should go round again. It belongs to this arrival at
 * this status, so text sent earlier is never offered as the next decision, and it stays the same while
 * only other things change, so a refused reopen keeps what was typed.
 */
export function reopenDraftName(
  status: WorkState,
  history: ReadonlyArray<{ id: string; toStatus: string }>,
  version: number,
): string {
  const arrival = history.find((entry) => entry.toStatus === status);
  return arrival ? `reopen-${arrival.id}` : `reopen-v${version}`;
}

/** Why the browser will not send this file, or null when it can. */
export function fileRefusal(size: number): string | null {
  return size > MAX_FILE_BYTES ? FILE_TOO_LARGE : null;
}
