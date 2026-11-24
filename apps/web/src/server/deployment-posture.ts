import 'server-only';
import { getResidencyPosture, inspectDeployment } from '@ensemus/application';
import { loadResidencyPolicy } from '@ensemus/config';
import type { AppDatabase, TenantContext } from '@ensemus/database';
import { getSovereignRuntime } from './sovereign-runtime';

export async function readDeploymentPosture(database: AppDatabase, context: TenantContext) {
  const releaseVersion =
    getSovereignRuntime().runningRelease?.version ?? process.env.ENSEMUS_RELEASE ?? null;
  const { profile, isolation } = await inspectDeployment(database, context, releaseVersion);
  const declared = loadResidencyPolicy();
  const residency = await getResidencyPosture(database, context, {
    policy: {
      ...declared,
      homeRegion: profile.homeRegion === declared.homeRegion ? profile.homeRegion : null,
    },
    sources: [],
  });
  return { profile, isolation, residency };
}
