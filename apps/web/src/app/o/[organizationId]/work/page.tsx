import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table';
import { AppError, listProjects, listWorkOverview } from '@ensemus/application';
import { WORK_STATES, type CompletionCriterion, type WorkState } from '@ensemus/domain/work-unit';
import Link from 'next/link';
import {
  ActionLink,
  ClassificationBadge,
  Empty,
  ErrorNotice,
  formatDate,
  PageHead,
  StatusBadge,
} from '@/components/ui';
import { evidenceSummary } from '@/lib/work-view';
import { requireTenant } from '@/server/tenant';

export const metadata = { title: 'Work | Ensemus' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LABELS: Record<string, string> = {
  queued: 'Waiting to start',
  ready: 'Ready',
  running: 'In progress',
  blocked: 'Blocked',
  awaiting_approval: 'Waiting for approval',
  verifying: 'Checking',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Stopped',
};

export default async function WorkPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ status?: string; cursor?: string; error?: string; project?: string }>;
}) {
  const { organizationId } = await params;
  const { status, cursor, error, project } = await searchParams;
  const { context, database } = await requireTenant(organizationId);
  const base = `/o/${organizationId}`;
  const filter = WORK_STATES.includes(status as WorkState) ? (status as WorkState) : undefined;
  const projectId =
    typeof project === 'string' && UUID.test(project) ? project.toLowerCase() : undefined;
  const scope = {
    ...(filter ? { status: filter } : {}),
    ...(projectId ? { projectId } : {}),
  };
  const projectName = projectId
    ? (await listProjects(database, context)).find((p) => p.id === projectId)?.name
    : undefined;

  // A page reached through a broken link starts again from the top, and says so.
  let notice = error;
  const page = await listWorkOverview(database, context, {
    ...scope,
    ...(cursor ? { cursor } : {}),
  }).catch((failure: unknown) => {
    if (!(failure instanceof AppError) || failure.code !== 'INVALID_INPUT') throw failure;
    notice = 'INVALID_INPUT';
    return listWorkOverview(database, context, scope);
  });
  const { items, nextCursor } = page;

  return (
    <>
      <PageHead
        title="Work"
        actions={<ActionLink href={`${base}/work/new`}>New work</ActionLink>}
      />
      <ErrorNotice code={notice} />
      {projectId && (
        <p className="notice">
          Showing work in {projectName ?? 'this project'}.{' '}
          <Link href={`${base}/work`}>Show all work</Link>
        </p>
      )}
      {/* With nothing here at all, a filter only gets in the way of the first step. */}
      {(items.length > 0 || filter || projectId) && (
        <form
          className="mb-2 flex min-w-0 items-center gap-2 border-y py-2"
          method="get"
          aria-label="Filter work"
        >
          {projectId && <input type="hidden" name="project" value={projectId} />}
          <Label htmlFor="work-status" className="text-muted-foreground">
            Status
          </Label>
          <NativeSelect
            id="work-status"
            name="status"
            controlSize="sm"
            className="w-40 min-w-0 max-md:[&_select]:min-h-11"
            defaultValue={filter ?? ''}
          >
            <option value="">All statuses</option>
            {WORK_STATES.map((state) => (
              <option key={state} value={state}>
                {LABELS[state]}
              </option>
            ))}
          </NativeSelect>
          <Button className="shrink-0 max-md:min-h-11" variant="outline" size="sm" type="submit">
            Filter
          </Button>
        </form>
      )}
      {items.length === 0 ? (
        filter || projectId ? (
          <Empty
            title="Nothing matches"
            action={
              <ActionLink href={`${base}/work`} variant="secondary">
                Show all work
              </ActionLink>
            }
          >
            No work matches this filter. Try another status, or show everything.
          </Empty>
        ) : (
          <Empty
            title="Work starts with an outcome"
            action={
              <ActionLink href={`${base}/compose`} variant="secondary">
                Describe an outcome
              </ActionLink>
            }
          >
            No work yet. Describe the outcome you want, and you can hand it out and follow it here.
          </Empty>
        )
      ) : (
        <Card asChild>
          <div className="card table-wrap work-overview-table">
            {/* The roles keep this a table for a screen reader when a small screen stacks its rows. */}
            <Table className="work-table [&_td]:p-[var(--work-cell-padding)]" role="table">
              <TableHeader role="rowgroup">
                <TableRow role="row">
                  <TableHead role="columnheader" scope="col">
                    Work
                  </TableHead>
                  <TableHead role="columnheader" scope="col">
                    Status
                  </TableHead>
                  <TableHead role="columnheader" scope="col">
                    Done when
                  </TableHead>
                  <TableHead role="columnheader" scope="col">
                    Due
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody role="rowgroup">
                {items.map((work) => {
                  const evidence = evidenceSummary(
                    work.status as WorkState,
                    work.completionCriteria as CompletionCriterion[],
                    work.evidence,
                  );
                  return (
                    <TableRow key={work.id} role="row">
                      <TableCell role="cell" className="whitespace-normal wrap-anywhere">
                        <Link href={`${base}/work/${work.id}`}>{work.title}</Link>
                        <small className="work-meta">
                          <span>
                            <span className="due-word">Owner: </span>
                            {work.ownerName ?? 'Owner unknown'}
                          </span>
                          {/* Most work is for everyone inside, so only a narrower audience is named. */}
                          {work.classification !== 'internal' && (
                            <span>
                              <span className="visually-hidden">Who can see this: </span>
                              <ClassificationBadge value={work.classification} />
                            </span>
                          )}
                        </small>
                      </TableCell>
                      <TableCell role="cell">
                        <StatusBadge status={work.status} />
                      </TableCell>
                      <TableCell role="cell">
                        <span className="due-word">Done when: </span>
                        {evidence.tone ? (
                          <span className={`badge ${evidence.tone}`}>{evidence.text}</span>
                        ) : (
                          <small>{evidence.text}</small>
                        )}
                      </TableCell>
                      {work.dueAt ? (
                        <TableCell role="cell" className="nowrap">
                          <span className="due-word">Due </span>
                          {formatDate(work.dueAt)}
                        </TableCell>
                      ) : (
                        <TableCell role="cell" className="no-date">
                          <small>None</small>
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </Card>
      )}
      {nextCursor && (
        <p className="gap-above-large">
          <ActionLink
            variant="secondary"
            href={`${base}/work?${new URLSearchParams({
              ...(filter ? { status: filter } : {}),
              ...(projectId ? { project: projectId } : {}),
              cursor: nextCursor,
            })}`}
          >
            Next page
          </ActionLink>
        </p>
      )}
    </>
  );
}
