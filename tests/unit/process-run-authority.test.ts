import { describe, expect, it } from 'vitest';
import { assertProcessInventory } from '../../packages/application/src/product/process-run-authority';
import type { ProcessSpec } from '@ensemus/domain/process-spec';
const spec: Pick<ProcessSpec, 'steps'> = {
  steps: [
    { key: 'first', kind: 'work_item', label: 'First', after: [] },
    { key: 'second', kind: 'work_item', label: 'Second', after: ['first'] },
  ],
};
describe('actual workflow inventory', () => {
  it.each(
    [
      [],
      [{ stepKey: 'first' }],
      [{ stepKey: 'first' }, { stepKey: 'first' }],
      [{ stepKey: 'first' }, { stepKey: 'foreign' }],
      [{ stepKey: 'first' }, { stepKey: 'second' }, { stepKey: 'extra' }],
    ].map((rows) => ({ rows })),
  )('refuses incomplete, duplicate or foreign rows', ({ rows }) => {
    expect(() => assertProcessInventory(spec, rows)).toThrowError(
      expect.objectContaining({ code: 'CAPABILITY_UNAVAILABLE' }),
    );
  });
  it('refuses an empty or duplicate-key manifest', () => {
    expect(() => assertProcessInventory({ steps: [] }, [])).toThrow();
    expect(() =>
      assertProcessInventory({ steps: [spec.steps[0]!, spec.steps[0]!] }, [
        { stepKey: 'first' },
        { stepKey: 'first' },
      ]),
    ).toThrow();
  });
  it('accepts the complete unordered actual inventory', () => {
    expect(() =>
      assertProcessInventory(spec, [{ stepKey: 'second' }, { stepKey: 'first' }]),
    ).not.toThrow();
  });
});
