'use client';
import Link from 'next/link';
import { useActionState, useEffect, useId, useRef } from 'react';
import type { KnowledgeField, KnowledgeFormState } from '@/lib/knowledge-form-state';
import { SubmitButton } from './submit-button';
import { ClassificationBadge, Empty, ErrorNotice } from './ui';

/** Shared native form pattern for this surface: visible labels, preserved text after refusals,
 * focused errors and ordinary server submission when JavaScript is disabled. No separate styling. */
export function KnowledgeForm({
  action,
  fields,
  hidden,
  submit,
  description,
}: {
  action: (state: KnowledgeFormState, form: FormData) => Promise<KnowledgeFormState>;
  fields: readonly KnowledgeField[];
  hidden: Record<string, string>;
  submit: string;
  description?: string;
}) {
  const [state, dispatch] = useActionState(action, {}),
    notice = useRef<HTMLDivElement>(null),
    resultHeading = useRef<HTMLHeadingElement>(null),
    prefix = useId();
  useEffect(() => {
    if (state.code) notice.current?.focus();
    else if (state.searched || state.simulation) resultHeading.current?.focus();
  }, [state]);
  return (
    <>
      <div ref={notice} tabIndex={-1}>
        <ErrorNotice code={state.code} />
      </div>
      <form className="card fields" action={dispatch}>
        {description && <p className="muted">{description}</p>}
        {Object.entries(hidden).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={state.values?.[name] ?? value} />
        ))}
        {fields.map((field) => {
          const value = state.values?.[field.name] ?? field.value ?? '',
            help = field.help ? `${prefix}-${field.name}-help` : undefined,
            id = `${prefix}-${field.name}`;
          return (
            <label key={field.name} htmlFor={id}>
              <span id={id + '-label'}>
                {field.label}
                {field.required ? '' : ' (optional)'}
              </span>
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
                  rows={5}
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
                  aria-describedby={help}
                />
              )}
              {field.help && <small id={help}>{field.help}</small>}
            </label>
          );
        })}
        <div className="row">
          <SubmitButton>{submit}</SubmitButton>
        </div>
      </form>
      {state.searched && (
        <section aria-label="Source passages" className="stack">
          <h2 tabIndex={-1} ref={resultHeading}>
            Source passages
          </h2>
          {!state.passages?.length ? (
            <Empty>No matching passages in sources you can read. Try different words.</Empty>
          ) : (
            state.passages.map((p) => (
              <article className="card" key={p.chunkId}>
                <h3>
                  <Link href={`/o/${hidden.organizationId}/knowledge/sources/${p.sourceId}`}>
                    {p.title}
                  </Link>
                </h3>
                <ClassificationBadge value={p.classification} />
                <p className="pre-wrap">{p.text}</p>
                <Link href={`/o/${hidden.organizationId}/knowledge/facts/new?chunk=${p.chunkId}`}>
                  Propose a fact from this passage
                </Link>
              </article>
            ))
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
