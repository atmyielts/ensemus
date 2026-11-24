import Link from 'next/link';
import { cursorFrom } from '@/components/assistants/present';
import { readAssistantsPage } from '@/components/assistants/read';
import { AssistantsUnavailable, RunList } from '@/components/assistants/run-views';
import { ActionLink, Empty, ErrorNotice, PageHead } from '@/components/ui';
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
        description="An assistant can read your work and write drafts for you. Anything that would send, share or change something outside Ensemus waits for a person to approve it, and you can ask an assistant to stop while it works."
      />
      <ErrorNotice code={error} />
      {state.kind === 'unavailable' ? (
        <AssistantsUnavailable subject="list" workHref={`${base}/work`} />
      ) : (
        <>
          <ErrorNotice code={state.brokenLink ? 'INVALID_INPUT' : undefined} />
          {state.running.length === 0 && state.finished.length === 0 ? (
            after && !state.brokenLink ? (
              <Empty
                title="That is everything"
                action={
                  <ActionLink href={`${base}/assistants`} variant="secondary">
                    Back to the start
                  </ActionLink>
                }
              >
                There is nothing more to show.
              </Empty>
            ) : (
              <Empty
                title="No assistant work yet"
                action={<ActionLink href={`${base}/work`}>Go to your work</ActionLink>}
              >
                You have not handed anything to an assistant yet. Open a piece of work and start one
                from there. You can then follow it step by step here, and stop it if you need to.
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
            <p className="row link-line gap-above">
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
