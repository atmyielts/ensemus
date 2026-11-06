// The edit form decides from this whether someone else changed the work. The service trims what it
// saves, so a difference only in surrounding spaces is the person's own save coming back.
import { describe, expect, it } from 'vitest';
import { sameContent } from '../../apps/web/src/lib/form-state';

const saved = { title: 'Launch', objective: 'Ship it', dueAt: '2030-01-01' };

describe('whether two versions of a draft say the same thing', () => {
  it.each([
    ['a title with a trailing space', { ...saved, title: 'Launch ' }],
    ['an objective ending in a newline', { ...saved, objective: 'Ship it\n' }],
    ['both, with spaces in front', { ...saved, title: '  Launch', objective: '\t Ship it' }],
  ])('treats %s as what was saved', (_, draft) => {
    expect(sameContent(draft, saved)).toBe(true);
    expect(sameContent(saved, draft)).toBe(true);
  });

  it.each([
    ['a different title', { ...saved, title: 'Launched' }],
    ['a different objective', { ...saved, objective: 'Ship it now' }],
    ['a different date', { ...saved, dueAt: '2030-01-02' }],
    ['spaces inside the text', { ...saved, title: 'Lau nch' }],
  ])('notices %s', (_, draft) => {
    expect(sameContent(draft, saved)).toBe(false);
  });
});
