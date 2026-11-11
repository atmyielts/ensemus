'use client';
import { useActionState, useEffect, useId, useRef } from 'react';
import type { ObjectRecordView } from '@ensemus/application/custom-objects';
import type { ObjectField } from '@ensemus/domain/custom-object';
import type { ObjectFormState } from '@/lib/object-input';
import { saveObjectRecordAction } from '@/server/object-actions';
import { SubmitButton } from '../submit-button';
import { ActionLink, ErrorNotice, ReloadLink } from '../ui';
import {
  objectRecordEditorScope,
  objectEditorPermalink,
  type ObjectEditorScope,
} from '@/lib/object-editor';
import { DescribedChoices } from '../knowledge-view';
import { levelName, recordLevelChoices } from './record-levels';
import { ObjectSignInHold } from './sign-in-hold';

type RecordFormProps = { organizationId: string } & (
  | { admission: 'sso-required'; scope: ObjectEditorScope }
  | {
      admission?: undefined;
      typeId: string;
      fields: readonly ObjectField[];
      floor: string;
      record?: ObjectRecordView;
      requestKey?: string;
      canLowerSensitivity?: boolean;
    }
);
export function ObjectRecordForm(props: RecordFormProps) {
  const { organizationId } = props,
    scope = props.admission === 'sso-required' ? props.scope : objectRecordEditorScope(props),
    record = props.admission === 'sso-required' ? undefined : props.record;
  const [state, action] = useActionState<ObjectFormState, FormData>(
      saveObjectRecordAction,
      {},
      objectEditorPermalink(scope),
    ),
    prefix = useId(),
    notice = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.code) notice.current?.focus();
  }, [state]);
  if (props.admission === 'sso-required' || state.code === 'SSO_REQUIRED')
    return <ObjectSignInHold scope={scope} state={state} action={action} />;
  const { typeId, fields, floor, requestKey, canLowerSensitivity = false } = props;
  const classes = ['public', 'internal', 'confidential', 'restricted'],
    value = (key: string, initial = '') => state.values?.[key] ?? initial;
  // The levels this record may take. A type's minimum can be raised after a record was saved, so a record
  // may sit below it; then its own level is not offered, and the most open allowed level is chosen for
  // it, as the old dropdown did, with a sentence saying why.
  const allowedLevels = classes.filter(
    (_, i) =>
      i >=
      Math.max(
        classes.indexOf(floor),
        record && !canLowerSensitivity ? classes.indexOf(record.classification) : 0,
      ),
  );
  const wanted = value('classification', record?.classification ?? 'restricted');
  const belowFloor = Boolean(record) && !allowedLevels.includes(record?.classification ?? '');
  const chosenLevel = allowedLevels.includes(wanted) ? wanted : (allowedLevels[0] ?? wanted);
  const contents = (
    <>
      <div tabIndex={-1} ref={notice}>
        <ErrorNotice code={state.code} />
        {state.code === 'VERSION_CONFLICT' && record && (
          <p className="notice">
            Your unsaved values are still below. Reload to discard them and open the current record.{' '}
            <ReloadLink href={`/o/${organizationId}/objects/records/${record.id}`}>
              Reload current version
            </ReloadLink>
          </p>
        )}
        {state.reauthHref && (
          <p className="notice">
            <ActionLink variant="secondary" href={state.reauthHref} target="_blank">
              Verify identity in another tab
            </ActionLink>{' '}
            Then return here and save. Your typed values stay on this page.
          </p>
        )}
      </div>
      <form key={state.revision ?? 0} action={action} className="card fields">
        <input type="hidden" name="organizationId" value={organizationId} />
        <input type="hidden" name="typeId" value={typeId} />
        {record ? (
          <>
            <input type="hidden" name="recordId" value={record.id} />
            <input type="hidden" name="version" value={value('version', String(record.version))} />
          </>
        ) : (
          <input type="hidden" name="requestKey" value={value('requestKey', requestKey)} />
        )}
        <label htmlFor={`${prefix}-name`}>
          Record name
          <input
            id={`${prefix}-name`}
            name="displayName"
            maxLength={120}
            required
            defaultValue={value('displayName', record?.displayName)}
          />
        </label>
        <DescribedChoices
          id={`${prefix}-class`}
          name="classification"
          legend="Who can see this"
          help={
            belowFloor
              ? `This record is less private than its type now asks for, so saving it raises it to at least ${levelName(allowedLevels[0] ?? floor)}.`
              : !record
                ? 'It can be more private than this type asks for, but not less.'
                : !canLowerSensitivity
                  ? 'You can make it more private. Only an administrator who can see it can make it less private.'
                  : 'Making it less private asks you to confirm it is you, and it cannot go below what this type asks for.'
          }
          options={recordLevelChoices(allowedLevels)}
          defaultValue={chosenLevel}
        />
        {fields.length > 0 && (
          <div className="form-section">
            {fields.map((f, index) => {
              const fieldName = `attribute_${f.key}`,
                fieldId = `${prefix}-attribute-${index}`,
                raw =
                  record && Object.hasOwn(record.attributes, f.key)
                    ? record.attributes[f.key]
                    : undefined,
                initial = raw === undefined || raw === null ? '' : String(raw),
                current = value(fieldName, initial);
              return (
                <label key={f.key} htmlFor={fieldId}>
                  <span id={`${fieldId}-label`}>
                    {f.label}
                    {f.required ? ' (required)' : ''}
                  </span>
                  {f.kind === 'date' && (
                    <small id={`${fieldId}-help`}>
                      For example 2026-03-31, or a date and time with its time zone.
                    </small>
                  )}
                  {f.kind === 'boolean' ? (
                    <select
                      id={fieldId}
                      aria-labelledby={`${fieldId}-label`}
                      name={fieldName}
                      required={f.required}
                      defaultValue={current}
                    >
                      <option value="">Not specified</option>
                      <option value="true">Yes</option>
                      <option value="false">No</option>
                    </select>
                  ) : f.kind === 'enum' ? (
                    <select
                      id={fieldId}
                      aria-labelledby={`${fieldId}-label`}
                      name={fieldName}
                      required={f.required}
                      defaultValue={current}
                    >
                      <option value="">Choose a value</option>
                      {f.options?.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  ) : f.kind === 'long_text' ? (
                    <textarea
                      id={fieldId}
                      aria-labelledby={`${fieldId}-label`}
                      name={fieldName}
                      required={f.required}
                      maxLength={f.maxLength ?? 50000}
                      rows={5}
                      defaultValue={current}
                    />
                  ) : (
                    <input
                      id={fieldId}
                      aria-labelledby={`${fieldId}-label`}
                      aria-describedby={f.kind === 'date' ? `${fieldId}-help` : undefined}
                      name={fieldName}
                      type={
                        f.kind === 'number'
                          ? 'number'
                          : f.kind === 'email'
                            ? 'email'
                            : f.kind === 'url'
                              ? 'url'
                              : 'text'
                      }
                      step={f.kind === 'number' ? 'any' : undefined}
                      maxLength={f.maxLength ?? 2000}
                      required={f.required}
                      defaultValue={current}
                    />
                  )}
                </label>
              );
            })}
          </div>
        )}
        <div className="row">
          <SubmitButton working="Saving">{record ? 'Save record' : 'Create record'}</SubmitButton>
        </div>
      </form>
    </>
  );
  // A full no-script action response must reopen the editor so its retained values and error are
  // visible. Keeping this disclosure with its action state also avoids a client-only recovery path.
  return record ? (
    <details open={Boolean(state.code)}>
      <summary>Edit record</summary>
      {contents}
    </details>
  ) : (
    contents
  );
}
