'use client';
import { useActionState } from 'react';
import { placeLegalHoldFormAction } from '@/server/lifecycle-actions';
import { AccountActionNotice } from '@/components/account-action-notice';
import { SubmitButton } from '@/components/submit-button';
export type LegalHoldFormState = {
  values: { matterRef: string; scopeTokens: string[] };
  code?: string;
  saved?: boolean;
};
export function LegalHoldForm({
  organizationId,
  targets,
}: {
  organizationId: string;
  targets: readonly { type: string; items: readonly { id: string; label: string }[] }[];
}) {
  const [state, action] = useActionState(
    placeLegalHoldFormAction,
    { values: { matterRef: '', scopeTokens: [] } },
    `/o/${organizationId}/account/legal-holds`,
  );
  return (
    <form className="fields form-width" action={action}>
      <input type="hidden" name="organizationId" value={organizationId} />
      <AccountActionNotice
        code={state.code}
        organizationId={organizationId}
        returnTo={`/o/${organizationId}/account/legal-holds`}
      />
      {state.saved && (
        <p className="notice good" role="status">
          Legal hold placed. Records within its scope must be preserved until it is released.
        </p>
      )}
      <label>
        Matter reference
        <input
          name="matterRef"
          required
          maxLength={120}
          defaultValue={state.values.matterRef}
          aria-describedby="hold-matter-help"
        />
        <small id="hold-matter-help">
          Use a reference only. Do not enter details of the matter.
        </small>
      </label>
      <label>
        Records to preserve
        <select
          name="scopes"
          multiple
          required
          size={8}
          defaultValue={state.values.scopeTokens}
          aria-describedby="hold-scope-help"
        >
          <option value="organization:">Entire organization</option>
          {targets.map((group) => (
            <optgroup key={group.type} label={group.type.replaceAll('_', ' ')}>
              {group.items.map((item) => (
                <option key={item.id} value={`${group.type}:${item.id}`}>
                  {item.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <small id="hold-scope-help">
          Select one or more records. A client or project also preserves its related files. This
          list shows up to 100 records per category; the entire-organization option covers all
          records.
        </small>
      </label>
      <div>
        <SubmitButton working="Placing hold">Place legal hold</SubmitButton>
      </div>
    </form>
  );
}
