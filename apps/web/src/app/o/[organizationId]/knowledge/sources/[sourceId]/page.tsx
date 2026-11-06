import { listDirectory, listTeams } from '@ensemus/application';
import { getSource } from '@ensemus/application/knowledge/sources';
import { canRaiseClass } from '@ensemus/domain/knowledge';
import Link from 'next/link';
import { KnowledgeForm } from '@/components/knowledge-form';
import { KNOWLEDGE_CLASSES, SourceLink } from '@/components/knowledge-view';
import {
  PageHead,
  ClassificationBadge,
  StatusBadge,
  formatBytes,
  formatDateTime,
} from '@/components/ui';
import {
  closeKnowledgeAction,
  changeSourceGrantsAction,
  raiseSourceClassAction,
} from '@/server/knowledge-actions';
import { requireTenant } from '@/server/tenant';
import { knowledgeOrNotFound as orNotFound } from '@/server/knowledge-page';
export const metadata = { title: 'Knowledge source | Ensemus' };
export default async function SourcePage({
  params,
}: {
  params: Promise<{ organizationId: string; sourceId: string }>;
}) {
  const { organizationId, sourceId } = await params,
    { context, database } = await requireTenant(organizationId),
    source = await orNotFound(getSource(database, context, sourceId)),
    base = `/o/${organizationId}/knowledge`,
    hidden = { organizationId, sourceId, version: String(source.version) };
  const [people, teams] = source.canManage
    ? await Promise.all([listDirectory(database, context), listTeams(database, context)])
    : [[], []];
  const principalName = (grant: (typeof source.grants)[number]) =>
    grant.kind === 'organization'
      ? 'Everyone in this organization'
      : grant.kind === 'membership'
        ? (people.find((p) => p.membershipId === grant.membershipId)?.name ?? 'Named person')
        : (teams.find((t) => t.id === grant.teamId)?.name ?? 'Named team');
  return (
    <>
      <Link href={base}>Back to sources</Link>
      <PageHead title={source.title ?? 'Source with limited access'} />
      <div className="row">
        <ClassificationBadge value={source.classification} />
        <StatusBadge status={source.state} />
      </div>
      {!source.canRead ? (
        <p className="notice">
          This source exists, but its contents are not shared with you. Managing a source does not
          grant access to its words.
        </p>
      ) : (
        <>
          <dl className="facts">
            <dt>Processing</dt>
            <dd>
              <StatusBadge status={source.documentState ?? 'unavailable'} />
            </dd>
            <dt>Semantic search</dt>
            <dd>
              <StatusBadge status={source.embeddingState ?? 'unavailable'} />
            </dd>
            <dt>Malware check</dt>
            <dd>
              {source.scanState === 'clean'
                ? 'Checked: no malware detected'
                : source.scanState === 'flagged'
                  ? 'Flagged by the configured scanner'
                  : 'Not scanned'}
            </dd>
            {source.sizeBytes !== null && (
              <>
                <dt>Size</dt>
                <dd>{formatBytes(source.sizeBytes)}</dd>
              </>
            )}
            {source.searchableAt && (
              <>
                <dt>Searchable since</dt>
                <dd>{formatDateTime(source.searchableAt)}</dd>
              </>
            )}
            {source.sourceModifiedAt && (
              <>
                <dt>Source updated</dt>
                <dd>{formatDateTime(source.sourceModifiedAt)}</dd>
              </>
            )}
          </dl>
          {source.documentState === 'searchable' ? (
            <p className="notice">
              This document is available in text search.{' '}
              {source.embeddingState === 'denied'
                ? 'Semantic indexing was refused by model policy; text search is still available.'
                : source.embeddingState === 'failed'
                  ? 'Semantic indexing could not finish; text search is still available.'
                  : source.embeddingState === 'pending' || source.embeddingState === 'embedding'
                    ? 'Semantic indexing is still pending.'
                    : ''}
            </p>
          ) : (
            <p className="notice">
              {source.documentState === 'rejected'
                ? 'This version was rejected and is not available in search.'
                : source.documentState === 'failed'
                  ? 'Processing did not finish. The background repair may try again while this source remains open.'
                  : 'The source is saved. Search will be available after background processing finishes.'}
            </p>
          )}
          {source.scanState === 'not_scanned' && (
            <p className="notice">
              No malware scan was performed. This is separate from access and sensitivity checks.
            </p>
          )}
          {source.documentId && source.state === 'active' && (
            <a
              className="button secondary"
              href={`/api/v1/organizations/${organizationId}/knowledge/documents/${source.documentId}/content`}
            >
              Download source file
            </a>
          )}
          <SourceLink url={source.sourceUrl} />
          {source.rejectCode && (
            <details>
              <summary>Processing details</summary>
              <p>{source.rejectCode}</p>
            </details>
          )}
        </>
      )}
      {source.state !== 'active' ? (
        <Link href={`${base}/sources/${sourceId}/purge`}>View removal progress</Link>
      ) : (
        source.canManage && (
          <section className="stack">
            <h2>Source access</h2>
            {source.grantsManagedByProvider ? (
              <p>
                Access follows the connected provider. Change permissions there, then sync the
                connection.
              </p>
            ) : (
              <>
                <ul>
                  {source.grants.map((grant) => (
                    <li key={grant.id}>
                      {principalName(grant)}
                      <KnowledgeForm
                        action={changeSourceGrantsAction}
                        hidden={{ ...hidden, removeGrantId: grant.id }}
                        submit={`Remove access for ${principalName(grant)}`}
                        fields={[]}
                      />
                    </li>
                  ))}
                </ul>
                <KnowledgeForm
                  action={changeSourceGrantsAction}
                  hidden={hidden}
                  submit="Add access"
                  fields={[
                    {
                      name: 'principal',
                      kind: 'select',
                      label: 'Share with',
                      required: true,
                      options: [
                        { value: '', label: 'Choose a person' },
                        ...(source.classification === 'public' ||
                        source.classification === 'internal'
                          ? [{ value: 'organization', label: 'Everyone in this organization' }]
                          : []),
                        ...people
                          .filter((p) => p.status === 'active')
                          .map((p) => ({ value: p.membershipId, label: p.name })),
                      ],
                    },
                  ]}
                />
              </>
            )}
            <details>
              <summary>Raise sensitivity</summary>
              <p>
                Raising sensitivity can make wider grants ineligible. It cannot be lowered here.
              </p>
              <KnowledgeForm
                action={raiseSourceClassAction}
                hidden={hidden}
                submit="Raise sensitivity"
                fields={[
                  {
                    name: 'classification',
                    kind: 'select',
                    label: 'New sensitivity',
                    required: true,
                    options: [
                      { value: '', label: 'Choose sensitivity' },
                      ...KNOWLEDGE_CLASSES.filter(
                        (c) =>
                          c.value !== source.classification &&
                          canRaiseClass(
                            source.classification,
                            c.value as typeof source.classification,
                          ),
                      ),
                    ],
                  },
                ]}
              />
            </details>
            <details>
              <summary>Remove this source</summary>
              <p>
                Access closes immediately. Background removal covers source bytes and derived
                content; holds and unfinished writes can delay confirmation.
              </p>
              <KnowledgeForm
                action={closeKnowledgeAction}
                hidden={hidden}
                submit="Close source and start removal"
                fields={[
                  {
                    name: 'operation',
                    kind: 'select',
                    label: 'Removal',
                    required: true,
                    options: [
                      { value: 'revoke', label: 'Revoke source access' },
                      { value: 'delete', label: 'Delete source' },
                    ],
                  },
                  {
                    name: 'reason',
                    kind: 'textarea',
                    label: 'Reason',
                    required: true,
                    maxLength: 2000,
                  },
                  {
                    name: 'confirm',
                    kind: 'checkbox',
                    label: 'I understand this source cannot be reopened',
                    required: true,
                  },
                ]}
              />
            </details>
          </section>
        )
      )}
    </>
  );
}
