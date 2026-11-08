'use client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import type { ProcessDraftView } from '@ensemus/application/process-specs';
import {
  sameAfterOrphanRemoval,
  type ConnectionIdentity,
  type GraphLayout,
} from '@/lib/graph-layout';
import { useKept } from '../kept-field';
type Receipt = { fromVersion: number; toVersion: number };
type Editor = {
  draft: ProcessDraftView;
  layout: GraphLayout;
  receipt: Receipt | null;
  accept: (
    next: ProcessDraftView,
    layout: GraphLayout,
    fromVersion: number,
    edge: ConnectionIdentity,
  ) => boolean;
  held: (key: string, version: number | null) => void;
};
const Context = createContext<Editor | null>(null);
export const useWorkflowEditor = () => useContext(Context);
export function WorkflowEditorState({
  draft,
  layout,
  children,
}: {
  draft: ProcessDraftView;
  layout: GraphLayout;
  children: ReactNode;
}) {
  const [saved, setSaved] = useState(draft),
    [picture, setPicture] = useState(layout),
    [receipt, setReceipt] = useState<Receipt | null>(null),
    [held, setHeld] = useState<ReadonlyMap<string, number>>(new Map()),
    source = useRef(draft.version),
    current = useRef(saved);
  current.current = saved;
  useEffect(() => {
    if (source.current !== draft.version) {
      source.current = draft.version;
      setSaved(draft);
      setPicture(layout);
      setReceipt(null);
    }
  }, [draft, layout]);
  const register = useCallback(
    (key: string, version: number | null) =>
      setHeld((previous) => {
        if (previous.get(key) === (version ?? undefined)) return previous;
        const next = new Map(previous);
        if (version === null) next.delete(key);
        else next.set(key, version);
        return next;
      }),
    [],
  );
  const accept = useCallback(
    (
      next: ProcessDraftView,
      nextLayout: GraphLayout,
      fromVersion: number,
      edge: ConnectionIdentity,
    ) => {
      const before = current.current;
      if (before.version !== fromVersion || !sameAfterOrphanRemoval(before, next, edge))
        return false;
      current.current = next;
      setSaved(next);
      setPicture(nextLayout);
      setReceipt({ fromVersion, toVersion: next.version });
      return true;
    },
    [],
  );
  const value = useMemo(
      () => ({ draft: saved, layout: picture, receipt, accept, held: register }),
      [saved, picture, receipt, accept, register],
    ),
    conflicted = [...held.values()].some((version) => version < saved.version);
  return (
    <Context.Provider value={value}>
      {receipt && (
        <p className="notice" role="status">
          The connection was removed. Your other form entries are still here.
        </p>
      )}
      {conflicted && (
        <div className="notice" role="status">
          <p>
            Your form entries are kept from an earlier revision. Their original version checks still
            apply.
          </p>
          <WorkflowReloadFields />
        </div>
      )}
      {children}
    </Context.Provider>
  );
}
type Fields = { baseVersion: number; values: Record<string, string[]>; submitted: boolean };
const allowed = new Set([
  'requestKey',
  'name',
  'classification',
  'nodeId',
  'label',
  'kind',
  'agentDefinitionId',
  'toolId',
  'approverRole',
  'evidence',
  'previous',
  'next',
  'replaceDirect',
  'version',
]);
function capture(form: HTMLFormElement, submitted: boolean): Fields {
  const values: Record<string, string[]> = {};
  for (const field of form.elements)
    if (field instanceof HTMLInputElement && allowed.has(field.name) && field.type === 'checkbox')
      values[field.name] ??= [];
  for (const [key, value] of new FormData(form))
    if (allowed.has(key) && typeof value === 'string') (values[key] ??= []).push(value);
  return { baseVersion: Number(values.version?.[0] ?? 0), values, submitted };
}
const one = (fields: Fields, name: string) => fields.values[name]?.[0] ?? '';
const sameSet = (a: readonly string[], b: readonly string[]) =>
  JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());
function wasSaved(fields: Fields, key: string, draft: ProcessDraftView): boolean {
  if (!fields.submitted || draft.version <= fields.baseVersion) return false;
  if (key === 'details')
    return (
      one(fields, 'name').trim() === draft.name &&
      one(fields, 'classification') === draft.classification
    );
  const id = one(fields, 'nodeId'),
    node = draft.graph.nodes.find((node) => node.id === id);
  if (
    !node ||
    draft.graph.nodes.filter((node) => node.id === id).length !== 1 ||
    node.kind !== one(fields, 'kind') ||
    node.label !== one(fields, 'label').trim()
  )
    return false;
  if (
    !sameSet(
      fields.values.previous ?? [],
      draft.graph.edges.filter((edge) => edge.to === id).map((edge) => edge.from),
    ) ||
    !sameSet(
      fields.values.next ?? [],
      draft.graph.edges.filter((edge) => edge.from === id).map((edge) => edge.to),
    )
  )
    return false;
  if (
    node.kind === 'agent_task' &&
    (node.agentDefinitionId ?? '').toLowerCase() !== one(fields, 'agentDefinitionId').toLowerCase()
  )
    return false;
  if (node.kind === 'external_action' && (node.toolId ?? '') !== one(fields, 'toolId'))
    return false;
  if (node.kind === 'human_approval' && (node.approverRole ?? '') !== one(fields, 'approverRole'))
    return false;
  if (node.kind === 'evidence_check' && (node.evidence ?? '') !== one(fields, 'evidence'))
    return false;
  return true;
}
/** Existing tab-memory privacy scope, plus a pinned version. No storage or hidden automatic retry. */
export function useWorkflowFields({
  draftId,
  key,
  version,
  state,
}: {
  draftId: string | undefined;
  key: string;
  version: number | undefined;
  state: { code?: string; values?: Record<string, string[]>; revision?: number };
}) {
  const editor = useWorkflowEditor(),
    enabled = editor !== null && editor.draft.id === draftId,
    kept = useKept<Fields>(`workflow:${draftId ?? 'new'}:${key}`),
    [snapshot, setSnapshot] = useState<Fields | undefined>(() =>
      enabled ? kept.read() : undefined,
    ),
    [settledRevision, setSettledRevision] = useState(-1),
    form = useRef<HTMLFormElement>(null);
  const write = useCallback(
    (next: Fields) => {
      kept.write(next);
      setSnapshot(next);
    },
    [kept],
  );
  useEffect(() => {
    if (!enabled) return;
    editor?.held(key, snapshot?.baseVersion ?? null);
    return () => editor?.held(key, null);
  }, [enabled, editor?.held, key, snapshot?.baseVersion]);
  useEffect(() => {
    const receipt = editor?.receipt;
    if (!enabled || !receipt || snapshot?.baseVersion !== receipt.fromVersion) return;
    write({
      ...snapshot,
      baseVersion: receipt.toVersion,
      values: { ...snapshot.values, version: [String(receipt.toVersion)] },
    });
  }, [editor?.receipt, enabled, snapshot, write]);
  useEffect(() => {
    if (!enabled || !snapshot || state.code || !editor || !wasSaved(snapshot, key, editor.draft))
      return;
    kept.forget();
    setSnapshot(undefined);
    setSettledRevision(state.revision ?? 0);
    requestAnimationFrame(() => form.current?.reset());
  }, [editor?.draft, enabled, snapshot, state.code, state.revision, key, kept]);
  const values =
      snapshot?.values ?? ((state.revision ?? 0) > settledRevision ? state.values : undefined),
    baseVersion =
      snapshot?.baseVersion ??
      (values?.version?.[0]
        ? Number(values.version[0])
        : enabled
          ? editor?.draft.version
          : version);
  const changed = (event: FormEvent<HTMLFormElement>) => {
    if (enabled) write(capture(event.currentTarget, false));
  };
  const submitted = (event: FormEvent<HTMLFormElement>) => {
    if (enabled) write(capture(event.currentTarget, true));
  };
  return {
    form,
    values,
    version: baseVersion,
    code: (state.revision ?? 0) > settledRevision ? state.code : undefined,
    onChange: changed,
    onSubmit: submitted,
  };
}

export function WorkflowReloadFields() {
  return (
    <details>
      <summary>Review the latest saved values</summary>
      <p>
        Reloading replaces the kept form entries in this tab with the saved workflow. Copy any text
        you still need first.
      </p>
      <button
        className="secondary"
        type="button"
        onClick={() => window.location.assign(window.location.pathname)}
      >
        Discard kept entries and reload saved workflow
      </button>
    </details>
  );
}
