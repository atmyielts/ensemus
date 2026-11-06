'use client';

import type { SpecLintCode } from '@ensemus/policy/agent-spec-lint';
import { useActionState } from 'react';
import { SubmitButton } from '@/components/submit-button';
import { ErrorNotice } from '@/components/ui';
import { publishAgentVersionAction } from './actions';
import type { PublishFormState } from './form-state';

const INITIAL: PublishFormState = {};

/** A Map, as in messages.ts: these are shown by code, and a plain object answers for other keys too. */
const LINT_WORDS = new Map<SpecLintCode, string>([
  ['UNKNOWN_TOOL', 'It allows a tool that does not exist.'],
  [
    'FORBIDDEN_TOOL',
    'It allows a tool no agent may have, such as one that reads secrets or changes a model, budget, policy or grant.',
  ],
  ['TOOL_BOTH_ALLOWED_AND_DENIED', 'It both allows and denies the same tool.'],
  [
    'LIMIT_ABOVE_POLICY',
    'A limit is higher than this organization allows. Without a policy that says otherwise, an agent cannot delegate.',
  ],
  ['SKILLS_NOT_SUPPORTED', 'It lists skills, and agents cannot use skills yet.'],
  ['NOT_LINTED', 'Part of it could not be read.'],
]);

/**
 * Takes a manifest and its evaluation report as JSON. Nothing here decides anything: the server checks
 * both, and what was typed comes back with a refusal so it can be fixed rather than pasted again.
 */
export function PublishForm({ organizationId }: { organizationId: string }) {
  const [state, action] = useActionState(publishAgentVersionAction, INITIAL);
  const reasons = (state.lintCodes ?? []).flatMap((code) => LINT_WORDS.get(code) ?? []);
  const fields = state.fields ?? [];
  return (
    <>
      <ErrorNotice code={state.code} />
      {(reasons.length > 0 || fields.length > 0) && (
        <div className="notice error">
          {reasons.length > 0 && (
            <ul>
              {reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
          {fields.length > 0 && <p>Check these fields: {fields.join(', ')}.</p>}
        </div>
      )}
      {state.published && (
        <p className="notice good" role="status">
          Version {state.published.versionNumber} is published, and new runs will use it. Runs
          already going keep the version they started on.
        </p>
      )}
      <form className="fields gap-above" action={action}>
        <input type="hidden" name="organizationId" value={organizationId} />
        <label>
          Agent manifest
          <small>The agent&apos;s definition, as JSON. A version cannot be changed later.</small>
          <textarea
            name="manifest"
            required
            rows={14}
            spellCheck={false}
            autoComplete="off"
            maxLength={256 * 1024}
            defaultValue={state.values?.manifest ?? ''}
          />
        </label>
        <label>
          Evaluation report
          <small>
            The passing report for exactly this manifest, as JSON. Changing the manifest needs a new
            report.
          </small>
          <textarea
            name="report"
            required
            rows={8}
            spellCheck={false}
            autoComplete="off"
            maxLength={256 * 1024}
            defaultValue={state.values?.report ?? ''}
          />
        </label>
        <SubmitButton working="Checking and publishing">Publish this version</SubmitButton>
      </form>
    </>
  );
}
