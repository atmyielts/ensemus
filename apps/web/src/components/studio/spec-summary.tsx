import type { AgentSpecV1 } from '@ensemus/contracts/ai';
import type { ProcessSpec } from '@ensemus/domain/process-spec';
import { ClassificationBadge } from '@/components/ui';
import { studioToolName } from '@/lib/studio-present';

type FrozenSpec =
  | { kind: 'agent_draft'; spec: AgentSpecV1 }
  | { kind: 'process_draft'; spec: ProcessSpec };

/** A readable view of the exact frozen spec, never a new assessment of a changed draft. */
export function SpecSummary({ snapshot, sourceNames = {} }: {
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
      evidence_check: 'Evidence check',
    };
    const approverName = {
      process_owner: 'The workflow publisher or an eligible organization administrator',
      starter_manager: 'Manager approval is unavailable here; no manager relationship is recorded',
      named_reviewer: 'The named reviewer for the run',
    };
    const evidenceName = {
      artifact_attached: 'A file is attached',
      external_receipt: 'A verified outside-action receipt exists',
      reviewer_approved: 'The current result has a person’s approval',
    };
    return <>
      <p>Sensitivity: <ClassificationBadge value={spec.classification} /></p>
      <p className="muted">These are the frozen workflow steps and their prerequisites. This view starts no workflow.</p>
      <ul className="list" aria-label="Frozen workflow steps">
        {spec.steps.map(step => <li key={step.key}>
          <div className="fields">
            <strong>{step.label}</strong><p>{kindName[step.kind]}</p>
            <p className="muted">{step.after.length ? 'After: ' + step.after.map(key => spec.steps.find(s => s.key === key)?.label ?? 'An earlier configured step').join(', ') : 'No earlier step required'}</p>
            {step.toolId && <p>Permission: {studioToolName(step.toolId)}</p>}
            {step.approverRole && <p>Who decides: {approverName[step.approverRole]}</p>}
            {step.evidence && <p>Required evidence: {evidenceName[step.evidence]}</p>}
          </div>
        </li>)}
      </ul>
    </>;
  }
  const spec = snapshot.spec;
  const classes = spec.context.allowed_scopes.flatMap(scope => {
    const match = /^data\.(public|internal|confidential|restricted)\.read$/.exec(scope);
    return match?.[1] ? [match[1]] : [];
  });
  const sourceIds = spec.context.allowed_scopes.flatMap(scope => {
    const match = /^knowledge\.([0-9a-f-]{36})\.read$/i.exec(scope);
    return match?.[1] ? [match[1]] : [];
  });
  const output = spec.output.schema_ref === 'schemas/markdown-brief.schema.json'
    ? 'A brief with supporting citations'
    : spec.output.schema_ref === 'schemas/structured-report.schema.json'
      ? 'A structured report with supporting citations'
      : 'The output shape defined in the technical snapshot';
  return <>
    <h3>Intended result</h3><p>{spec.objective}</p>
    <dl className="details">
      <div><dt>Output</dt><dd>{output}</dd></div>
      <div><dt>Fact writing</dt><dd>{spec.context.memory_write_policy === 'none' ? 'Cannot write facts' : 'Can propose facts for a person to verify'}</dd></div>
      <div><dt>Model preference</dt><dd>{spec.model.quality_tier === 'economy' ? 'Economy' : spec.model.quality_tier === 'high' ? 'High quality' : 'Balanced'}</dd></div>
      <div><dt>Fallback</dt><dd>{spec.model.fallback === 'disabled' ? 'No fallback model' : 'Only profiles approved by the current policy'}</dd></div>
      <div><dt>Maximum spend</dt><dd>USD {spec.execution.max_cost_usd} per run, as a limit. This is not a price or a measured charge.</dd></div>
      <div><dt>Run limits</dt><dd>{spec.execution.max_model_turns} model turns · {spec.execution.max_tool_calls} tool calls · {spec.execution.max_total_tokens} total tokens · {spec.execution.timeout_seconds} seconds</dd></div>
      <div><dt>Delegation limit</dt><dd>{spec.execution.max_delegation_depth} levels</dd></div>
    </dl>
    <h3>What it may access</h3>
    {classes.length ? <ul aria-label="Permitted data classes">{classes.map(value => <li key={value}><ClassificationBadge value={value} /></li>)}</ul> : <p>No company data class is granted by this snapshot.</p>}
    {sourceIds.length ? <ul aria-label="Selected knowledge sources">{sourceIds.map(id => <li key={id}>{sourceNames[id.toLowerCase()] ?? 'A selected source is not currently available to you. Its title is hidden.'}</li>)}</ul> : <p>No individual knowledge source is selected.</p>}
    <p className="muted">Source grants and sensitivity are checked again when a run reads data. A saved permission never overrides current access.</p>
    <h3>Permitted tools</h3>
    {spec.tools.allow.length ? <ul>{spec.tools.allow.map(tool => <li key={tool}>{studioToolName(tool)}</li>)}</ul> : <p>No additional tool permissions.</p>}
    {spec.tools.deny && spec.tools.deny.length > 0 && <><h3>Explicitly excluded tools</h3><ul>{spec.tools.deny.map(tool => <li key={tool}>{studioToolName(tool)}</li>)}</ul></>}
    <details><summary>Full instructions and behavior rules</summary><pre>{spec.instructions}</pre></details>
    <p className="notice">This definition and its rehearsal do not qualify a real model or provider. Current runtime policy, source access, approved profiles and budget still apply.</p>
  </>;
}
