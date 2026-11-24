import { AppError, listResidencyRequirements } from '@ensemus/application';
import { hasRecentMfa } from '@ensemus/application/privileged';
import { interactiveSessionOf } from '@ensemus/database';
import type { IsolationAspect, IsolationAspectPosture } from '@ensemus/domain/tenancy';
import type { ResidencySurface, SurfacePosture } from '@ensemus/domain/residency';
import { notFound } from 'next/navigation';
import { formatDateTime, PageHead } from '@/components/ui';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { readDeploymentPosture } from '@/server/deployment-posture';
import { requireTenant } from '@/server/tenant';
import { ResidencyRequirements } from './residency-requirements';

export const metadata = { title: 'Deployment posture | Ensemus' };

const ASPECT_LABELS: Record<IsolationAspect, string> = {
  database: 'Database',
  network: 'Network',
  worker_pool: 'Worker pool',
  temporal_namespace: 'Workflow namespace',
  object_store: 'File storage',
  backups: 'Backups',
  embeddings: 'Embeddings',
  telemetry: 'Telemetry',
  key_encryption_key: 'Key encryption key',
};
const ISOLATION_LABELS: Record<IsolationAspectPosture['state'], string> = {
  passed: 'Passed on this release',
  failed: 'Failed on this release',
  declared: 'Declared by the operator',
  unchecked: 'Unchecked',
  stale: 'Release evidence unavailable',
};
const SURFACE_LABELS: Record<ResidencySurface, string> = {
  storage: 'Storage',
  backups: 'Backups',
  support: 'Support access',
  embeddings: 'Embeddings',
  inference: 'Model inference',
  telemetry: 'Telemetry',
};
const RESIDENCY_LABELS: Record<SurfacePosture['state'], string> = {
  declared_in_region: 'Declared in the home region',
  declared_elsewhere: 'Includes other regions',
  undeclared: 'Region unconfirmed',
};

export default async function DeploymentPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ residencyError?: string; residencySaved?: string }>;
}) {
  const { organizationId } = await params;
  const { database, context } = await requireTenant(organizationId);
  const { profile, isolation, residency } = await readDeploymentPosture(database, context).catch(
    (error) => {
      if (error instanceof AppError && error.code === 'NOT_FOUND') notFound();
      throw error;
    },
  );
  const [requirements, query] = await Promise.all([
    listResidencyRequirements(database, context),
    searchParams,
  ]);
  const owner = context.role === 'owner';
  const ready =
    owner && (residency.homeRegion !== null || requirements.length > 0)
      ? await hasRecentMfa(database, context, 'organization.manage', interactiveSessionOf(context))
      : false;
  return (
    <>
      <PageHead
        title="Deployment posture"
        description="Review isolation checks and where the operator declares data is handled."
      />
      <div className="stack">
        <Card asChild>
          <section className="card" aria-labelledby="isolation-heading">
            <h2 id="isolation-heading">Isolation checks</h2>
            <p>{profile.tier === 'dedicated' ? 'Dedicated deployment' : 'Shared deployment'}</p>
            {isolation.isolated && (
              <p>
                Isolation checks passed for this release, with declarations for the remaining
                aspects.
              </p>
            )}
            <ul className="list" aria-label="Isolation check results">
              {isolation.aspects.map((check) => (
                <li key={check.aspect}>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <h3 className="m-0">{ASPECT_LABELS[check.aspect]}</h3>
                    <Badge variant={check.state === 'failed' ? 'destructive' : 'secondary'}>
                      {ISOLATION_LABELS[check.state]}
                    </Badge>
                  </div>
                  {check.checkedAt && (
                    <div className="muted">Last recorded {formatDateTime(check.checkedAt)}</div>
                  )}
                  {check.code && (
                    <div className="muted break-all font-mono text-xs">{check.code}</div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </Card>
        <Card asChild>
          <section className="card" aria-labelledby="residency-heading">
            <h2 id="residency-heading">Data regions</h2>
            <p>
              {residency.homeRegion ? (
                <>
                  Home region <strong>{residency.homeRegion}</strong>
                </>
              ) : (
                'This deployment has no confirmed home region.'
              )}
            </p>
            {residency.allInRegion && <p>All six surfaces are declared within the home region.</p>}
            <ul className="list" aria-label="Data handling regions">
              {residency.surfaces.map((surface) => (
                <li key={surface.surface}>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <h3 className="m-0">{SURFACE_LABELS[surface.surface]}</h3>
                    <Badge variant="secondary">{RESIDENCY_LABELS[surface.state]}</Badge>
                  </div>
                  {!!surface.regions.length && (
                    <div className="muted">Declared regions {surface.regions.join(', ')}</div>
                  )}
                  {surface.evidenceRef && (
                    <div className="muted [overflow-wrap:anywhere]">
                      Operator reference {surface.evidenceRef}
                    </div>
                  )}
                  {!!surface.observedElsewhere.length && (
                    <div className="muted">
                      Additional or unknown locations {surface.observedElsewhere.join(', ')}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </Card>
        <ResidencyRequirements
          organizationId={organizationId}
          homeRegion={residency.homeRegion}
          requirements={requirements}
          owner={owner}
          ready={ready}
          error={query.residencyError}
          saved={query.residencySaved === '1'}
        />
      </div>
    </>
  );
}
