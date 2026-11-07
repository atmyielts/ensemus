import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  approveModelWorkloadBodySchema,
  requestModelQualificationBodySchema,
} from '@ensemus/contracts/knowledge-models';
import {
  qualificationFromForm,
  qualificationState,
  workloadFromForm,
  workloadState,
} from '../../apps/web/src/app/o/[organizationId]/settings/models/workload-form';

const bounds = {
  max_calls: 1,
  max_input_tokens: 100,
  max_output_tokens: 10,
  max_total_tokens: 110,
  max_cost_micros: 0,
  timeout_seconds: 30,
};
const qualification = () => ({
  expected_profile_version: 3,
  purpose: 'embed',
  dimension: 8,
  vector_space_version: 'generated-space-v2',
  request_key: randomUUID(),
  bounds,
});
function form() {
  const f = new FormData();
  for (const [k, v] of Object.entries({
    profileId: randomUUID(),
    version: '3',
    purpose: 'embed',
    dimension: '8',
    vectorSpaceVersion: 'generated-space-v2',
    requestKey: randomUUID(),
    maxCalls: '1',
    maxInputTokens: '100',
    maxOutputTokens: '10',
    maxTotalTokens: '110',
    maxCostMicros: '0',
    timeoutSeconds: '30',
  }))
    f.set(k, v);
  return f;
}
describe('native model authority forms and HTTP metadata contracts', () => {
  it('requires an explicit zero cost ceiling rather than treating a blank as zero', () => {
    const f = form();
    expect(qualificationFromForm(f).bounds.maxCostMicros).toBe(0);
    f.set('maxCostMicros', '');
    expect(() => qualificationFromForm(f)).toThrow();
  });
  it.each(['12junk', '1e3', '1.5', '-1', '9007199254740992'])(
    'refuses ambiguous or unsafe integer %s before creating authority',
    (value) => {
      const f = form();
      f.set('maxTotalTokens', value);
      expect(() => qualificationFromForm(f)).toThrow();
    },
  );
  it('pins embedding protocol inputs and refuses a dimensionless or multi-call qualification', () => {
    expect(requestModelQualificationBodySchema.parse(qualification())).toMatchObject({
      expectedProfileVersion: 3,
      dimension: 8,
    });
    for (const change of [
      { dimension: null },
      { vector_space_version: null },
      { purpose: 'answer' },
      { bounds: { ...bounds, max_calls: 2 } },
    ])
      expect(
        requestModelQualificationBodySchema.safeParse({ ...qualification(), ...change }).success,
      ).toBe(false);
    expect(
      requestModelQualificationBodySchema.safeParse({
        ...qualification(),
        purpose: 'rerank',
        dimension: null,
        vector_space_version: null,
      }).success,
    ).toBe(true);
  });
  it('cannot accept a browser identity, proof, result, protocol or active flag as authority', () => {
    for (const field of ['session_id', 'mfa_verified', 'admission', 'protocol', 'state', 'active'])
      expect(
        requestModelQualificationBodySchema.safeParse({ ...qualification(), [field]: true })
          .success,
      ).toBe(false);
  });
  it('requires exact indexing scope and explicit expiry, class and evidence', () => {
    const body = {
      kind: 'document_embed',
      scope: 'source',
      source_id: randomUUID(),
      connection_id: null,
      purposes: ['embed'],
      qualification_ids: [randomUUID()],
      max_classification: 'internal',
      bounds,
      expires_at: new Date(Date.now() + 60000).toISOString(),
      request_key: randomUUID(),
    };
    expect(approveModelWorkloadBodySchema.safeParse(body).success).toBe(true);
    for (const change of [
      { scope: 'organization' },
      { source_id: null },
      { connection_id: randomUUID() },
      { expires_at: '' },
      { qualification_ids: [] },
      { max_classification: '' },
      { bounds: { ...bounds, max_total_tokens: 1 } },
    ])
      expect(approveModelWorkloadBodySchema.safeParse({ ...body, ...change }).success).toBe(false);
    const f = form();
    expect(() => workloadFromForm(f)).toThrow();
  });
  it('gives unknown paid outcomes precedence over failed or completed presentation', () => {
    expect(
      qualificationState({
        state: 'failed',
        current: true,
        usable: false,
        job: { id: randomUUID(), state: 'refused', code: 'OUTCOME_UNKNOWN', unknownOutcome: true },
      }),
    ).toMatchObject({ label: 'Outcome unknown' });
    expect(
      qualificationState({ state: 'passed', current: false, usable: false, job: null }).label,
    ).toBe('Earlier profile version');
    expect(
      qualificationState({ state: 'requested', current: true, usable: false, job: null }).label,
    ).toBe('Queued');
  });
  it('never presents expired, revoked or stale evidence as usable approval', () => {
    const base = {
      revokedAt: null,
      expiresAt: new Date(2000).toISOString(),
      qualifications: [{ id: randomUUID(), usable: true }],
    };
    expect(workloadState(base, 1000)).toBe('Approved within limits');
    expect(workloadState(base, 2000)).toBe('Expired');
    expect(workloadState({ ...base, revokedAt: new Date(500).toISOString() }, 1000)).toBe(
      'Revoked',
    );
    expect(
      workloadState({ ...base, qualifications: [{ id: randomUUID(), usable: false }] }, 1000),
    ).toBe('Model evidence unavailable');
  });
});
