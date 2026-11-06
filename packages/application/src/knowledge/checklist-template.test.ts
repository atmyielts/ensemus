import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CompletionCriterion } from '@ensemus/domain/work-unit';
import type { Tx, TenantContext } from '@ensemus/database';
import {
  CHECKLIST_TEMPLATE,
  completionChecklist,
  createChecklistInputInventory,
} from './checklist-template';
describe('exact authoritative completion-checklist template', () => {
  const id = randomUUID();
  it('uses only fixed criterion language and the actual Work identity', () => {
    expect(
      completionChecklist({
        id,
        completionCriteria: [{ kind: 'artifact_exists' }, { kind: 'reviewer_approved' }],
      }),
    ).toBe(
      `# Completion checklist\n\nEnsemus wrote this list. It has not checked any of this, and this file is not evidence.\nA person decides when this work is done.\n\nWork: ${id}\n\n- [ ] Someone attaches the file that shows the result.\n- [ ] A reviewer approves this work as it stands.\n`,
    );
  });
  it('retains the explicit no-evidence wording and refuses unknown stored criterion shapes', () => {
    expect(completionChecklist({ id, completionCriteria: [] })).toContain(
      'No evidence was asked for.',
    );
    expect(() =>
      completionChecklist({
        id,
        completionCriteria: [{ kind: 'unknown' } as unknown as CompletionCriterion],
      }),
    ).toThrow();
  });
  it('refuses a user, an agent run or another template before reading any row', async () => {
    const tx = new Proxy(
      {},
      {
        get() {
          throw new Error('DATABASE_TOUCHED');
        },
      },
    ) as Tx;
    const port = createChecklistInputInventory();
    for (const input of [
      { actorType: 'user', execution: { kind: 'system', id, template: CHECKLIST_TEMPLATE } },
      { actorType: 'service', execution: { kind: 'agent_run', id } },
      { actorType: 'service', execution: { kind: 'system', id, template: 'some-other-template' } },
    ] as const)
      expect(
        await port.inspectInTx(tx, { actorType: input.actorType } as TenantContext, {
          execution: input.execution,
          workUnitId: id,
          artifactSha256: 'a'.repeat(64),
        }),
      ).toEqual({ known: false });
  });
});
