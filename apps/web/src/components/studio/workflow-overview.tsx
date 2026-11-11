import type { GraphIssue, ProcessGraph } from '@ensemus/domain/process-spec';
import {
  WORKFLOW_KIND_NAMES,
  WORKFLOW_ISSUES,
  WORKFLOW_APPROVER_NAMES,
  WORKFLOW_EVIDENCE_NAMES,
  workflowPointLabel,
  type WorkflowChoices,
} from '@/lib/process-studio-present';

export function WorkflowIssues({
  graph,
  issues,
}: {
  graph: ProcessGraph;
  issues: readonly GraphIssue[];
}) {
  return issues.length ? (
    <>
      <p>Fix these before you rehearse it:</p>
      <ul aria-label="Workflow compilation issues">
        {issues.map((issue, index) => (
          <li key={index}>
            <strong>{issue.nodeId ? workflowPointLabel(graph, issue.nodeId) : 'Workflow'}: </strong>
            {WORKFLOW_ISSUES[issue.code]}
          </li>
        ))}
      </ul>
      <details>
        <summary>Technical details</summary>
        <ul>
          {issues.map((issue, index) => (
            <li key={index}>
              <code>
                {issue.nodeId ?? 'workflow'}: {issue.code}
              </code>
            </li>
          ))}
        </ul>
      </details>
    </>
  ) : (
    <p>The steps and their links pass every check. Rehearse it next, then ask for a review.</p>
  );
}

/** The saved points in editing order, each with what it waits for and what it needs. */
export function WorkflowOverview({
  graph,
  choices,
}: {
  graph: ProcessGraph;
  choices: WorkflowChoices;
}) {
  const names = (ids: readonly string[]) =>
    ids.map((id) => workflowPointLabel(graph, id)).join('; ');
  return (
    <ol className="list" aria-label="Saved workflow points">
      {graph.nodes.map((node, index) => {
        const before = graph.edges.filter((e) => e.to === node.id).map((e) => e.from),
          after = graph.edges.filter((e) => e.from === node.id).map((e) => e.to);
        return (
          <li key={`${node.id}-${index}`} className="block">
            <strong>{workflowPointLabel(graph, node.id)}</strong>
            <br />
            <small>
              {WORKFLOW_KIND_NAMES[node.kind]}
              {before.length ? ` · Waits for ${names(before)}` : ''}
              {after.length > 1 ? ` · Then ${names(after)}, at the same time` : ''}
            </small>
            {node.kind === 'agent_task' && (
              <p className="gap-above-small">
                Assistant:{' '}
                {choices.agents?.find((a) => a.id === node.agentDefinitionId)?.name ??
                  'the chosen assistant is no longer offered. Choose a published one before moving on.'}
              </p>
            )}
            {node.kind === 'external_action' && (
              <p className="gap-above-small">
                Action:{' '}
                {choices.tools?.find((t) => t.id === node.toolId)?.name ??
                  'the chosen action is no longer available.'}{' '}
                <span className="muted">
                  When it runs, it needs a working connection and a person’s approval.
                </span>
              </p>
            )}
            {node.kind === 'human_approval' && (
              <p className="gap-above-small">
                Who decides:{' '}
                {node.approverRole ? WORKFLOW_APPROVER_NAMES[node.approverRole] : 'not chosen yet'}
              </p>
            )}
            {node.kind === 'evidence_check' && (
              <p className="gap-above-small">
                Done when:{' '}
                {node.evidence ? WORKFLOW_EVIDENCE_NAMES[node.evidence] : 'not chosen yet'}
              </p>
            )}
          </li>
        );
      })}
    </ol>
  );
}
