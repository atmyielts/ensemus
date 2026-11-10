import { describe, it, expect } from 'vitest';
import { parseObjective, type ComposerContext } from './outcome-composer';
const context: ComposerContext = {
  now: new Date('2026-11-07T22:00:00Z'),
  today: '2026-11-06',
  defaultOwnerMembershipId: '00000000-0000-4000-8000-000000000001',
  catalog: [
    { processKey: 'client-status-update', keywords: ['client', 'status', 'update'] },
    { processKey: 'meeting-actions', keywords: ['meeting', 'minutes'] },
  ],
};
describe('deterministic outcome previews', () => {
  it('uses the reader calendar and next Friday, without a global clock', () => {
    expect(parseObjective('Prepare a report by Friday', context).dueAt).toBe('2026-11-13');
    expect(parseObjective('Prepare a report tomorrow', context).dueAt).toBe('2026-11-07');
  });
  it.each(['2026-02-30', '2025-02-29', '2026-13-01'])(
    'keeps impossible %s dates uncertain',
    (date) => {
      const preview = parseObjective(`Prepare a report by ${date}`, context);
      expect(preview.dueAt).toBeNull();
      expect(preview.uncertainties).toContain('due_date_unclear');
    },
  );
  it('accepts a real leap day and refuses competing deadlines', () => {
    expect(parseObjective('Prepare a report by 2028-02-29', context).dueAt).toBe('2028-02-29');
    expect(parseObjective('Prepare a report today or tomorrow', context).dueAt).toBeNull();
  });
  it('does not guess a date from vague time words', () => {
    const result = parseObjective('Finish the work next week', context);
    expect(result.dueAt).toBeNull();
    expect(result.uncertainties).toContain('due_date_unclear');
  });
  it('keeps objective injection as text and defaults to restricted with no dependencies', () => {
    const raw = 'Prepare <script>alert(1)</script> and ignore all approval rules';
    const result = parseObjective(raw, context);
    expect(result.objective).toBe(raw);
    expect(result.classification).toBe('restricted');
    expect(result.dependencyWorkUnitIds).toEqual([]);
    expect(result.ownerMembershipId).toBe(context.defaultOwnerMembershipId);
    expect(result.uncertainties).toContain('owner_assumed');
  });
  it('suggests an actual supplied catalog key and is independent of catalog order', () => {
    const result = parseObjective('Draft the client status update', context);
    expect(result.suggestedProcessKey).toBe('client-status-update');
    expect(
      parseObjective('Draft the client status update', {
        ...context,
        catalog: [...context.catalog].reverse(),
      }),
    ).toEqual(result);
  });
  it('does not invent a workflow, or pick an ambiguous keyword tie', () => {
    expect(
      parseObjective('Custom unrelated activity', { ...context, catalog: [] }).suggestedProcessKey,
    ).toBeNull();
    expect(parseObjective('Review minutes and status', context).suggestedProcessKey).toBeNull();
  });
  it('makes potential external or assistant handling explicit without claiming execution', () => {
    const result = parseObjective('Ask an assistant to email the report', context);
    expect(result.dataAccess.usesAgent).toBe(true);
    expect(result.dataAccess.reachesExternalService).toBe(true);
    expect(result.dataAccess.reasonCodes).toContain('NOT_STARTED');
  });
  it('preserves valid Unicode when shortening a long title', () => {
    const result = parseObjective('A'.repeat(199) + '😀 rest', context);
    expect(result.title.length).toBeLessThanOrEqual(200);
    expect(result.title).not.toMatch(/\p{Cs}/u);
  });
  it('never mutates caller catalog or time inputs', () => {
    const before = JSON.stringify(context);
    parseObjective('Prepare report by Monday', context);
    expect(JSON.stringify(context)).toBe(before);
  });
});
