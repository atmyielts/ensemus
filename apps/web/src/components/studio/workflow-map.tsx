'use client';
import { useEffect, useState, type MouseEvent } from 'react';
import type { ProcessDraftView } from '@ensemus/application/process-specs';
import type { GraphLayout, MapNode } from '@/lib/graph-layout';
import { WORKFLOW_KIND_NAMES, WORKFLOW_ISSUES } from '@/lib/process-studio-present';
import { WorkflowIssues } from './workflow-overview';
import { useWorkflowEditor } from './workflow-editor-state';
import { RemoveWorkflowConnection } from './workflow-connection-form';
import styles from './workflow-map.module.css';
const pointLabel = (node: MapNode) =>
  node.label.trim().replace(/\s+/gu, ' ') || 'Unnamed saved point';
const nodeName = (node: MapNode) => `Point ${node.index + 1}: ${pointLabel(node)}`;
// Preserve actual word boundaries in SVG text without inserting spaces into wrapped long words.
function labelLines(node: MapNode) {
  const label = pointLabel(node);
  let cursor = 0;
  return node.lines.map((line) => {
    cursor += line.length;
    const space = label[cursor] === ' ';
    if (space) cursor++;
    return `${line}${space ? ' ' : ''}`;
  });
}
function kindName(node: MapNode) {
  return node.kind !== null && Object.hasOwn(WORKFLOW_KIND_NAMES, node.kind)
    ? WORKFLOW_KIND_NAMES[node.kind as keyof typeof WORKFLOW_KIND_NAMES]
    : 'Unrecognized point type';
}
function edgeName(layout: GraphLayout, identity: string | null) {
  if (identity === null) return 'An endpoint needs review';
  const nodes = layout.nodes.filter((node) => node.id === identity);
  return nodes.length === 1 && nodes[0]
    ? nodeName(nodes[0])
    : nodes.length
      ? 'A duplicated point identity'
      : 'A missing point';
}
const reviewText = (node: MapNode, hasIssue: boolean) =>
  node.duplicate
    ? 'Review duplicated identity'
    : node.cyclic
      ? 'Review looping connections'
      : !node.knownKind
        ? 'Review point type'
        : node.unresolved
          ? 'Review missing connections'
          : hasIssue
            ? 'Review saved settings'
            : new Set(node.incoming).size > 1
              ? 'Waits for all earlier points'
              : new Set(node.outgoing).size > 1
                ? 'Continues along every path'
                : 'Go to its edit form';
export function WorkflowMap({
  draft,
  layout,
  id,
  editHref,
  editing = false,
  readOnly = false,
  organizationId,
  repairKey,
}: {
  draft: ProcessDraftView;
  layout: GraphLayout;
  id: string;
  editHref: string;
  editing?: boolean;
  readOnly?: boolean;
  organizationId: string;
  repairKey?: string;
}) {
  const editor = useWorkflowEditor(),
    saved = editor?.draft.id === draft.id ? editor.draft : draft,
    picture = editor?.draft.id === draft.id ? editor.layout : layout,
    [selected, setSelected] = useState(''),
    listId = `${id}-points`,
    heading = `${id}-heading`,
    description = `${id}-help`,
    arrow = `${id}-arrow`,
    loopArrow = `${id}-loop-arrow`;
  const targetHref = (node: MapNode) =>
    editing ? `#${node.editTarget}` : `${editHref}#${node.editTarget}`;
  const reveal = (target: string) => {
    const element = document.getElementById(target);
    element?.closest('details')?.setAttribute('open', '');
    if (element instanceof HTMLElement) element.focus({ preventScroll: true });
    setSelected(target);
  };
  useEffect(() => {
    const changed = () => {
      let target: string;
      try {
        target = decodeURIComponent(window.location.hash.slice(1));
      } catch {
        return;
      }
      if (
        target === listId ||
        (editing && picture.nodes.some((node) => node.editTarget === target))
      )
        reveal(target);
    };
    changed();
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, [editing, listId, picture]);
  const choose = (event: MouseEvent<Element>, target: string) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
      return;
    if (editing || target === listId) reveal(target);
  };
  const Heading = editing ? 'h2' : 'h3',
    unresolved = picture.edges.filter((edge) => edge.issue),
    needsReview =
      saved.issues.length > 0 ||
      picture.hasCycles ||
      unresolved.length > 0 ||
      picture.nodes.some((node) => node.duplicate || !node.knownKind);
  return (
    <section className={styles.section} aria-labelledby={heading}>
      <div className={styles.heading}>
        <Heading id={heading}>Workflow map</Heading>
        <a href={`#${listId}`} onClick={(event) => choose(event, listId)}>
          Browse as a point list
        </a>
      </div>
      <p id={description} className="muted">
        Saved revision {saved.version}. Arrows show the direction of the saved connections. Parallel
        paths all continue; a join waits for every earlier point.{' '}
        {readOnly
          ? 'This archived definition is read-only.'
          : 'Choose a point to go to its edit form.'}
      </p>
      {needsReview && (
        <p className="notice">
          Some saved points or connections need review. They remain visible here while you correct
          the definition.
        </p>
      )}
      {picture.visual ? (
        <>
          <div
            className={styles.viewport}
            tabIndex={0}
            role="region"
            aria-label="Scrollable workflow map"
            aria-describedby={description}
          >
            <svg
              className={styles.diagram}
              width={picture.width}
              height={picture.height}
              viewBox={`0 0 ${picture.width} ${picture.height}`}
              role="group"
              aria-label="Saved workflow connections"
              aria-describedby={description}
            >
              <defs>
                <marker
                  id={arrow}
                  viewBox="0 0 6 6"
                  refX="6"
                  refY="3"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto"
                >
                  <path className={styles.arrow} d="M 0 0 L 6 3 L 0 6 z" />
                </marker>
                <marker
                  id={loopArrow}
                  viewBox="0 0 6 6"
                  refX="6"
                  refY="3"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto"
                >
                  <path className={styles.loopArrow} d="M 0 0 L 6 3 L 0 6 z" />
                </marker>
              </defs>
              <g aria-hidden="true">
                {picture.edges
                  .filter((edge) => !edge.issue)
                  .map((edge) => (
                    <path
                      key={edge.index}
                      data-workflow-edge={edge.index}
                      d={edge.path}
                      className={`${styles.edge}${edge.cyclic ? ` ${styles.loop}` : ''}`}
                      markerEnd={`url(#${edge.cyclic ? loopArrow : arrow})`}
                    >
                      <title>{`${edgeName(picture, edge.from)} to ${edgeName(picture, edge.to)}${edge.cyclic ? ' — loop needs review' : ''}`}</title>
                    </path>
                  ))}
              </g>
              {[...picture.nodes]
                .sort((a, b) => a.rank - b.rank || a.y - b.y || a.index - b.index)
                .map((node) => {
                  const issues = saved.issues.filter(
                      (issue) => issue.nodeId !== null && issue.nodeId === node.id,
                    ),
                    review =
                      node.duplicate ||
                      node.cyclic ||
                      node.unresolved ||
                      !node.knownKind ||
                      issues.length > 0,
                    caption =
                      readOnly && !review ? 'Saved point' : reviewText(node, issues.length > 0);
                  const contents = (
                    <>
                      <rect
                        className={`${styles.node}${review ? ` ${styles.needsReview}` : ''}`}
                        x={node.x}
                        y={node.y}
                        width={node.width}
                        height={node.height}
                      />
                      <title>{`${nodeName(node)}. ${kindName(node)}. ${caption}.`}</title>
                      <text className={styles.small} x={node.x + 16} y={node.y + 23}>
                        {`Point ${node.index + 1} `}
                      </text>
                      <text className={styles.label} x={node.x + 16} y={node.y + 46}>
                        {labelLines(node).map((line, index) => (
                          <tspan x={node.x + 16} dy={index === 0 ? 0 : 22} key={index}>
                            {`${line}${index === node.lines.length - 1 ? ' ' : ''}`}
                          </tspan>
                        ))}
                      </text>
                      <text
                        className={styles.small}
                        x={node.x + 16}
                        y={node.y + node.lines.length * 22 + 48}
                      >
                        {`${kindName(node)} `}
                      </text>
                      <text
                        className={`${styles.small}${review ? ` ${styles.reviewLabel}` : ''}`}
                        x={node.x + 16}
                        y={node.y + node.lines.length * 22 + 68}
                      >
                        {caption}
                      </text>
                    </>
                  );
                  return readOnly ? (
                    <g
                      key={node.index}
                      data-workflow-point={node.index}
                      aria-label={`${nodeName(node)}. ${kindName(node)}. ${caption}.`}
                    >
                      {contents}
                    </g>
                  ) : (
                    <a
                      key={node.index}
                      data-workflow-point={node.index}
                      href={targetHref(node)}
                      className={`${styles.pointLink}${selected === node.editTarget ? ` ${styles.selected}` : ''}`}
                      aria-label={`Edit ${nodeName(node)}. ${kindName(node)}. ${caption}.`}
                      aria-current={selected === node.editTarget ? 'location' : undefined}
                      onClick={(event) => choose(event, node.editTarget)}
                    >
                      {contents}
                    </a>
                  );
                })}
            </svg>
          </div>
          <div className={styles.legend} aria-label="Connection legend">
            <span className={styles.legendItem}>
              <span className={styles.legendLine} aria-hidden="true" />
              Saved direction →
            </span>
            {picture.hasCycles && (
              <span className={styles.legendItem}>
                <span className={`${styles.legendLine} ${styles.legendLoop}`} aria-hidden="true" />
                Loop to correct
              </span>
            )}
          </div>
        </>
      ) : (
        <p className="notice">
          {picture.oversized
            ? 'This definition is too large for the map view. Every saved point and connection is listed below.'
            : 'No saved points are available to draw yet. Add the points using the editor below.'}
        </p>
      )}
      <details open={picture.oversized || !picture.nodes.length}>
        <summary>
          All points and connections ({picture.nodes.length} points, {picture.edges.length}{' '}
          connections)
        </summary>
        <ul id={listId} tabIndex={-1} className="list" aria-label="Workflow map point list">
          {picture.nodes.map((node) => {
            const issues = saved.issues.filter(
              (issue) => issue.nodeId !== null && issue.nodeId === node.id,
            );
            return (
              <li key={node.index}>
                <div className="fields">
                  {readOnly ? (
                    <strong className={styles.pointName}>{nodeName(node)}</strong>
                  ) : (
                    <a
                      className={styles.pointName}
                      href={targetHref(node)}
                      onClick={(event) => choose(event, node.editTarget)}
                    >
                      {nodeName(node)}
                    </a>
                  )}
                  <p className="muted">{kindName(node)}</p>
                  <dl className="details">
                    <div>
                      <dt>Earlier points — all required</dt>
                      <dd>
                        {picture.edges
                          .filter((edge) => edge.to === node.id)
                          .map((edge) => edgeName(picture, edge.from))
                          .join('; ') || 'None'}
                      </dd>
                    </div>
                    <div>
                      <dt>Later points — every path continues</dt>
                      <dd>
                        {picture.edges
                          .filter((edge) => edge.from === node.id)
                          .map((edge) => edgeName(picture, edge.to))
                          .join('; ') || 'None'}
                      </dd>
                    </div>
                  </dl>
                  {(node.duplicate || node.cyclic || !node.knownKind || node.unresolved) && (
                    <p className="notice">{reviewText(node, issues.length > 0)}.</p>
                  )}
                  {issues.length > 0 && (
                    <ul>
                      {issues.map((issue, index) => (
                        <li key={index}>
                          {WORKFLOW_ISSUES[issue.code] ?? 'Review this saved point’s settings.'}
                        </li>
                      ))}
                    </ul>
                  )}
                  <details>
                    <summary>Saved point details</summary>
                    <p>
                      Identity: <code>{node.id ?? 'Not recorded'}</code>
                    </p>
                    <p>
                      Type: <code>{node.kind ?? 'Not recorded'}</code>
                    </p>
                  </details>
                </div>
              </li>
            );
          })}
        </ul>
        <ol className={styles.connectionList} aria-label="Every saved workflow connection">
          {picture.edges.map((edge) => (
            <li key={edge.index}>
              <span>
                {edgeName(picture, edge.from)} → {edgeName(picture, edge.to)}
              </span>
              {edge.issue && (
                <p className="notice">
                  {edge.issue === 'ambiguous'
                    ? 'A duplicated identity makes this connection ambiguous. Review that point group before choosing the intended path.'
                    : 'An endpoint is missing. This connection has not been redirected to another point.'}
                </p>
              )}
              {edge.cyclic && (
                <p className="notice">
                  This saved connection loops back. Correct the loop before rehearsing.
                </p>
              )}
              {edge.repeated && <p className="muted">This is a repeated saved connection.</p>}
              {editing &&
                edge.issue === 'missing' &&
                !picture.nodes.some((node) => node.id === edge.from || node.id === edge.to) &&
                edge.from !== null &&
                edge.to !== null && (
                  <RemoveWorkflowConnection
                    key={`${saved.version}:${edge.index}:${edge.from}:${edge.to}`}
                    requestKey={`${repairKey ?? id}:edge:${saved.version}:${edge.index}`}
                    organizationId={organizationId}
                    draftId={saved.id}
                    version={saved.version}
                    edge={{ index: edge.index, from: edge.from, to: edge.to }}
                  />
                )}
              <details>
                <summary>Connection details</summary>
                <p>
                  From: <code>{edge.from ?? 'Not recorded'}</code>
                </p>
                <p>
                  To: <code>{edge.to ?? 'Not recorded'}</code>
                </p>
              </details>
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}
export function WorkflowMapChecks() {
  const editor = useWorkflowEditor();
  if (!editor) return null;
  return (
    <section className="card fields" aria-labelledby="edit-workflow-checks">
      <h2 id="edit-workflow-checks">Current definition checks</h2>
      <WorkflowIssues graph={editor.draft.graph} issues={editor.draft.issues} />
      {!editor.draft.specSha256 && !editor.draft.issues.length && (
        <p className="notice">
          Save the definition with its current choices before requesting a rehearsal.
        </p>
      )}
    </section>
  );
}
