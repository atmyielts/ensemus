'use client';
import { useActionState, useEffect, useId, useRef } from 'react';
import type { ProcessDraftView } from '@ensemus/application/process-specs';
import type { ProcessGraph, ProcessGraphNode } from '@ensemus/domain/process-spec';
import type { WorkflowFormState } from '@/lib/process-studio-input';
import {
  WORKFLOW_KIND_NAMES,
  workflowConnections,
  type WorkflowChoices,
} from '@/lib/process-studio-present';
import {
  saveWorkflowDetailsAction,
  saveWorkflowPointAction,
} from '@/server/process-studio-actions';
import { ErrorNotice } from '../ui';
import { SubmitButton } from '../submit-button';
import { useWorkflowFields } from './workflow-editor-state';

/** Who can read a workflow, said the way the reading rule works. */
const CLASSIFICATIONS = [
  ['public', 'Public', 'Everyone in your organization, and safe to share outside it.'],
  ['internal', 'Internal', 'Everyone in your organization.'],
  ['confidential', 'Confidential', 'You, owners and administrators.'],
  [
    'restricted',
    'Restricted',
    'Only you. It cannot include assistant steps or actions outside Ensemus.',
  ],
] as const;

export function WorkflowDetailsForm({
  organizationId,
  draft,
  requestKey,
}: {
  organizationId: string;
  draft?: ProcessDraftView;
  requestKey: string;
}) {
  const [state, action] = useActionState<WorkflowFormState, FormData>(
      saveWorkflowDetailsAction,
      {},
    ),
    prefix = useId(),
    notice = useRef<HTMLDivElement>(null),
    kept = useWorkflowFields({
      draftId: draft?.id,
      key: 'details',
      version: draft?.version,
      state,
    });
  useEffect(() => {
    if (kept.code) notice.current?.focus();
  }, [kept.code]);
  const value = (key: string, initial = '') => kept.values?.[key]?.[0] ?? initial;
  const classification = value('classification', draft?.classification ?? 'internal');
  return (
    <form
      ref={kept.form}
      onChangeCapture={kept.onChange}
      onSubmitCapture={kept.onSubmit}
      action={action}
      className="card fields form-width"
      key={state.revision ?? 0}
    >
      <div ref={notice} tabIndex={-1}>
        <ErrorNotice code={kept.code} />
      </div>
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="requestKey" value={value('requestKey', requestKey)} />
      {draft && (
        <>
          <input type="hidden" name="draftId" value={draft.id} />
          <input type="hidden" name="version" value={kept.version ?? draft.version} />
        </>
      )}
      <label htmlFor={`${prefix}-name`}>
        <span id={`${prefix}-name-label`}>Workflow name</span>
        <small id={`${prefix}-name-help`}>
          What the process is, such as “Approve a new supplier”.
        </small>
        <input
          id={`${prefix}-name`}
          name="name"
          required
          maxLength={120}
          aria-labelledby={`${prefix}-name-label`}
          aria-describedby={`${prefix}-name-help`}
          defaultValue={value('name', draft?.name)}
        />
      </label>
      <fieldset className="group">
        <legend>Who can see this</legend>
        <small>This covers the workflow and the names of its steps.</small>
        <div className="choice-list">
          {CLASSIFICATIONS.map(([key, name, help]) => (
            <label className="choice" key={key}>
              <input
                type="radio"
                name="classification"
                value={key}
                defaultChecked={classification === key}
              />
              <strong>{name}</strong>
              <small>{help}</small>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="row">
        <SubmitButton working={draft ? 'Saving the definition' : 'Creating the draft'}>
          {draft ? 'Save workflow details' : 'Create workflow draft'}
        </SubmitButton>
      </div>
      <small>
        {draft
          ? 'Saving a change closes any open review. Published versions stay as they are.'
          : 'You become its responsible person. Start and Finish are added for you; you add the steps in between next. Nothing runs yet.'}
      </small>
    </form>
  );
}

export function WorkflowPointForm({
  organizationId,
  draftId,
  version,
  graph,
  node,
  newNodeId,
  requestKey,
  choices,
}: {
  organizationId: string;
  draftId: string;
  version: number;
  graph: ProcessGraph;
  node?: ProcessGraphNode;
  newNodeId?: string;
  requestKey: string;
  choices: WorkflowChoices;
}) {
  const [state, action] = useActionState<WorkflowFormState, FormData>(saveWorkflowPointAction, {}),
    prefix = useId(),
    notice = useRef<HTMLDivElement>(null),
    kept = useWorkflowFields({ draftId, key: node ? `point:${node.id}` : 'new', version, state });
  useEffect(() => {
    if (kept.code) notice.current?.focus();
  }, [kept.code]);
  const value = (key: string, initial = '') => kept.values?.[key]?.[0] ?? initial;
  const nodeId = value('nodeId', node?.id ?? newNodeId);
  if (!nodeId) throw new Error('WORKFLOW_POINT_INTENT_MISSING');
  const ends = graph.nodes.filter((n) => n.kind === 'end').map((n) => n.id),
    starts = graph.nodes.filter((n) => n.kind === 'start').map((n) => n.id);
  const before = node
    ? graph.edges.filter((e) => e.to === node.id).map((e) => e.from)
    : graph.edges.filter((e) => ends.includes(e.to)).map((e) => e.from);
  const initialPrevious = node ? before : before.length ? before : starts;
  const initialNext = node ? graph.edges.filter((e) => e.from === node.id).map((e) => e.to) : ends;
  const previous = kept.values ? (kept.values.previous ?? []) : initialPrevious,
    next = kept.values ? (kept.values.next ?? []) : initialNext;
  const previousChoices = workflowConnections(graph, nodeId, previous),
    nextChoices = workflowConnections(graph, nodeId, next);
  const selectedAgent = value('agentDefinitionId', node?.agentDefinitionId ?? ''),
    selectedTool = value('toolId', node?.toolId ?? ''),
    selectedApprover = value('approverRole', node?.approverRole ?? ''),
    selectedKind = value('kind', node?.kind ?? 'work_item'),
    selectedEvidence = value('evidence', node?.evidence ?? '');
  return (
    <form
      ref={kept.form}
      onChangeCapture={kept.onChange}
      onSubmitCapture={kept.onSubmit}
      action={action}
      className="fields"
      key={state.revision ?? 0}
    >
      <div ref={notice} tabIndex={-1}>
        <ErrorNotice code={kept.code} />
      </div>
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="draftId" value={draftId} />
      <input type="hidden" name="version" value={kept.version ?? version} />
      <input type="hidden" name="requestKey" value={value('requestKey', requestKey)} />
      <input type="hidden" name="mode" value={node ? 'update' : 'add'} />
      <input type="hidden" name="nodeId" value={nodeId} />
      <label htmlFor={`${prefix}-label`}>Point name</label>
      <input
        id={`${prefix}-label`}
        name="label"
        required
        maxLength={120}
        defaultValue={value('label', node?.label)}
      />
      <label htmlFor={`${prefix}-kind`}>What happens here?</label>
      <select
        id={`${prefix}-kind`}
        name="kind"
        defaultValue={selectedKind}
        aria-describedby={`${prefix}-kind-help`}
      >
        {selectedKind && !Object.hasOwn(WORKFLOW_KIND_NAMES, selectedKind) && (
          <option value={selectedKind}>
            Saved point type is unavailable here — value retained
          </option>
        )}
        {Object.entries(WORKFLOW_KIND_NAMES).map(([kind, label]) => (
          <option value={kind} key={kind}>
            {label}
          </option>
        ))}
      </select>
      <p id={`${prefix}-kind-help`} className="muted">
        Start and Finish mark the beginning and the end. Every other point is work for a person, a
        task for an assistant, an approval, a proposed action or a check. You can save a draft that
        is not finished yet; only a complete one can be rehearsed.
      </p>
      <details open={node !== undefined && !['start', 'end', 'work_item'].includes(node.kind)}>
        <summary>Settings for this kind of point</summary>
        <p className="muted">
          Fill in the setting that matches the kind you chose above. The others are ignored.
        </p>
        <label htmlFor={`${prefix}-agent`}>For an assistant point: published assistant</label>
        <select
          id={`${prefix}-agent`}
          name="agentDefinitionId"
          defaultValue={selectedAgent}
          aria-describedby={`${prefix}-agent-help`}
        >
          <option value="">Choose a currently offered published assistant</option>
          {selectedAgent && !choices.agents?.some((a) => a.id === selectedAgent) && (
            <option value={selectedAgent}>
              Saved assistant is not currently offered — choose another to change it
            </option>
          )}
          {choices.agents?.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} · Offered version {a.versionNumber}
            </option>
          ))}
        </select>
        <p id={`${prefix}-agent-help`} className="muted">
          {choices.agents === null
            ? 'The list of published assistants cannot be read right now. Try again later.'
            : choices.agents.length
              ? 'When this step starts, it uses the published version of the assistant at that moment. Editing starts nothing.'
              : 'No published assistant is offered yet. Publish one first, or make this work for a person.'}
        </p>
        <label htmlFor={`${prefix}-tool`}>For an outside-action point: action to propose</label>
        <select
          id={`${prefix}-tool`}
          name="toolId"
          defaultValue={selectedTool}
          aria-describedby={`${prefix}-tool-help`}
        >
          <option value="">Choose an available outside action</option>
          {selectedTool && !choices.tools?.some((t) => t.id === selectedTool) && (
            <option value={selectedTool}>
              Saved outside action is not available — choose another to change it
            </option>
          )}
          {choices.tools?.map((tool) => (
            <option key={tool.id} value={tool.id}>
              {tool.name}
            </option>
          ))}
        </select>
        <p id={`${prefix}-tool-help`} className="muted">
          {choices.tools === null
            ? 'The list of outside actions cannot be read right now.'
            : 'Every path to this point has to pass an approval first. When it runs, a person still approves the exact action, and it needs a working connection. Editing sends nothing.'}
        </p>
        <label htmlFor={`${prefix}-approver`}>For an approval point: who may decide?</label>
        <select
          id={`${prefix}-approver`}
          name="approverRole"
          defaultValue={selectedApprover}
          aria-describedby={`${prefix}-approver-help`}
        >
          {selectedApprover &&
            !Object.hasOwn(
              { process_owner: true, named_reviewer: true, starter_manager: true },
              selectedApprover,
            ) && (
              <option value={selectedApprover}>
                Saved approval rule is unavailable here — value retained
              </option>
            )}
          <option value="">Choose how an eligible person is found</option>
          <option value="process_owner">
            Workflow publisher, or an eligible organization administrator
          </option>
          <option value="named_reviewer">
            A person assigned as reviewer on the run’s main Work
          </option>
          {selectedApprover === 'starter_manager' && (
            <option value="starter_manager">Saved manager selection — unavailable here</option>
          )}
        </select>
        <p id={`${prefix}-approver-help`} className="muted">
          The approver has to be able to read the work and cannot be the person asking. This chooses
          how the approver is found; it does not assign anyone.
        </p>
        <label htmlFor={`${prefix}-evidence`}>For an evidence point: what must exist?</label>
        <select id={`${prefix}-evidence`} name="evidence" defaultValue={selectedEvidence}>
          {selectedEvidence &&
            !Object.hasOwn(
              { artifact_attached: true, external_receipt: true, reviewer_approved: true },
              selectedEvidence,
            ) && (
              <option value={selectedEvidence}>
                Saved evidence rule is unavailable here — value retained
              </option>
            )}
          <option value="">Choose required evidence</option>
          <option value="artifact_attached">A file attached to the work</option>
          <option value="external_receipt">A verified outside-action receipt</option>
          <option value="reviewer_approved">The current result has human approval</option>
        </select>
      </details>
      <details open={!node}>
        <summary>What comes before and after</summary>
        <p className="muted">
          Every point ticked under “before” has to finish first. If you tick several points under
          “after”, they all carry on at the same time; there is no either-or routing. Save one point
          at a time.
        </p>
        <fieldset className="group gap-above">
          <legend>Before this point (all must finish)</legend>
          {previousChoices.length ? (
            previousChoices.map((point) => (
              <label className="check" key={point.id}>
                <input
                  type="checkbox"
                  name="previous"
                  value={point.id}
                  defaultChecked={previous.includes(point.id)}
                />
                {point.label}
              </label>
            ))
          ) : (
            <p className="muted">There are no other points yet.</p>
          )}
        </fieldset>
        <fieldset className="group gap-above">
          <legend>After this point (each one carries on)</legend>
          {nextChoices.length ? (
            nextChoices.map((point) => (
              <label className="check" key={point.id}>
                <input
                  type="checkbox"
                  name="next"
                  value={point.id}
                  defaultChecked={next.includes(point.id)}
                />
                {point.label}
              </label>
            ))
          ) : (
            <p className="muted">There are no other points yet.</p>
          )}
        </fieldset>
        {!node && (
          <label className="check">
            <input
              type="checkbox"
              name="replaceDirect"
              value="yes"
              defaultChecked={kept.values ? value('replaceDirect') === 'yes' : true}
            />
            Put it in between: replace the direct links between those points. Untick to add it as an
            extra path alongside them.
          </label>
        )}
      </details>
      <div>
        <SubmitButton working={node ? 'Saving this point' : 'Adding this point'}>
          {node ? 'Save this point' : 'Add this point'}
        </SubmitButton>
      </div>
    </form>
  );
}
