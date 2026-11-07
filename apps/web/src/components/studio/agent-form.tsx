'use client';
import { useActionState, useEffect, useId, useRef } from 'react';
import type { AgentDraftView } from '@ensemus/application/agent-drafts';
import type { ToolFacts } from '@ensemus/domain/agent-draft';
import { usdTextFromMicros } from '@ensemus/domain/agent-draft';
import type { StudioFormState } from '@/lib/studio-input';
import { saveAgentDraftAction } from '@/server/studio-actions';
import { ErrorNotice } from '../ui';
import { SubmitButton } from '../submit-button';
const TOOL_NAMES: Record<string, string> = {
  'work.read': 'Read the work details',
  'artifact.read_text': 'Read an attached file',
  'artifact.draft.create': 'Prepare a draft file',
  'email.send': 'Propose an email for approval',
  'agent.delegate': 'Ask another assistant',
};
export function AgentForm({
  organizationId,
  draft,
  ownerMembershipId,
  people,
  sources,
  tools,
  requestKey,
}: {
  organizationId: string;
  draft?: AgentDraftView;
  ownerMembershipId: string;
  people: readonly { id: string; name: string }[];
  sources: readonly { id: string; title: string; classification: string }[];
  tools: readonly ToolFacts[];
  requestKey: string;
}) {
  const [state, action] = useActionState<StudioFormState, FormData>(saveAgentDraftAction, {}),
    prefix = useId(),
    error = useRef<HTMLDivElement>(null),
    a = draft?.answers;
  useEffect(() => {
    if (state.code) error.current?.focus();
  }, [state]);
  const value = (name: string, initial = '') => state.values?.[name]?.[0] ?? initial;
  const chosen = (name: string, id: string, initial: readonly string[]) =>
    state.values ? (state.values[name]?.includes(id) ?? false) : initial.includes(id);
  const missingSources = (state.values?.knowledgeSourceIds ?? a?.knowledgeSourceIds ?? []).filter(
    (id) => !sources.some((source) => source.id === id),
  );
  const missingTools = (state.values?.toolIds ?? a?.toolIds ?? []).filter(
    (id) => !tools.some((tool) => tool.id === id),
  );
  const ceiling = a?.dataClasses.includes('confidential')
    ? 'confidential'
    : a?.dataClasses.includes('internal')
      ? 'internal'
      : 'public';
  function number(
    name: string,
    label: string,
    initial: number | undefined,
    min: number,
    max: number,
    help?: string,
  ) {
    const id = `${prefix}-${name}`;
    return (
      <label htmlFor={id}>
        <span id={`${id}-label`}>{label}</span>
        <input
          id={id}
          name={name}
          type="number"
          min={min}
          max={max}
          step="1"
          required
          defaultValue={value(name, initial === undefined ? '' : String(initial))}
          aria-labelledby={`${id}-label`}
          aria-describedby={help ? `${id}-help` : undefined}
        />
        {help && <small id={`${id}-help`}>{help}</small>}
      </label>
    );
  }
  return (
    <form action={action} className="card fields">
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="requestKey" value={requestKey} />
      {draft && (
        <>
          <input type="hidden" name="draftId" value={draft.id} />
          <input type="hidden" name="version" value={draft.version} />
        </>
      )}
      <div ref={error} tabIndex={-1}>
        <ErrorNotice code={state.code} />
      </div>
      <h2>Purpose and responsibility</h2>
      <label htmlFor={`${prefix}-name`}>
        Assistant name
        <input
          id={`${prefix}-name`}
          name="name"
          required
          maxLength={120}
          defaultValue={value('name', draft?.name)}
        />
      </label>
      <label htmlFor={`${prefix}-role`}>
        What should it help with?
        <textarea
          id={`${prefix}-role`}
          name="role"
          required
          rows={3}
          maxLength={2000}
          defaultValue={value('role', a?.role)}
        />
      </label>
      <label htmlFor={`${prefix}-outcome`}>
        What should a good result contain?
        <textarea
          id={`${prefix}-outcome`}
          name="intendedOutcome"
          required
          rows={3}
          minLength={10}
          maxLength={1000}
          defaultValue={value('intendedOutcome', a?.intendedOutcome)}
        />
      </label>
      <label htmlFor={`${prefix}-owner`}>
        Responsible person
        <select
          id={`${prefix}-owner`}
          name="ownerMembershipId"
          defaultValue={value('ownerMembershipId', a?.ownerMembershipId ?? ownerMembershipId)}
          disabled={Boolean(draft?.agentDefinitionId)}
        >
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {draft?.agentDefinitionId && (
        <>
          <input type="hidden" name="ownerMembershipId" value={a?.ownerMembershipId} />
          <p className="muted">
            A published assistant keeps its responsible person. Create a separate assistant to
            choose someone else.
          </p>
        </>
      )}
      <label htmlFor={`${prefix}-boundaries`}>
        What must it avoid?
        <textarea
          id={`${prefix}-boundaries`}
          name="boundaries"
          rows={3}
          maxLength={10020}
          defaultValue={value('boundaries', a?.boundaries.join('\n'))}
        />
        <small>
          One boundary per line. Keep confidential reference material in Knowledge sources.
        </small>
      </label>
      <h2>Company information</h2>
      <label htmlFor={`${prefix}-ceiling`}>
        <span id={`${prefix}-ceiling-label`}>Company-data ceiling</span>
        <select
          id={`${prefix}-ceiling`}
          name="dataCeiling"
          aria-labelledby={`${prefix}-ceiling-label`}
          aria-describedby={`${prefix}-ceiling-help`}
          defaultValue={value('dataCeiling', a ? ceiling : 'internal')}
        >
          <option value="public">Public only</option>
          <option value="internal">Up to internal</option>
          <option value="confidential">Up to confidential — requires another reviewer</option>
        </select>
        <small id={`${prefix}-ceiling-help`}>
          This limits company material it can read. Current sharing rules still apply. Its
          instructions receive at least internal protection.
        </small>
      </label>
      <details>
        <summary>Choose Knowledge sources (optional)</summary>
        <fieldset className="group">
          <legend>Only selected sources may be searched</legend>
          {missingSources.map((id, index) => (
            <label className="check" key={id}>
              <input type="checkbox" name="knowledgeSourceIds" value={id} defaultChecked />
              <span>Unavailable saved source {index + 1}. Uncheck to remove it before saving.</span>
            </label>
          ))}
          {sources.length === 0 ? (
            <p className="muted">No searchable sources you can read are available.</p>
          ) : (
            sources.map((source) => (
              <label className="check" key={source.id}>
                <input
                  type="checkbox"
                  name="knowledgeSourceIds"
                  value={source.id}
                  defaultChecked={chosen(
                    'knowledgeSourceIds',
                    source.id,
                    a?.knowledgeSourceIds ?? [],
                  )}
                />
                <span>
                  {source.title} <small>· {source.classification}</small>
                </span>
              </label>
            ))
          )}
          <p className="muted">
            Up to 200 current readable sources are shown. Sharing and sensitivity are checked again
            when it runs.
          </p>
        </fieldset>
      </details>
      <h2>Actions and review</h2>
      <fieldset className="group">
        <legend>Additional tools</legend>
        {missingTools.map((id) => (
          <label className="check" key={id}>
            <input type="checkbox" name="toolIds" value={id} defaultChecked />
            <span>Unavailable saved tool: {id}. Uncheck to remove it before saving.</span>
          </label>
        ))}
        {tools.map((tool) => (
          <label className="check" key={tool.id}>
            <input
              type="checkbox"
              name="toolIds"
              value={tool.id}
              defaultChecked={chosen('toolIds', tool.id, a?.toolIds ?? [])}
            />
            <span>
              {TOOL_NAMES[tool.id] ?? tool.id}
              {tool.requiresApproval ? ' · approval required' : ''}
            </span>
          </label>
        ))}
      </fieldset>
      <label htmlFor={`${prefix}-autonomy`}>
        How should it work?
        <select
          id={`${prefix}-autonomy`}
          name="autonomy"
          defaultValue={value('autonomy', a?.autonomy ?? 'suggest_only')}
        >
          <option value="suggest_only">Make suggestions</option>
          <option value="draft_for_review">Prepare drafts for review</option>
          <option value="act_with_approval">Propose actions for approval</option>
        </select>
      </label>
      <label htmlFor={`${prefix}-output`}>
        Result format
        <select
          id={`${prefix}-output`}
          name="outputFormat"
          defaultValue={value('outputFormat', a?.outputFormat ?? 'markdown_brief')}
        >
          <option value="markdown_brief">A brief with citations</option>
          <option value="structured_report">A structured report with citations</option>
        </select>
      </label>
      <label htmlFor={`${prefix}-memory`}>
        Company memory
        <select
          id={`${prefix}-memory`}
          name="memoryWrite"
          defaultValue={value('memoryWrite', a?.memoryWrite ?? 'none')}
        >
          <option value="none">Do not propose new memory</option>
          <option value="propose_only">Propose facts for a person to verify</option>
        </select>
      </label>
      <h2>Limits for each run</h2>
      <p className="muted">
        Choose these explicitly. Saving or rehearsing a draft does not make a paid model call.
      </p>
      <label htmlFor={`${prefix}-cost`}>
        Maximum cost per run (USD)
        <input
          id={`${prefix}-cost`}
          name="maxCostUsd"
          inputMode="decimal"
          required
          pattern="[0-9]+([.][0-9]{1,6})?"
          defaultValue={value(
            'maxCostUsd',
            a?.maxCostMicros ? usdTextFromMicros(a.maxCostMicros) : '',
          )}
        />
      </label>
      {number(
        'maxTurns',
        'Maximum model turns',
        a?.maxTurns,
        1,
        100,
        'A turn is one response from the model.',
      )}
      {number('maxToolCalls', 'Maximum tool calls', a?.maxToolCalls, 0, 500)}
      {number(
        'maxTotalTokens',
        'Maximum total tokens',
        a?.maxTotalTokens,
        1,
        100000000,
        'Tokens measure the text a model reads and writes.',
      )}
      {number('timeoutSeconds', 'Maximum running time (seconds)', a?.timeoutSeconds, 1, 86400)}
      <label htmlFor={`${prefix}-quality`}>
        Model quality
        <select
          id={`${prefix}-quality`}
          name="qualityTier"
          defaultValue={value('qualityTier', a?.qualityTier ?? 'balanced')}
        >
          <option value="economy">Economy</option>
          <option value="balanced">Balanced</option>
          <option value="high">High</option>
        </select>
      </label>
      <SubmitButton working="Saving draft">{draft ? 'Save draft' : 'Create draft'}</SubmitButton>
      <p className="muted">
        Next: rehearse with synthetic scenarios, review the exact revision, then publish. Publishing
        does not start a run.
      </p>
    </form>
  );
}
