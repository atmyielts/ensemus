import { listDirectory, listTeams } from '@ensemus/application';
import { getSource } from '@ensemus/application/knowledge/sources';
import { canRaiseClass, grantAllowedFor } from '@ensemus/domain/knowledge';
import Link from 'next/link';
import { KnowledgeForm } from '@/components/knowledge-form';
import { KNOWLEDGE_CLASSES, SourceLink } from '@/components/knowledge-view';
import { sourceSharingChoices } from '@/lib/knowledge-source-view';
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
  uploadKnowledgeVersionAction,
} from '@/server/knowledge-actions';
import { requireTenant } from '@/server/tenant';
import { knowledgeOrNotFound as orNotFound } from '@/server/knowledge-page';
export const metadata = { title: 'Knowledge source | Ensemus' };
export default async function SourcePage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string; sourceId: string }>;
  searchParams: Promise<{ version_result?: string }>;
}) {
  const { organizationId, sourceId } = await params,
    { context, database } = await requireTenant(organizationId),
    source = await orNotFound(getSource(database, context, sourceId)),
    base = `/o/${organizationId}/knowledge`,
    hidden = { organizationId, sourceId, version: String(source.version) };
  const { version_result: versionResult } = await searchParams;
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
      {source.state === 'active' &&
        source.kind === 'upload' &&
        source.canRead &&
        source.canManage && (
          <section className="stack" id="source-versions" aria-labelledby="source-versions-heading">
            <h2 id="source-versions-heading">Source versions</h2>
            {versionResult === 'saved' && (
              <p className="notice" role="status">
                The replacement file was saved. Its current processing state is shown below.
              </p>
            )}
            {versionResult === 'unchanged' && (
              <p className="notice" role="status">
                These same bytes and source name already belong to the latest version. No extra
                version was created.
              </p>
            )}
            {source.latestVersion ? (
              <>
                <p>
                  Latest version: {source.latestVersion.number} ·{' '}
                  <StatusBadge status={source.latestVersion.state} />
                </p>
                {source.latestVersion.id !== source.documentId &&
                  source.documentState === 'searchable' && (
                    <p className="notice">
                      {['failed', 'rejected'].includes(source.latestVersion.state)
                        ? 'The replacement has not become searchable. The previous published version is still available.'
                        : 'The previous published version stays available while the incoming version is processed.'}
                    </p>
                  )}
                {source.latestVersion.rejectCode && (
                  <details>
                    <summary>Latest version processing details</summary>
                    <p>{source.latestVersion.rejectCode}</p>
                  </details>
                )}
                {['received', 'parsing'].includes(source.latestVersion.state) ? (
                  <p>
                    The latest version is still being processed. Check its progress before adding
                    another replacement.
                  </p>
                ) : (
                  <KnowledgeForm
                    action={uploadKnowledgeVersionAction}
                    hidden={hidden}
                    submit="Upload replacement version"
                    description="The replacement starts with this source's current sensitivity and access. Processing can raise its sensitivity. The published version remains available until a replacement is ready. An identical file and name create no extra version."
                    fields={[
                      {
                        name: 'title',
                        label: 'Source name',
                        required: true,
                        maxLength: 512,
                        value: source.title ?? '',
                      },
                      {
                        name: 'file',
                        kind: 'file',
                        label: 'Replacement document',
                        required: true,
                        help: 'Text, Markdown, CSV, HTML or JSON, up to 25 MB. Choose the file again if an upload is refused.',
                      },
                    ]}
                  />
                )}
              </>
            ) : (
              <p>Version details are unavailable. Check again before uploading a replacement.</p>
            )}
            <Link className="button secondary" href={`${base}/sources/${sourceId}#source-versions`}>
              Check version progress
            </Link>
          </section>
        )}
      {source.state !== 'active' ? (
        <Link href={`${base}/sources/${sourceId}/purge`}>View removal progress</Link>
      ) : (
        source.canManage && (
          <section className="stack" aria-labelledby="source-access-heading">
            <h2 id="source-access-heading">Source access</h2>
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
                      {!grantAllowedFor(grant.kind, source.classification) && (
                        <small> · Not effective at this sensitivity</small>
                      )}
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
                        {
                          value: '',
                          label:
                            source.classification === 'restricted'
                              ? 'Choose a named person'
                              : 'Choose a person, team or eligible organization access',
                        },
                        ...sourceSharingChoices(
                          source.classification,
                          people.filter((person) => person.status === 'active'),
                          teams,
                        ).filter((choice) => choice.value !== 'private'),
                      ],
                    },
                  ]}
                />
              </>
            )}
            {source.classification !== 'restricted' && (
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
            )}
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
