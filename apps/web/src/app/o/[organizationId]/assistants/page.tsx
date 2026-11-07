import Link from 'next/link';
import { cursorFrom } from '@/components/assistants/present';
import { readAssistantsPage } from '@/components/assistants/read';
import { AssistantsUnavailable, RunList } from '@/components/assistants/run-views';
import { Empty, ErrorNotice, PageHead } from '@/components/ui';
import { webProductPorts } from '@/server/product-ports';
import { requireTenant } from '@/server/tenant';

export const metadata = { title: 'Assistants | Ensemus' };

// Only runs that really exist are listed. There is no "my assistant" or "team assistants" heading, because
// nothing behind them exists yet (UX-19).
export default async function AssistantsPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ after?: string | string[]; error?: string | string[] }>;
}) {
  const { organizationId } = await params;
  const { after: rawAfter, error: rawError } = await searchParams;
  const { context } = await requireTenant(organizationId);
  const base = `/o/${organizationId}`;
  const after = cursorFrom(rawAfter);
  const error = typeof rawError === 'string' ? rawError : undefined;

  const state = await readAssistantsPage(context, webProductPorts(), after ? { after } : {});

  return (
    <>
      <PageHead
        title="Assistants"
        description="Work you handed to an assistant: where it has got to, how it ended, and a way to stop it."
      />
      <ErrorNotice code={error} />
      {state.kind === 'unavailable' ? (
        <AssistantsUnavailable subject="list" workHref={`${base}/work`} />
      ) : (
        <>
          <ErrorNotice code={state.brokenLink ? 'INVALID_INPUT' : undefined} />
          {state.running.length === 0 && state.finished.length === 0 ? (
            after && !state.brokenLink ? (
              <Empty action={<Link href={`${base}/assistants`}>Back to the start</Link>}>
                There is nothing more to show.
              </Empty>
            ) : (
              <Empty action={<Link href={`${base}/work`}>Go to your work</Link>}>
                You have not handed anything to an assistant yet. When you do, you can follow it and
                stop it here.
              </Empty>
            )
          ) : (
            <div className="stack">
              {state.running.length > 0 && (
                <RunList
                  base={base}
                  id="running-heading"
                  label="Not finished yet"
                  runs={state.running}
                />
              )}
              {state.finished.length > 0 && (
                <RunList base={base} id="finished-heading" label="Finished" runs={state.finished} />
              )}
            </div>
          )}
          {(state.next || (after && !state.brokenLink)) && (
            <p className="row gap-above">
              {after && !state.brokenLink && (
                <Link href={`${base}/assistants`}>Back to the start</Link>
              )}
              {state.next && (
                <Link href={`${base}/assistants?after=${encodeURIComponent(state.next)}`}>
                  Show more
                </Link>
              )}
            </p>
          )}
        </>
      )}
    </>
  );
}
