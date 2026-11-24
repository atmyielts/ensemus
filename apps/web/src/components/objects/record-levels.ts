import type { DescribedChoice } from '../knowledge-view';

/** What each level means for a custom record. It matches who may read one (canReadRecord). */
const MEANING: Record<string, { label: string; description: string }> = {
  public: {
    label: 'Public',
    description: 'Everyone in the company, and fine to share outside it.',
  },
  internal: { label: 'Internal', description: 'Everyone in the company.' },
  confidential: {
    label: 'Confidential',
    description: 'The person who owns the record and the company’s administrators.',
  },
  restricted: { label: 'Restricted', description: 'Only the person who owns the record.' },
};

/** The levels a record may take, from the most open to the most private. */
export function recordLevelChoices(levels: readonly string[]): DescribedChoice[] {
  return levels.map((value) => ({
    value,
    label: MEANING[value]?.label ?? value,
    description: MEANING[value]?.description ?? '',
  }));
}

/** A level's plain name, such as "Confidential". */
export const levelName = (value: string) => MEANING[value]?.label ?? value;
