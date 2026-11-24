import { getSandboxRun, idSchema } from '@ensemus/application';
import { can } from '@ensemus/domain/policy';
import {
  isSettledSandboxRun,
  type SandboxOutcomeCode,
  type SandboxRunStatus,
} from '@ensemus/domain/sandbox';
import { notFound } from 'next/navigation';
import { BackLink, ClassificationBadge, formatDateTime, PageHead } from '@/components/ui';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { orNotFound, requireTenant } from '@/server/tenant';
import { SandboxRunControls } from './run-controls';

export const metadata = { title: 'Sandbox trial | Ensemus' };

const statusLabels: Record<SandboxRunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Completed',
  failed: 'Failed',
  timed_out: 'Timed out',
  memory_exceeded: 'Memory limit reached',
  output_exceeded: 'Output limit reached',
  denied: 'Declined',
  cancelled: 'Cancelled',
  runner_unavailable: 'Runner unavailable',
};

const outcomeLabels: Partial<Record<SandboxOutcomeCode, string>> = {
  FEATURE_DISABLED: 'Trial runs were disabled before this trial could start.',
  SKILL_NOT_USABLE: 'This skill version could no longer be run.',
  SKILL_BYTES_CHANGED: 'The stored bundle no longer matched the verified version.',
  POLICY_OUT_OF_DATE: 'The trial’s recorded limits no longer match the current policy.',
  CLASSIFICATION_NOT_ALLOWED: 'The version does not accept this input classification.',
  ISOLATION_NOT_PROVED: 'The runner’s limits check failed or did not finish.',
  RUNNER_NOT_CONFIGURED: 'A runner has not been configured.',
  RUNNER_UNREACHABLE: 'The worker could not reach the runner.',
  CONCURRENCY_LIMIT: 'The workspace reached its concurrent run limit.',
  EXITED_NON_ZERO: 'The program exited with an error.',
  OUTPUT_NOT_JSON: 'The program returned output that was not JSON.',
  OUTPUT_FAILED_SCHEMA: 'The output did not match the version’s output schema.',
  WALL_LIMIT: 'The trial reached its elapsed time limit.',
  CPU_LIMIT: 'The trial reached its CPU time limit.',
  MEMORY_LIMIT: 'The trial reached its memory limit.',
  OUTPUT_LIMIT: 'The trial reached its output limit.',
  ATTEMPTS_EXHAUSTED: 'The worker used all available attempts.',
};

export default async function SandboxTrialPage({
  params,
}: {
  params: Promise<{ organizationId: string; sandboxRunId: string }>;
}) {
  const { organizationId, sandboxRunId } = await params;
  const id = idSchema.safeParse(sandboxRunId);
  if (!id.success) notFound();
  const { database, context } = await requireTenant(organizationId);
  if (context.actorType !== 'user' || !can(context.role, 'sandbox.run')) notFound();
  // Native RLS exposes only this operator’s own trials in this workspace.
  const run = await orNotFound(getSandboxRun(database, context, id.data));
  if (run.purpose !== 'operator_test') notFound();

  const settled = isSettledSandboxRun(run.status);
  const output = run.status === 'succeeded' ? JSON.stringify(run.output, null, 2) : null;
  const outcome = run.outcomeCode ? outcomeLabels[run.outcomeCode] : undefined;
  const usage = [
    ['Elapsed time', run.wallMs === null ? null : `${run.wallMs} ms`],
    ['CPU time', run.cpuMs === null ? null : `${run.cpuMs} ms`],
    ['Peak memory', run.peakMemoryKb === null ? null : `${run.peakMemoryKb} KiB`],
    ['Exit code', run.exitCode === null ? null : `${run.exitCode}`],
  ] as const;
  const limits = [
    ['Elapsed time', `${run.limits.wallMs} ms`],
    ['CPU time', `${run.limits.cpuMs} ms`],
    ['Memory', `${run.limits.memoryMb} MiB`],
    ['Temporary storage', `${run.limits.tmpfsMb} MiB`],
    ['Output', `${run.limits.outputKb} KiB`],
    ['Processes', `${run.limits.pids}`],
  ] as const;

  return (
    <>
      <BackLink href={`/o/${organizationId}/skills/versions/${run.skillVersionId}`}>
        Skill version
      </BackLink>
      <PageHead title="Sandbox trial" />
      <Card asChild className="min-w-0 rounded-lg border border-border p-4 sm:p-5">
        <section aria-labelledby="sandbox-trial-status">
          <h2 id="sandbox-trial-status">Status</h2>
          <div className="flex flex-wrap items-center gap-2" aria-live="polite">
            <Badge variant={settled && run.status !== 'succeeded' ? 'outline' : 'secondary'}>
              {statusLabels[run.status]}
            </Badge>
            <ClassificationBadge value={run.classification} />
          </div>
          {outcome && <p>{outcome}</p>}
          <dl className="grid gap-2 sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">Queued</dt>
              <dd>{formatDateTime(run.createdAt)}</dd>
            </div>
            {run.finishedAt && (
              <div>
                <dt className="text-muted-foreground">Finished</dt>
                <dd>{formatDateTime(run.finishedAt)}</dd>
              </div>
            )}
          </dl>
          {!settled && <SandboxRunControls organizationId={organizationId} sandboxRunId={run.id} />}
        </section>
      </Card>

      <Card asChild className="min-w-0 rounded-lg border border-border p-4 sm:p-5">
        <section aria-labelledby="sandbox-trial-limits">
          <h2 id="sandbox-trial-limits">Recorded limits</h2>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-3">
            {limits.map(([name, value]) => (
              <div key={name}>
                <dt className="text-muted-foreground">{name}</dt>
                <dd className="tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="text-muted-foreground">
            {run.isolationEvidence === 'probe_passed'
              ? 'The runner recorded a passing limits check for this trial.'
              : 'A passing limits check has not been recorded for this trial.'}{' '}
            Independent review is pending.
          </p>
        </section>
      </Card>

      {usage.some(([, value]) => value !== null) && (
        <Card asChild className="min-w-0 rounded-lg border border-border p-4 sm:p-5">
          <section aria-labelledby="sandbox-trial-usage">
            <h2 id="sandbox-trial-usage">Usage</h2>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4">
              {usage.map(
                ([name, value]) =>
                  value !== null && (
                    <div key={name}>
                      <dt className="text-muted-foreground">{name}</dt>
                      <dd className="tabular-nums">{value}</dd>
                    </div>
                  ),
              )}
            </dl>
          </section>
        </Card>
      )}

      {output !== null && output !== undefined && (
        <Card asChild className="min-w-0 rounded-lg border border-border p-4 sm:p-5">
          <section aria-labelledby="sandbox-trial-output">
            <h2 id="sandbox-trial-output">Output</h2>
            <pre className="min-w-0 whitespace-pre-wrap wrap-anywhere rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
              {output}
            </pre>
          </section>
        </Card>
      )}
    </>
  );
}
