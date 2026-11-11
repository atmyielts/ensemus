'use client';
import { useActionState, useEffect, useId, useRef } from 'react';
import type { AgentDraftView } from '@ensemus/application/agent-drafts';
import type { ToolFacts } from '@ensemus/domain/agent-draft';
import { usdTextFromMicros } from '@ensemus/domain/agent-draft';
import type { StudioFormState } from '@/lib/studio-input';
import { saveAgentDraftAction } from '@/server/studio-actions';
import { ErrorNotice } from '../ui';
import { SubmitButton } from '../submit-button';
import { toolGroups, toolWords } from './tool-words';

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
  const ceilingValue = value('dataCeiling', a ? ceiling : 'internal'),
    autonomyValue = value('autonomy', a?.autonomy ?? 'suggest_only');
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
        {help && <small id={`${id}-help`}>{help}</small>}
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
      </label>
    );
  }
  return (
    <form action={action} className="card fields form-width">
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
      <h2>What it is for</h2>
      <label htmlFor={`${prefix}-name`}>
        <span id={`${prefix}-name-label`}>Assistant name</span>
        <small id={`${prefix}-name-help`}>A short name your team will recognise.</small>
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
        <span id={`${prefix}-owner-label`}>Responsible person</span>
        <small id={`${prefix}-owner-help`}>
          The person who answers for what this assistant does.
        </small>
        <select
          id={`${prefix}-owner`}
          name="ownerMembershipId"
          aria-labelledby={`${prefix}-owner-label`}
          aria-describedby={`${prefix}-owner-help`}
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
            A published assistant keeps its responsible person. To choose someone else, create a
            separate assistant.
          </p>
        </>
      )}
      <label htmlFor={`${prefix}-boundaries`}>
        <span id={`${prefix}-boundaries-label`}>What must it avoid?</span>
        <small id={`${prefix}-boundaries-help`}>
          One rule per line, such as “Never promise a delivery date”. Optional.
        </small>
        <textarea
          id={`${prefix}-boundaries`}
          name="boundaries"
          rows={3}
          maxLength={10020}
          aria-labelledby={`${prefix}-boundaries-label`}
          aria-describedby={`${prefix}-boundaries-help`}
          defaultValue={value('boundaries', a?.boundaries.join('\n'))}
        />
      </label>

      <div className="form-section">
        <h2>What it may see</h2>
        <fieldset className="group">
          <legend>Company information it may read</legend>
          <div className="choice-list">
            <label className="choice">
              <input
                type="radio"
                name="dataCeiling"
                value="public"
                defaultChecked={ceilingValue === 'public'}
              />
              <strong>Public only</strong>
              <small>Material anyone outside the company could see.</small>
            </label>
            <label className="choice">
              <input
                type="radio"
                name="dataCeiling"
                value="internal"
                defaultChecked={ceilingValue === 'internal'}
              />
              <strong>Up to internal</strong>
              <small>Everyday company material your team shares among itself.</small>
            </label>
            <label className="choice">
              <input
                type="radio"
                name="dataCeiling"
                value="confidential"
                defaultChecked={ceilingValue === 'confidential'}
              />
              <strong>Up to confidential</strong>
              <small>
                Sensitive material. Someone other than you has to review this assistant.
              </small>
            </label>
          </div>
          <small>
            Each person’s own access still applies when it runs. Restricted material is not offered
            here.
          </small>
        </fieldset>
        <details open={missingSources.length > 0}>
          <summary>Limit it to chosen Knowledge sources (optional)</summary>
          <fieldset className="group gap-above-small">
            <legend>Only the sources you tick may be searched</legend>
            {missingSources.map((id, index) => (
              <label className="check" key={id}>
                <input type="checkbox" name="knowledgeSourceIds" value={id} defaultChecked />
                <span>
                  A saved source you can no longer see ({index + 1}). Untick it to remove it.
                </span>
              </label>
            ))}
            {sources.length === 0 ? (
              <p className="muted">There are no searchable sources you can read yet.</p>
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
            <small>Up to 200 sources you can read are listed.</small>
          </fieldset>
        </details>
      </div>

      <div className="form-section">
        <h2>What it may do</h2>
        <fieldset className="group">
          <legend>Extra abilities</legend>
          <small>Leave these unticked for an assistant that only reads and answers.</small>
          {missingTools.length > 0 && (
            <div className="choice-list">
              {missingTools.map((id) => (
                <label className="choice" key={id}>
                  <input type="checkbox" name="toolIds" value={id} defaultChecked />
                  <strong>An ability that is no longer offered</strong>
                  <small>Untick it to remove it before saving.</small>
                </label>
              ))}
            </div>
          )}
          {toolGroups(tools).map((group) => {
            const choices = (
              <div className="choice-list">
                {group.tools.map((tool) => {
                  const [name, help] = toolWords(tool);
                  return (
                    <label className="choice" key={tool.id}>
                      <input
                        type="checkbox"
                        name="toolIds"
                        value={tool.id}
                        defaultChecked={chosen('toolIds', tool.id, a?.toolIds ?? [])}
                      />
                      <strong>{name}</strong>
                      <small>
                        {help}
                        {tool.requiresApproval ? ' A person approves each use.' : ''}
                      </small>
                    </label>
                  );
                })}
              </div>
            );
            // Account abilities fold away until wanted; one already chosen keeps its group open.
            return group.title ? (
              <details
                key={group.key}
                open={group.tools.some((tool) => chosen('toolIds', tool.id, a?.toolIds ?? []))}
              >
                <summary>
                  {group.title} ({group.tools.length})
                </summary>
                <div className="gap-above-small">{choices}</div>
              </details>
            ) : (
              <div key={group.key}>{choices}</div>
            );
          })}
          {(tools.length > 0 || missingTools.length > 0) && (
            <details>
              <summary>Technical details</summary>
              <ul>
                {missingTools.map((id) => (
                  <li key={id}>
                    No longer offered: <code>{id}</code>
                  </li>
                ))}
                {tools.map((tool) => (
                  <li key={tool.id}>
                    {toolWords(tool)[0]}: <code>{tool.id}</code>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </fieldset>
        <fieldset className="group">
          <legend>How should it work?</legend>
          <div className="choice-list">
            <label className="choice">
              <input
                type="radio"
                name="autonomy"
                value="suggest_only"
                defaultChecked={autonomyValue === 'suggest_only'}
              />
              <strong>Make suggestions</strong>
              <small>It answers and suggests; a person does the rest.</small>
            </label>
            <label className="choice">
              <input
                type="radio"
                name="autonomy"
                value="draft_for_review"
                defaultChecked={autonomyValue === 'draft_for_review'}
              />
              <strong>Prepare drafts for review</strong>
              <small>It writes a first version for a person to check.</small>
            </label>
            <label className="choice">
              <input
                type="radio"
                name="autonomy"
                value="act_with_approval"
                defaultChecked={autonomyValue === 'act_with_approval'}
              />
              <strong>Propose actions for approval</strong>
              <small>It lines up an action; nothing happens until a person approves it.</small>
            </label>
          </div>
        </fieldset>
        <div className="studio-field-grid">
          <label htmlFor={`${prefix}-output`}>
            Result format
            <select
              id={`${prefix}-output`}
              name="outputFormat"
              defaultValue={value('outputFormat', a?.outputFormat ?? 'markdown_brief')}
            >
              <option value="markdown_brief">A brief with sources</option>
              <option value="structured_report">A structured report with sources</option>
            </select>
          </label>
          <label htmlFor={`${prefix}-memory`}>
            Company memory
            <select
              id={`${prefix}-memory`}
              name="memoryWrite"
              defaultValue={value('memoryWrite', a?.memoryWrite ?? 'none')}
            >
              <option value="none">Do not suggest new facts</option>
              <option value="propose_only">Suggest facts for a person to check</option>
            </select>
          </label>
        </div>
      </div>

      <div className="form-section">
        <h2>Limits for each run</h2>
        <p className="muted">
          Each run stops when it reaches any of these. Saving or rehearsing a draft costs nothing.
        </p>
        <div className="studio-field-grid">
          <label htmlFor={`${prefix}-cost`}>
            Most it may spend per run (USD)
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
          {number(
            'maxTurns',
            'Most model replies',
            a?.maxTurns,
            1,
            100,
            'One reply from the AI model.',
          )}
          {number(
            'maxToolCalls',
            'Most ability uses',
            a?.maxToolCalls,
            0,
            500,
            'Each time it uses an ability above.',
          )}
          {number(
            'maxTotalTokens',
            'Most text read and written (tokens)',
            a?.maxTotalTokens,
            1,
            100000000,
            'Tokens measure the text a model reads and writes.',
          )}
          {number('timeoutSeconds', 'Longest running time (seconds)', a?.timeoutSeconds, 1, 86400)}
        </div>
      </div>
      <div className="form-section">
        <div className="row">
          <SubmitButton working="Saving draft">
            {draft ? 'Save changes' : 'Create draft'}
          </SubmitButton>
        </div>
        <small>
          Next you rehearse it with made-up examples, then ask a colleague to review it. Publishing
          it later does not start it.
        </small>
      </div>
    </form>
  );
}
