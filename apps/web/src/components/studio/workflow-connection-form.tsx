'use client';
import { useActionState, useEffect, useRef, useState } from 'react';
import {
  removeWorkflowConnectionAction,
  type WorkflowConnectionState,
} from '@/server/process-studio-actions';
import type { ConnectionIdentity } from '@/lib/graph-layout';
import { useWorkflowEditor, WorkflowReloadFields } from './workflow-editor-state';
import { ErrorNotice } from '../ui';
import { SubmitButton } from '../submit-button';
export function RemoveWorkflowConnection({
  organizationId,
  draftId,
  version,
  edge,
  requestKey,
}: {
  organizationId: string;
  draftId: string;
  version: number;
  edge: ConnectionIdentity;
  requestKey: string;
}) {
  const [state, action] = useActionState<WorkflowConnectionState, FormData>(
      removeWorkflowConnectionAction,
      {},
    ),
    editor = useWorkflowEditor(),
    notice = useRef<HTMLDivElement>(null),
    handled = useRef<number | undefined>(undefined),
    [needsReview, setNeedsReview] = useState(false);
  useEffect(() => {
    if (state.code) notice.current?.focus();
    if (!state.receipt || handled.current === state.revision) return;
    handled.current = state.revision;
    setNeedsReview(
      !editor?.accept(
        state.receipt.draft,
        state.receipt.layout,
        state.receipt.fromVersion,
        state.receipt.edge,
      ),
    );
  }, [state, editor]);
  if (state.receipt)
    return (
      <p role="status" className="notice">
        The connection removal was recorded.
        {needsReview
          ? ' The definition changed again. Your other form entries keep their earlier version checks; review the latest saved workflow before continuing.'
          : ''}
      </p>
    );
  return (
    <form action={action} className="fields" aria-label="Remove this orphan connection">
      <div ref={notice} tabIndex={-1}>
        <ErrorNotice code={state.code} />
        {state.code === 'VERSION_CONFLICT' && <WorkflowReloadFields />}
      </div>
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="draftId" value={draftId} />
      <input type="hidden" name="version" value={version} />
      <input type="hidden" name="edgeIndex" value={edge.index} />
      <input type="hidden" name="from" value={edge.from} />
      <input type="hidden" name="to" value={edge.to} />
      <input type="hidden" name="requestKey" value={requestKey} />
      <p>
        Neither endpoint is a saved point. You can remove just this connection; every point and
        other connection is kept.
      </p>
      <noscript>
        <input type="hidden" name="nativeForm" value="yes" />
        <p className="notice">
          Save edits in your other open forms first. Submitting without JavaScript reloads this
          saved editor.
        </p>
      </noscript>
      <label className="check">
        <input type="checkbox" name="confirmed" value="yes" required />
        Remove only this connection to missing points.
      </label>
      <div>
        <SubmitButton className="secondary" working="Removing the saved connection">
          Remove this connection
        </SubmitButton>
      </div>
    </form>
  );
}
