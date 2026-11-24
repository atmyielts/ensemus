import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { MarketplaceInstallFinish, MarketplaceInstallStep } from '@ensemus/workflows/schemas';
import { capturing, withCaptureWorkers } from './capture-support';

describe.skipIf(!capturing)('capture marketplace installation outcomes', () => {
  it('records installation, review denial and verification rejection', async () => {
    let scenario: 'installed' | 'failed-attestation' | 'failed-verification' = 'installed';
    await withCaptureWorkers(
      {
        queues: ['marketplace-install-replay'],
        activities: {
          materializeListing: async (): Promise<MarketplaceInstallStep> =>
            scenario === 'failed-attestation'
              ? { step: 'failed', code: 'ATTESTATION_INVALID' }
              : { step: 'verify', skillVersionId: randomUUID() },
          checkSkillBundle: async () => ({
            step: 'finished',
            outcome: scenario === 'installed' ? 'verified' : 'rejected',
          }),
          finishListingInstall: async ({ outcome }: MarketplaceInstallFinish) => {
            if (scenario === 'installed') {
              expect(outcome).toEqual({ ok: true });
              return 'installed';
            }
            expect(outcome).toEqual({
              ok: false,
              code:
                scenario === 'failed-attestation' ? 'ATTESTATION_INVALID' : 'VERIFICATION_REJECTED',
            });
            return 'failed';
          },
        },
      },
      async (run) => {
        for (const name of ['installed', 'failed-attestation', 'failed-verification'] as const) {
          scenario = name;
          await run.record('marketplace-install-' + name, {
            workflowType: 'marketplaceInstallWorkflow',
            args: [{ organizationId: randomUUID(), installationId: randomUUID() }],
            afterStart: async (workflow) => {
              expect(await workflow.result()).toBe(name === 'installed' ? 'installed' : 'failed');
            },
          });
        }
      },
    );
  }, 120_000);
});
