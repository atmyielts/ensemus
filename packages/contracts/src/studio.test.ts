import { describe, expect, it } from 'vitest';
import {
  processGraphSchema,
  processSpecSchema,
  requestPublishReviewSchema,
  createAgentDraftSchema,
} from './studio';
const id = 'E6F6B4C3-6C7F-42F7-9612-BBFAAF6DB747';
describe('Studio immutable and identity contracts', () => {
  it('canonicalizes path-independent record references before binding a review or graph', () => {
    expect(
      requestPublishReviewSchema.parse({
        subject_kind: 'agent_draft',
        subject_id: id,
        simulation_run_id: id,
      }).subject_id,
    ).toBe(id.toLowerCase());
    expect(
      processGraphSchema.parse({
        schemaVersion: 1,
        nodes: [
          { id: 'agent', kind: 'agent_task', label: 'Prepare', x: 0, y: 0, agentDefinitionId: id },
        ],
        edges: [],
      }).nodes[0]?.agentDefinitionId,
    ).toBe(id.toLowerCase());
  });
  it('refuses stored executable inputs with unknown grants, fields or step kinds', () => {
    const spec = {
      schemaVersion: 1,
      classification: 'internal',
      steps: [{ key: 'prepare', kind: 'work_item', after: [], labelCode: null, label: 'Prepare' }],
    };
    expect(processSpecSchema.safeParse(spec).success).toBe(true);
    expect(processSpecSchema.safeParse({ ...spec, execute: true }).success).toBe(false);
    expect(
      processSpecSchema.safeParse({
        ...spec,
        steps: [{ ...spec.steps[0], kind: 'arbitrary_http' }],
      }).success,
    ).toBe(false);
    expect(
      createAgentDraftSchema.safeParse({ name: 'Generated draft', answers: {}, session_id: id })
        .success,
    ).toBe(false);
  });
});
