'use client';
import { useActionState, useEffect, useId, useRef } from 'react';
import type { ObjectTypeView } from '@ensemus/application/custom-objects';
import { saveObjectTypeAction } from '@/server/object-actions';
import type { ObjectFormState } from '@/lib/object-input';
import { SubmitButton } from '../submit-button';
import { ErrorNotice } from '../ui';

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
export function ObjectTypeForm({
  organizationId,
  type,
  types,
  requestKey,
}: {
  organizationId: string;
  type?: ObjectTypeView;
  types: readonly { slug: string; displayName: string }[];
  requestKey?: string;
}) {
  const [state, action] = useActionState<ObjectFormState, FormData>(saveObjectTypeAction, {}),
    prefix = useId(),
    notice = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.code) notice.current?.focus();
  }, [state]);
  const value = (key: string, initial = '') => state.values?.[key] ?? initial;
  function field(index: number) {
    const f = type?.fields[index],
      name = `field_${index}_`,
      base = `${prefix}-field-${index}`;
    return (
      <fieldset className="fields" key={index}>
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
        <label htmlFor={`${base}-key`}>
          Field key
          <input
            id={`${base}-key`}
            name={name + 'key'}
            pattern="[a-z][a-z0-9_]{0,62}"
            maxLength={63}
            defaultValue={value(name + 'key', f?.key)}
          />
        </label>
        <label htmlFor={`${base}-kind`}>
          Kind
          <select
            id={`${base}-kind`}
            name={name + 'kind'}
            defaultValue={value(name + 'kind', f?.kind ?? 'text')}
          >
            {kinds.map((k) => (
              <option key={k} value={k}>
                {kindLabels[k]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            name={name + 'required'}
            defaultChecked={
              state.values ? value(name + 'required') === 'on' : (f?.required ?? false)
            }
          />
          Required
        </label>
        <label>
          <input
            type="checkbox"
            name={name + 'indexed'}
            defaultChecked={state.values ? value(name + 'indexed') === 'on' : (f?.indexed ?? false)}
          />
          Allow filtering (up to eight fields; long text cannot be filtered)
        </label>
        <label htmlFor={`${base}-options`}>
          Choices, one per line (Choice fields only)
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
      <fieldset className="fields" key={index}>
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
        <label htmlFor={`${base}-key`}>
          Relation key
          <input
            id={`${base}-key`}
            name={name + 'key'}
            pattern="[a-z][a-z0-9_]{0,62}"
            defaultValue={value(name + 'key', r?.key)}
          />
        </label>
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
      </div>
      <form key={state.revision ?? 0} action={action} className="card fields">
        <input type="hidden" name="organizationId" value={organizationId} />
        {type ? (
          <>
            <input type="hidden" name="typeId" value={type.id} />
            <input type="hidden" name="version" value={type.version} />
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
            <label htmlFor={`${prefix}-slug`}>
              Type key
              <input
                id={`${prefix}-slug`}
                name="slug"
                required
                pattern="[a-z][a-z0-9_]{1,63}"
                maxLength={64}
                defaultValue={value('slug')}
              />
              <span className="muted">
                A stable key such as supplier or device. Use lowercase letters, numbers and
                underscores.
              </span>
            </label>
            <label htmlFor={`${prefix}-class`}>
              Minimum sensitivity
              <select
                id={`${prefix}-class`}
                name="classification"
                defaultValue={value('classification', 'restricted')}
              >
                {['public', 'internal', 'confidential', 'restricted'].map((c) => (
                  <option key={c} value={c}>
                    {c[0]?.toUpperCase() + c.slice(1)}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <p className="muted">
          Leave unused rows blank. Saved field keys and kinds stay stable. Existing fields cannot be
          removed, made required, or shortened; choices can be added. Indexed fields are the only
          ones available for filtering.
        </p>
        {Array.from({ length: Math.max(1, type?.fields.length ?? 1) }, (_, i) => field(i))}
        <details>
          <summary>Add fields</summary>
          <div className="stack">
            {Array.from({ length: 64 - Math.max(1, type?.fields.length ?? 1) }, (_, i) =>
              field(i + Math.max(1, type?.fields.length ?? 1)),
            )}
          </div>
        </details>
        <details>
          <summary>Relations to other custom records</summary>
          <p className="muted">
            Relations do not grant access to either record. Both ends must remain readable.
          </p>
          <div className="stack">{Array.from({ length: 16 }, (_, i) => relation(i))}</div>
        </details>
        <SubmitButton working="Saving">{type ? 'Save a new version' : 'Create type'}</SubmitButton>
      </form>
    </>
  );
}
