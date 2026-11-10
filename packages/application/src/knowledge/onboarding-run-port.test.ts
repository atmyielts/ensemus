// The worker seam is not a second public start API. Actor refusals must precede any SQL access.
import { describe, expect, it } from 'vitest';
import type { TenantContext, Tx } from '@ensemus/database';
import { AppError } from '../errors';
import { assessOnboardingOutputs, createOnboardingAgentRuns } from './onboarding-run-port';

const id = '7f0c1f6e-3a39-4f5e-9d7a-3f4a0a4f1b11';
const unreachable = {} as Tx;
const port = createOnboardingAgentRuns();

describe('the onboarding run gateway boundary', () => {
  it.each(['user', 'agent', 'service'] as const)(
    'does not turn a %s context into an initiating person',
    async (actorType) => {
      const context = { actorType, role: 'owner', membershipId: id } as unknown as TenantContext;
      await expect(
        port.requestRun(unreachable, context, {
          workUnitId: id,
          agentKey: 'client-brief',
          requestKey: id,
        }),
      ).rejects.toEqual(new AppError('FORBIDDEN'));
      await expect(port.statusOf(unreachable, context, id)).rejects.toEqual(
        new AppError('FORBIDDEN'),
      );
    },
  );

  it.each([
    { workUnitId: id, agentKey: 'another-agent', requestKey: id },
    { workUnitId: id, agentKey: 'client-brief' },
    { workUnitId: id, agentKey: 'client-brief', requestKey: 'invalid' },
    { workUnitId: 'invalid', agentKey: 'client-brief', requestKey: id },
  ])('refuses an unbound or arbitrary agent request before SQL', async (input) => {
    const context = {
      actorType: 'delegated',
      role: 'owner',
      membershipId: id,
    } as unknown as TenantContext;
    await expect(port.requestRun(unreachable, context, input)).rejects.toEqual(
      new AppError('INVALID_INPUT'),
    );
  });
});

describe('complete generated-output inventory', () => {
  it.each([true, false])(
    'keeps two retained candidates ambiguous when the second is readable=%s',
    (readable) => {
      expect(
        assessOnboardingOutputs([
          { id, readable: true },
          { id: 'another-hidden-id', readable },
        ]),
      ).toEqual({ artifactState: 'ambiguous', artifactIds: [] });
    },
  );
  it('reports an unavailable sole candidate without exposing its identifier', () => {
    expect(assessOnboardingOutputs([{ id, readable: false }])).toEqual({
      artifactState: 'unavailable',
      artifactIds: [],
    });
  });
  it('distinguishes absent output from one confirmed readable candidate', () => {
    expect(assessOnboardingOutputs([])).toEqual({ artifactState: 'none', artifactIds: [] });
    expect(assessOnboardingOutputs([{ id, readable: true }])).toEqual({
      artifactState: 'ready',
      artifactIds: [id],
    });
  });
});
