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
      <ul aria-label="Workflow compilation issues">
        {issues.map((issue, index) => (
          <li key={index}>
            <strong>{issue.nodeId ? workflowPointLabel(graph, issue.nodeId) : 'Workflow'}: </strong>
            {WORKFLOW_ISSUES[issue.code]}
          </li>
        ))}
      </ul>
      <details>
        <summary>Diagnostic rule codes</summary>
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
    <p>
      The saved steps and connections pass the available checks. Rehearse the workflow and review
      its results before requesting publication.
    </p>
  );
}
export function WorkflowOverview({
  graph,
  choices,
}: {
  graph: ProcessGraph;
  choices: WorkflowChoices;
}) {
  return (
    <>
      <p className="muted">
        Connections determine execution order. The list below is an editing order; every earlier
        connection must finish before the point can continue. Multiple later connections are
        parallel paths, not conditional choices.
      </p>
      <ol className="list" aria-label="Saved workflow points">
        {graph.nodes.map((node, index) => (
          <li key={`${node.id}-${index}`}>
            <div className="fields">
              <h3>{workflowPointLabel(graph, node.id)}</h3>
              <p>{WORKFLOW_KIND_NAMES[node.kind]}</p>
              <dl className="details">
                <div>
                  <dt>Earlier points</dt>
                  <dd>
                    {graph.edges
                      .filter((e) => e.to === node.id)
                      .map((e) => workflowPointLabel(graph, e.from))
                      .join('; ') || 'None'}
                  </dd>
                </div>
                <div>
                  <dt>Later points</dt>
                  <dd>
                    {graph.edges
                      .filter((e) => e.from === node.id)
                      .map((e) => workflowPointLabel(graph, e.to))
                      .join('; ') || 'None'}
                  </dd>
                </div>
                {node.kind === 'agent_task' && (
                  <div>
                    <dt>Assistant</dt>
                    <dd>
                      {choices.agents?.find((a) => a.id === node.agentDefinitionId)?.name ??
                        'The saved assistant is not currently offered. Select an active published assistant before moving forward.'}
                    </dd>
                  </div>
                )}
                {node.kind === 'external_action' && (
                  <div>
                    <dt>Outside action</dt>
                    <dd>
                      {choices.tools?.find((t) => t.id === node.toolId)?.name ??
                        'The saved outside action is not currently available.'}{' '}
                      It will need its own actual connection and action approval later.
                    </dd>
                  </div>
                )}
                {node.kind === 'human_approval' && (
                  <div>
                    <dt>Who may decide</dt>
                    <dd>
                      {node.approverRole
                        ? WORKFLOW_APPROVER_NAMES[node.approverRole]
                        : 'Not selected yet'}
                    </dd>
                  </div>
                )}
                {node.kind === 'evidence_check' && (
                  <div>
                    <dt>Required evidence</dt>
                    <dd>
                      {node.evidence ? WORKFLOW_EVIDENCE_NAMES[node.evidence] : 'Not selected yet'}
                    </dd>
                  </div>
                )}
              </dl>
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}
