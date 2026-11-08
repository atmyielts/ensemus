'use client';
import { useActionState } from 'react';
import { DATA_CATEGORIES } from '@ensemus/saas/lifecycle';
import { setRetentionRuleFormAction } from '@/server/lifecycle-actions';
import { ErrorNotice } from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
export type RetentionRuleFormState = {
  values: { dataCategory: string; classification: string; retainDays: string; basisRef: string };
  code?: string;
  saved?: boolean;
};
export function RetentionRuleForm({ organizationId }: { organizationId: string }) {
  const [state, action] = useActionState(
    setRetentionRuleFormAction,
    { values: { dataCategory: 'raw_files', classification: '*', retainDays: '', basisRef: '' } },
    `/o/${organizationId}/account/retention`,
  );
  const values = state.values;
  return (
    <form className="fields form-width" action={action}>
      <input type="hidden" name="organizationId" value={organizationId} />
      <ErrorNotice code={state.code} />
      {state.saved && (
        <p className="notice good" role="status">
          Retention rule saved. It replaces the previous rule for this category and classification.
        </p>
      )}
      <label>
        Data category
        <select name="dataCategory" defaultValue={values.dataCategory}>
          {DATA_CATEGORIES.map((value) => (
            <option key={value} value={value}>
              {value.replaceAll('_', ' ')}
            </option>
          ))}
        </select>
      </label>
      <label>
        Classification
        <select name="classification" defaultValue={values.classification}>
          {['*', 'public', 'internal', 'confidential', 'restricted'].map((value) => (
            <option key={value} value={value}>
              {value === '*' ? 'All classifications without their own rule' : value}
            </option>
          ))}
        </select>
      </label>
      <label>
        Retention period in days <small>Optional</small>
        <input
          type="number"
          name="retainDays"
          min={1}
          max={36500}
          step={1}
          defaultValue={values.retainDays}
          aria-describedby="retention-days-help"
        />
        <small id="retention-days-help">
          Leave empty to retain indefinitely. Enter only a period approved for this data. Audit logs
          and transaction records are retained by their own mechanism.
        </small>
      </label>
      <label>
        Sign-off reference
        <input
          name="basisRef"
          required
          maxLength={200}
          defaultValue={values.basisRef}
          aria-describedby="retention-basis-help"
        />
        <small id="retention-basis-help">
          Reference the approved policy or agreement. Do not paste its contents.
        </small>
      </label>
      <div>
        <SubmitButton working="Saving rule">Save retention rule</SubmitButton>
      </div>
    </form>
  );
}
