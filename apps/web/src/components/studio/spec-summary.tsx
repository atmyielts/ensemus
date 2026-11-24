import type { getPublishReviewSnapshot } from '@ensemus/application/publish-reviews';
import { ClassificationBadge } from '@/components/ui';
import { toolName } from './tool-words';

type FrozenSpec = Awaited<ReturnType<typeof getPublishReviewSnapshot>>;

/** A readable view of the exact frozen spec, never a new assessment of a changed draft. */
export function SpecSummary({
  snapshot,
  sourceNames = {},
}: {
  snapshot: FrozenSpec;
  sourceNames?: Readonly<Record<string, string>>;
}) {
  if (snapshot.kind === 'process_draft') {
    const spec = snapshot.spec;
    const kindName = {
      work_item: 'Work for a person',
      agent_task: 'Published assistant step',
      human_approval: 'Approval by a person',
      external_action: 'Proposed outside action',
      evidence_check: 'A check that it is done',
    };
    const approverName = {
      process_owner: 'The workflow publisher or an eligible organization administrator',
      starter_manager: 'The starter’s manager, which Ensemus cannot look up',
      named_reviewer: 'The named reviewer for the run',
    };
    const evidenceName = {
      artifact_attached: 'A file is attached',
      external_receipt: 'A verified outside-action receipt exists',
      reviewer_approved: 'The current result has a person’s approval',
    };
    return (
      <>
        <p>
          Who can see this: <ClassificationBadge value={spec.classification} />
        </p>
        <ul className="list" aria-label="Frozen workflow steps">
          {spec.steps.map((step) => (
            <li key={step.key}>
              <div>
                <strong>{step.label}</strong>
                <br />
                <small>
                  {kindName[step.kind]} ·{' '}
                  {step.after.length
                    ? 'Waits for ' +
                      step.after
                        .map(
                          (key) =>
                            spec.steps.find((s) => s.key === key)?.label ??
                            'An earlier configured step',
                        )
                        .join(', ')
                    : 'First step'}
                </small>
                {step.toolId && <p>Action: {toolName(step.toolId)}</p>}
                {step.approverRole && <p>Who decides: {approverName[step.approverRole]}</p>}
                {step.evidence && <p>Done when: {evidenceName[step.evidence]}</p>}
              </div>
            </li>
          ))}
        </ul>
      </>
    );
  }
  const spec = snapshot.spec;
  const classes = spec.context.allowed_scopes.flatMap((scope) => {
    const match = /^data\.(public|internal|confidential|restricted)\.read$/.exec(scope);
    return match?.[1] ? [match[1]] : [];
  });
  const sourceIds = spec.context.allowed_scopes.flatMap((scope) => {
    const match = /^knowledge\.([0-9a-f-]{36})\.read$/i.exec(scope);
    return match?.[1] ? [match[1]] : [];
  });
  const output =
    spec.output.schema_ref === 'schemas/markdown-brief.schema.json'
      ? 'A brief with sources'
      : spec.output.schema_ref === 'schemas/structured-report.schema.json'
        ? 'A structured report with sources'
        : 'The shape set out in the technical details';
  return (
    <>
      <h3>What a good result contains</h3>
      <p>{spec.objective}</p>
      <dl className="details">
        <div>
          <dt>Result format</dt>
          <dd>{output}</dd>
        </div>
        <div>
          <dt>Company memory</dt>
          <dd>
            {spec.context.memory_write_policy === 'none'
              ? 'Does not suggest new facts'
              : 'Suggests facts for a person to check'}
          </dd>
        </div>
        <div>
          <dt>Model quality</dt>
          <dd>
            {spec.model.quality_tier === 'economy'
              ? 'Economy'
              : spec.model.quality_tier === 'high'
                ? 'High quality'
                : 'Balanced'}
          </dd>
        </div>
        <div>
          <dt>If that model is unavailable</dt>
          <dd>
            {spec.model.fallback === 'disabled'
              ? 'It does not switch to another model'
              : 'It may switch to another model your organization has approved'}
          </dd>
        </div>
        <div>
          <dt>Most it may spend per run</dt>
          <dd>USD {spec.execution.max_cost_usd}, a ceiling rather than a charge</dd>
        </div>
        <div>
          <dt>Other limits per run</dt>
          <dd>
            {spec.execution.max_model_turns} model replies · {spec.execution.max_tool_calls} ability
            uses · {spec.execution.max_total_tokens} tokens · {spec.execution.timeout_seconds}{' '}
            seconds
          </dd>
        </div>
        <div>
          <dt>Hand-offs to other assistants</dt>
          <dd>Up to {spec.execution.max_delegation_depth} levels deep</dd>
        </div>
      </dl>
      <h3 className="gap-above-large">What it may see</h3>
      {classes.length ? (
        <ul aria-label="Permitted data classes">
          {classes.map((value) => (
            <li key={value}>
              <ClassificationBadge value={value} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No company information beyond the work it is given.</p>
      )}
      {sourceIds.length ? (
        <ul aria-label="Selected knowledge sources">
          {sourceIds.map((id) => (
            <li key={id}>
              {sourceNames[id.toLowerCase()] ?? 'A source you cannot see. Its name is hidden.'}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Not limited to particular Knowledge sources.</p>
      )}
      <p className="muted">
        <small>Each person’s current access is checked again whenever it reads anything.</small>
      </p>
      <h3 className="gap-above">What it may do</h3>
      {spec.tools.allow.length ? (
        <ul>
          {spec.tools.allow.map((tool) => (
            <li key={tool}>{toolName(tool)}</li>
          ))}
        </ul>
      ) : (
        <p className="muted">Read and answer only.</p>
      )}
      {spec.tools.deny && spec.tools.deny.length > 0 && (
        <>
          <h3 className="gap-above">Never allowed</h3>
          <ul>
            {spec.tools.deny.map((tool) => (
              <li key={tool}>{toolName(tool)}</li>
            ))}
          </ul>
        </>
      )}
      <details>
        <summary>Full instructions</summary>
        <pre>{spec.instructions}</pre>
      </details>
      <p className="muted gap-above">
        <small>
          Your organization’s current model, access and budget settings still apply when it runs.
        </small>
      </p>
    </>
  );
}
