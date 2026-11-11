'use client';
import { useActionState, useEffect, useId, useRef } from 'react';
import type { ObjectTypeView } from '@ensemus/application/custom-objects';
import { saveObjectTypeAction } from '@/server/object-actions';
import type { ObjectFormState } from '@/lib/object-input';
import {
  objectEditorRows,
  objectTypeEditorScope,
  objectEditorPermalink,
  type ObjectEditorScope,
} from '@/lib/object-editor';
import { DescribedChoices } from '../knowledge-view';
import { recordLevelChoices } from './record-levels';
import { ObjectSignInHold } from './sign-in-hold';
import { OBJECT_LIMITS } from '@ensemus/domain/custom-object';
import { SubmitButton } from '../submit-button';
import { ActionLink, ErrorNotice, ReloadLink } from '../ui';

const kinds = ['text', 'long_text', 'number', 'boolean', 'date', 'enum', 'email', 'url'] as const;
const kindLabels = {
  text: 'Short text',
  long_text: 'Long text',
  number: 'Number',
  boolean: 'Yes or no',
  date: 'Date',
  enum: 'Choice',
  email: 'Email',
  url: 'Web address',
};
type TypeFormProps = { organizationId: string } & (
  | { admission: 'sso-required'; scope: ObjectEditorScope }
  | {
      admission?: undefined;
      type?: ObjectTypeView;
      types: readonly { slug: string; displayName: string }[];
      requestKey?: string;
    }
);
export function ObjectTypeForm(props: TypeFormProps) {
  const { organizationId } = props,
    scope = props.admission === 'sso-required' ? props.scope : objectTypeEditorScope(props),
    type = props.admission === 'sso-required' ? undefined : props.type;
  const [state, action] = useActionState<ObjectFormState, FormData>(
      saveObjectTypeAction,
      {},
      objectEditorPermalink(scope),
    ),
    prefix = useId(),
    notice = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.code) notice.current?.focus();
    else if (state.notice) {
      const rows = objectEditorRows(
        state.values,
        type?.fields.length ?? 1,
        type?.relations.length ?? 0,
      );
      const key =
        state.notice === 'field_added'
          ? `field-${rows.fields - 1}`
          : `relation-${rows.relations - 1}`;
      document.getElementById(`${prefix}-${key}-label`)?.focus();
    }
  }, [state, prefix, type?.fields.length, type?.relations.length]);
  if (props.admission === 'sso-required' || state.code === 'SSO_REQUIRED')
    return <ObjectSignInHold scope={scope} state={state} action={action} />;
  const { types, requestKey } = props;
  const value = (key: string, initial = '') => state.values?.[key] ?? initial;
  const rows = objectEditorRows(
    state.values,
    type?.fields.length ?? 1,
    type?.relations.length ?? 0,
  );
  function field(index: number) {
    const f = type?.fields[index],
      name = `field_${index}_`,
      base = `${prefix}-field-${index}`;
    return (
      <fieldset className="object-part" key={index}>
        <legend>Field {index + 1}</legend>
        <label htmlFor={`${base}-label`}>
          Label
          <input
            id={`${base}-label`}
            name={name + 'label'}
            maxLength={120}
            defaultValue={value(name + 'label', f?.label)}
          />
        </label>
        <details open={Boolean(state.values?.[name + 'key'])}>
          <summary>Advanced field settings</summary>
          <label htmlFor={`${base}-key`}>
            Field key
            <input
              id={`${base}-key`}
              name={name + 'key'}
              pattern="[a-z][a-z0-9_]{0,62}"
              maxLength={63}
              defaultValue={value(name + 'key', f?.key)}
              readOnly={Boolean(f)}
            />
          </label>
          <p className="muted">
            Ensemus makes a key from the label for you. Once saved, a key never changes.
          </p>
        </details>
        <label htmlFor={`${base}-kind`}>
          Field type
          <select
            id={`${base}-kind`}
            name={name + 'kind'}
            defaultValue={value(name + 'kind', f?.kind ?? 'text')}
            disabled={Boolean(f)}
          >
            {kinds.map((k) => (
              <option key={k} value={k}>
                {kindLabels[k]}
              </option>
            ))}
          </select>
        </label>
        {f && <input type="hidden" name={name + 'kind'} value={value(name + 'kind', f.kind)} />}
        <label className="check">
          <input
            type="checkbox"
            name={name + 'required'}
            defaultChecked={
              state.values ? value(name + 'required') === 'on' : (f?.required ?? false)
            }
          />
          Required
        </label>
        <label className="check">
          <input
            type="checkbox"
            name={name + 'indexed'}
            defaultChecked={state.values ? value(name + 'indexed') === 'on' : (f?.indexed ?? false)}
          />
          <span>
            Allow filtering by this field
            <br />
            <small>Up to eight fields. Long text cannot be filtered.</small>
          </span>
        </label>
        <label htmlFor={`${base}-options`}>
          Choices, one per line
          <small>Only for a Choice field.</small>
          <textarea
            id={`${base}-options`}
            name={name + 'options'}
            rows={3}
            defaultValue={value(name + 'options', f?.options?.join('\n'))}
          />
        </label>
        <label htmlFor={`${base}-max`}>
          Text length limit (optional)
          <input
            id={`${base}-max`}
            type="number"
            name={name + 'maxLength'}
            min={1}
            max={50000}
            defaultValue={value(name + 'maxLength', f?.maxLength?.toString())}
          />
        </label>
      </fieldset>
    );
  }
  function relation(index: number) {
    const r = type?.relations[index],
      name = `relation_${index}_`,
      base = `${prefix}-relation-${index}`;
    return (
      <fieldset className="object-part" key={index}>
        <legend>Relation {index + 1}</legend>
        <label htmlFor={`${base}-label`}>
          Relation label
          <input
            id={`${base}-label`}
            name={name + 'label'}
            maxLength={120}
            defaultValue={value(name + 'label', r?.label)}
          />
        </label>
        <details open={Boolean(state.values?.[name + 'key'])}>
          <summary>Advanced connection settings</summary>
          <label htmlFor={`${base}-key`}>
            Relation key
            <input
              id={`${base}-key`}
              name={name + 'key'}
              pattern="[a-z][a-z0-9_]{0,62}"
              defaultValue={value(name + 'key', r?.key)}
              readOnly={Boolean(r)}
            />
          </label>
          <p className="muted">Ensemus makes a key from the label for you.</p>
        </details>
        <label htmlFor={`${base}-target`}>
          Related type
          <select
            id={`${base}-target`}
            name={name + 'toTypeSlug'}
            defaultValue={value(name + 'toTypeSlug', r?.toTypeSlug)}
          >
            <option value="">Choose a type</option>
            {types.map((t) => (
              <option key={t.slug} value={t.slug}>
                {t.displayName}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={`${base}-cardinality`}>
          How many
          <select
            id={`${base}-cardinality`}
            name={name + 'cardinality'}
            defaultValue={value(name + 'cardinality', r?.cardinality ?? 'many')}
          >
            <option value="many">Multiple records</option>
            <option value="one">One record</option>
          </select>
        </label>
      </fieldset>
    );
  }
  return (
    <>
      <div tabIndex={-1} ref={notice}>
        <ErrorNotice code={state.code} />
        {state.code === 'VERSION_CONFLICT' && type && (
          <p className="notice">
            Your unsaved values are still below. Reload to discard them and open the current record
            type.{' '}
            <ReloadLink href={`/o/${organizationId}/objects/types/${type.id}/edit`}>
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
      {state.notice && (
        <p role="status">
          {state.notice === 'field_added'
            ? 'Field added. Complete its details below.'
            : 'Connection added. Choose its details below.'}
        </p>
      )}
      <form key={state.revision ?? 0} action={action} className="card fields">
        <input type="hidden" name="organizationId" value={organizationId} />
        <input type="hidden" name="fieldRows" value={rows.fields} />
        <input type="hidden" name="relationRows" value={rows.relations} />
        {type ? (
          <>
            <input type="hidden" name="typeId" value={type.id} />
            <input type="hidden" name="version" value={value('version', String(type.version))} />
          </>
        ) : (
          <input type="hidden" name="requestKey" value={value('requestKey', requestKey)} />
        )}
        {!type && (
          <>
            <label htmlFor={`${prefix}-name`}>
              Type name
              <input
                id={`${prefix}-name`}
                name="displayName"
                required
                maxLength={120}
                defaultValue={value('displayName')}
              />
            </label>
            <details open={Boolean(state.values?.slug)}>
              <summary>Advanced type settings</summary>
              <label htmlFor={`${prefix}-slug`}>
                <span id={`${prefix}-slug-label`}>Type key</span>
                <input
                  id={`${prefix}-slug`}
                  aria-labelledby={`${prefix}-slug-label`}
                  aria-describedby={`${prefix}-slug-help`}
                  name="slug"
                  pattern="[a-z][a-z0-9_]{1,63}"
                  maxLength={64}
                  defaultValue={value('slug')}
                />
                <span className="muted" id={`${prefix}-slug-help`}>
                  Optional. A unique stable key is generated when you create this record type.
                  Choose your own only if an integration needs one.
                </span>
              </label>
            </details>
            <DescribedChoices
              id={`${prefix}-class`}
              name="classification"
              legend="Who can see its records"
              help="Every record of this type is at least this private. You can make it stricter later, but not looser."
              options={recordLevelChoices(['public', 'internal', 'confidential', 'restricted'])}
              defaultValue={value('classification', 'restricted')}
            />
          </>
        )}
        <section className="form-section" aria-labelledby={`${prefix}-fields-heading`}>
          <div className="section-intro">
            <h2 id={`${prefix}-fields-heading`}>Fields</h2>
            <p>
              The details your team fills in for each record. A saved field keeps its kind; you can
              add fields and choices later. Allow filtering on the fields people look things up by.
            </p>
          </div>
          {Array.from({ length: rows.fields }, (_, i) => field(i))}
        </section>
        {rows.relations > 0 && (
          <section className="form-section" aria-labelledby={`${prefix}-relations-heading`}>
            <div className="section-intro">
              <h2 id={`${prefix}-relations-heading`}>Connections to other records</h2>
              <p>
                Choose the other kinds of record this type can connect to. Each record keeps its own
                rules about who can see it.
              </p>
            </div>
            {Array.from({ length: rows.relations }, (_, i) => relation(i))}
          </section>
        )}
        <div className="row">
          <SubmitButton name="intent" value="save" working="Saving">
            {type ? 'Save a new version' : 'Create record type'}
          </SubmitButton>
          {rows.fields < OBJECT_LIMITS.maxFields && (
            <SubmitButton
              name="intent"
              value="add-field"
              className="secondary"
              working="Adding field"
              formNoValidate
            >
              Add another field
            </SubmitButton>
          )}
          {rows.relations < OBJECT_LIMITS.maxRelations && (
            <SubmitButton
              name="intent"
              value="add-relation"
              className="secondary"
              working="Adding connection"
              formNoValidate
            >
              Add a connection
            </SubmitButton>
          )}
        </div>
      </form>
    </>
  );
}
