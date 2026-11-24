import { describe, expect, it } from 'vitest';
import { statusOn } from '../helpers/rendered-status';

describe('rendered work status across releases', () => {
  it('reads the original badge markup', () => {
    expect(
      statusOn('<dt>Status</dt><dd><span class="badge attention">Waiting for approval</span></dd>'),
    ).toBe('Waiting for approval');
  });

  it('reads the current shadcn badge without requiring a class order', () => {
    const html =
      '<dt>Status</dt>\n<dd><span data-slot="badge" class="inline-flex badge">Checking</span></dd>';
    expect(statusOn(html)).toBe('Checking');
  });

  it('does not substitute an unrelated badge for the visible status definition', () => {
    expect(statusOn('<dt>Due</dt><dd><span class="badge bad">Overdue</span></dd>')).toBeUndefined();
  });
});
