import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  actionHash,
  canonicalJson,
  workReviewAction,
  workReviewActionFromContentHash,
} from './approval';

describe('body-free terminal review identity', () => {
  it.each([
    { title: 'Generated Work', objective: null },
    { title: 'Quotes " and \\ and\nnewlines', objective: '' },
    { title: 'Клиент — mijoz 🧭', objective: 'Non-ASCII\tcontent' },
  ])('preserves the exact existing action hash for $title', (body) => {
    const id = '00000000-0000-4000-8000-000000000101';
    const files = ['00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000102'];
    const contentHash = createHash('sha256')
      .update(canonicalJson({ title: body.title, objective: body.objective ?? '' }))
      .digest('hex');
    expect(actionHash(workReviewActionFromContentHash(id, contentHash, files))).toBe(
      actionHash(workReviewAction({ id, ...body }, files)),
    );
    expect(files[0]).toBe('00000000-0000-4000-8000-000000000103');
  });
  it('binds actual content and visible file identities without accepting an absent hash', () => {
    const id = '00000000-0000-4000-8000-000000000101';
    const original = workReviewActionFromContentHash(id, 'a'.repeat(64), []);
    expect(actionHash(workReviewActionFromContentHash(id, 'b'.repeat(64), []))).not.toBe(
      actionHash(original),
    );
    expect(
      actionHash(
        workReviewActionFromContentHash(id, 'a'.repeat(64), [
          '00000000-0000-4000-8000-000000000102',
        ]),
      ),
    ).not.toBe(actionHash(original));
    expect(() => workReviewActionFromContentHash(id, '', [])).toThrow('WORK_REVIEW_HASH_INVALID');
  });
});
