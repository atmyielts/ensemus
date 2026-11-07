import { canonicalId } from '@ensemus/application';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { stopNotice, stopOutcomeFrom } from '@/components/assistants/present';
import { readRunPage } from '@/components/assistants/read';
import {
  AssistantsUnavailable,
  CheckAgain,
  RunFacts,
  RunSteps,
  StopNoticeLine,
  StopRun,
} from '@/components/assistants/run-views';
import { PageHead } from '@/components/ui';
import { webProductPorts } from '@/server/product-ports';
import { orNotFound, requireTenant } from '@/server/tenant';

export const metadata = { title: 'Assistant | Ensemus' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reads the run on every visit, including straight after someone asks it to stop. Only the run decides whether
 * this page says stopped. Someone else's run answers NOT_FOUND from the port, and is the usual 404.
 */
export default async function AssistantRunPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string; runId: string }>;
  searchParams: Promise<{ stop?: string | string[]; error?: string | string[] }>;
}) {
  const { organizationId, runId: rawRunId } = await params;
  const { stop, error } = await searchParams;
  const { context } = await requireTenant(organizationId);
  if (!UUID.test(rawRunId)) notFound();
  const runId = canonicalId(rawRunId);
  const base = `/o/${organizationId}`;
  const back = (
    <p className="back">
      <Link href={`${base}/assistants`}>Assistants</Link>
    </p>
  );

  const state = await orNotFound(readRunPage(context, webProductPorts(), runId));

  if (state.kind === 'unavailable') {
    return (
      <>
        {back}
        <PageHead title="Assistant" />
        <AssistantsUnavailable subject="run" workHref={`${base}/work`} />
      </>
    );
  }

  const { run } = state;
  const outcome = stopOutcomeFrom({ stop, error });
  return (
    <>
      {back}
      <PageHead
        title={run.workTitle}
        description={`Assistant: ${run.agentName}`}
        actions={
          !run.finished && (
            <CheckAgain
              action={`${base}/assistants/${runId}`}
              keepRequested={outcome?.kind === 'requested'}
            />
          )
        }
      />
      <StopNoticeLine notice={stopNotice(outcome, run)} />
      <div className="stack">
        <RunFacts run={run} workHref={`${base}/work/${run.workUnitId}`} />
        <StopRun run={run} organizationId={organizationId} />
        <RunSteps run={run} />
      </div>
    </>
  );
}
