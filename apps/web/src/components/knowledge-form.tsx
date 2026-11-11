'use client';
import Link from 'next/link';
import { useActionState, useEffect, useId, useRef } from 'react';
import type { KnowledgeField, KnowledgeFormState } from '@/lib/knowledge-form-state';
import { DescribedChoices, type DescribedChoice } from './knowledge-view';
import { SubmitButton } from './submit-button';
import { ClassificationBadge, Empty, ErrorNotice } from './ui';

/** A field, or a set of described choices that submits like a select under the same name. */
type FormField =
  | (KnowledgeField & { rows?: number; placeholder?: string })
  | (Omit<KnowledgeField, 'kind' | 'options'> & {
      kind: 'choices';
      options: readonly DescribedChoice[];
    });

/** Shared native form pattern for this surface: visible labels, preserved text after refusals,
 * focused errors and ordinary server submission when JavaScript is disabled. No separate styling. */
export function KnowledgeForm({
  action,
  fields,
  hidden,
  submit,
  description,
  className = 'card fields',
  submitClassName,
}: {
  action: (state: KnowledgeFormState, form: FormData) => Promise<KnowledgeFormState>;
  fields: readonly FormField[];
  hidden: Record<string, string>;
  submit: string;
  description?: string;
  /** The form's own classes. A form inside another surface drops the card. */
  className?: string;
  /** Secondary, ghost or danger, when this form is not the one primary action in its area. */
  submitClassName?: string;
}) {
  const [state, dispatch] = useActionState(action, {}),
    notice = useRef<HTMLDivElement>(null),
    resultHeading = useRef<HTMLHeadingElement>(null),
    prefix = useId();
  useEffect(() => {
    if (state.code) notice.current?.focus();
    else if (state.searched || state.simulation) resultHeading.current?.focus();
  }, [state]);
  const found = state.passages?.length ?? 0;
  return (
    <>
      <div className="form-notice" ref={notice} tabIndex={-1}>
        <ErrorNotice code={state.code} />
      </div>
      <form className={className} action={dispatch}>
        {description && <p className="muted">{description}</p>}
        {Object.entries(hidden).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={state.values?.[name] ?? value} />
        ))}
        {fields.map((field) => {
          const value = state.values?.[field.name] ?? field.value ?? '',
            help = field.help ? `${prefix}-${field.name}-help` : undefined,
            id = `${prefix}-${field.name}`;
          if (field.kind === 'choices')
            return (
              <DescribedChoices
                key={field.name}
                id={id}
                name={field.name}
                legend={field.label}
                help={field.help}
                options={field.options}
                defaultValue={value}
                required={field.required ?? false}
              />
            );
          return (
            <label key={field.name} htmlFor={id}>
              <span id={id + '-label'}>
                {field.label}
                {field.required ? '' : ' (optional)'}
              </span>
              {field.help && <small id={help}>{field.help}</small>}
              {field.kind === 'select' ? (
                <select
                  id={id}
                  aria-labelledby={id + '-label'}
                  name={field.name}
                  required={field.required}
                  defaultValue={value}
                  aria-describedby={help}
                >
                  {field.options?.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : field.kind === 'textarea' ? (
                <textarea
                  id={id}
                  aria-labelledby={id + '-label'}
                  name={field.name}
                  required={field.required}
                  maxLength={field.maxLength}
                  defaultValue={value}
                  rows={field.rows ?? 5}
                  placeholder={field.placeholder}
                  aria-describedby={help}
                />
              ) : field.kind === 'checkbox' ? (
                <input
                  id={id}
                  aria-labelledby={id + '-label'}
                  name={field.name}
                  type="checkbox"
                  value="yes"
                  required={field.required}
                  defaultChecked={value === 'yes'}
                  aria-describedby={help}
                />
              ) : (
                <input
                  id={id}
                  aria-labelledby={id + '-label'}
                  name={field.name}
                  type={field.kind === 'file' ? 'file' : field.kind === 'email' ? 'email' : 'text'}
                  required={field.required}
                  maxLength={field.maxLength}
                  defaultValue={field.kind === 'file' ? undefined : value}
                  accept={field.kind === 'file' ? '.txt,.md,.csv,.html,.htm,.json' : undefined}
                  placeholder={field.placeholder}
                  aria-describedby={help}
                />
              )}
            </label>
          );
        })}
        <div className="row">
          <SubmitButton className={submitClassName}>{submit}</SubmitButton>
        </div>
      </form>
      {state.searched && (
        <section aria-label="Source passages" className="stack">
          <div className="section-heading">
            <h2 tabIndex={-1} ref={resultHeading}>
              Source passages
            </h2>
            {found > 0 && (
              <p>
                {found} {found === 1 ? 'passage' : 'passages'} found in documents you can read
              </p>
            )}
          </div>
          {!found ? (
            <Empty title="No matching passages">
              Nothing in the documents you can read uses those words. Try fewer or different words.
            </Empty>
          ) : (
            <div className="card">
              <ol className="list result-list">
                {state.passages!.map((p) => (
                  <li key={p.chunkId}>
                    <p className="pre-wrap result-snippet">{p.text}</p>
                    <div className="row result-meta">
                      <span>
                        From{' '}
                        <Link href={`/o/${hidden.organizationId}/knowledge/sources/${p.sourceId}`}>
                          {p.title}
                        </Link>
                      </span>
                      <ClassificationBadge value={p.classification} />
                      <Link
                        className="result-action"
                        href={`/o/${hidden.organizationId}/knowledge/facts/new?chunk=${p.chunkId}`}
                      >
                        Propose a fact from this passage
                      </Link>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </section>
      )}
      {state.simulation && (
        <section aria-label="Simulation result" className="stack">
          <h2 tabIndex={-1} ref={resultHeading}>
            What this proposal would allow
          </h2>
          {state.coverage !== 'complete' && (
            <p className="notice">
              This deployment has not connected the complete agent policy reader. These results
              cover knowledge only and refuse every transmission until the real policy is available.
            </p>
          )}
          {!state.simulation.length ? (
            <Empty>No current workloads were available to compare.</Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <caption>
                  Data-sharing policy for this proposal. This comparison sends nothing.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Workload</th>
                    <th scope="col">Sensitivity</th>
                    <th scope="col">Policy permits sharing?</th>
                    <th scope="col">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {state.simulation.map((row, i) => (
                    <tr key={i}>
                      <td>
                        {row.key} · {row.purpose}
                      </td>
                      <td>
                        <ClassificationBadge value={row.classification} />
                      </td>
                      <td>
                        {row.wouldTransmit ? 'Compatible with this proposal' : 'Not permitted'}
                      </td>
                      <td>{row.reasonCode}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </>
  );
}
