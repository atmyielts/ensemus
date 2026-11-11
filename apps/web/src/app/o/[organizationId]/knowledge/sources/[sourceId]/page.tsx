import { listDirectory, listTeams } from '@ensemus/application';
import { getSource } from '@ensemus/application/knowledge/sources';
import { canRaiseClass, grantAllowedFor } from '@ensemus/domain/knowledge';
import Link from 'next/link';
import { KnowledgeForm } from '@/components/knowledge-form';
import { SourceLink, sourceLevelChoices } from '@/components/knowledge-view';
import { sourceSharingChoices } from '@/lib/knowledge-source-view';
import {
  PageHead,
  ClassificationBadge,
  StatusBadge,
  BackLink,
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
  const managing = source.state === 'active' && source.canManage;
  return (
    <>
      <div>
        <BackLink href={base}>Back to sources</BackLink>
        <PageHead title={source.title ?? 'Source with limited access'} />
      </div>
      <div className="detail-layout">
        <div className="stack">
          {!source.canRead ? (
            <p className="notice">
              This document exists, but its contents are not shared with you. Being able to manage a
              document does not let you read its words.
            </p>
          ) : (
            <>
              {source.documentState === 'searchable' ? (
                <p className="notice good">
                  This document is ready: you can find passages in it and ask questions about it.{' '}
                  {source.embeddingState === 'denied'
                    ? 'Search by meaning is turned off for documents at this level of privacy; word search still works.'
                    : source.embeddingState === 'failed'
                      ? 'Search by meaning could not be set up; word search still works.'
                      : source.embeddingState === 'pending' || source.embeddingState === 'embedding'
                        ? 'Search by meaning is still being set up.'
                        : ''}
                </p>
              ) : (
                <p className="notice">
                  {source.documentState === 'rejected'
                    ? 'This version could not be read, so it is not available in search.'
                    : source.documentState === 'failed'
                      ? 'Reading this document did not finish. Ensemus tries again on its own while the document stays open.'
                      : 'The document is saved. You can search it as soon as Ensemus has finished reading it.'}
                </p>
              )}
              {source.scanState === 'not_scanned' && (
                <p className="notice">
                  This file was not checked for malware. That is separate from who can see it.
                </p>
              )}
              <section className="card" aria-labelledby="about-heading">
                <h2 id="about-heading">About this document</h2>
                <dl className="details">
                  <div>
                    <dt>Reading</dt>
                    <dd>
                      <StatusBadge status={source.documentState ?? 'unavailable'} />
                    </dd>
                  </div>
                  <div>
                    <dt>Search by meaning</dt>
                    <dd>
                      <StatusBadge status={source.embeddingState ?? 'unavailable'} />
                    </dd>
                  </div>
                  <div>
                    <dt>Malware check</dt>
                    <dd>
                      {source.scanState === 'clean'
                        ? 'Checked: no malware detected'
                        : source.scanState === 'flagged'
                          ? 'Flagged by the configured scanner'
                          : 'Not scanned'}
                    </dd>
                  </div>
                  {source.sizeBytes !== null && (
                    <div>
                      <dt>Size</dt>
                      <dd>{formatBytes(source.sizeBytes)}</dd>
                    </div>
                  )}
                  {source.searchableAt && (
                    <div>
                      <dt>Searchable since</dt>
                      <dd>{formatDateTime(source.searchableAt)}</dd>
                    </div>
                  )}
                  {source.sourceModifiedAt && (
                    <div>
                      <dt>Last changed</dt>
                      <dd>{formatDateTime(source.sourceModifiedAt)}</dd>
                    </div>
                  )}
                </dl>
                <div className="row gap-above-large">
                  {source.documentId && source.state === 'active' && (
                    <a
                      className="button secondary"
                      href={`/api/v1/organizations/${organizationId}/knowledge/documents/${source.documentId}/content`}
                    >
                      Download source file
                    </a>
                  )}
                  <SourceLink url={source.sourceUrl} />
                </div>
                {source.rejectCode && (
                  <details className="gap-above">
                    <summary>Technical details</summary>
                    <p className="technical-reference">{source.rejectCode}</p>
                  </details>
                )}
              </section>
            </>
          )}
          {managing && source.kind === 'upload' && source.canRead && (
            <section
              className="card stack"
              id="source-versions"
              aria-labelledby="source-versions-heading"
            >
              <div className="section-intro">
                <h2 id="source-versions-heading">Source versions</h2>
                <p>Upload a newer copy of this document when it changes.</p>
              </div>
              {versionResult === 'saved' && (
                <p className="notice good" role="status">
                  The replacement file was saved. Its current processing state is shown below.
                </p>
              )}
              {versionResult === 'unchanged' && (
                <p className="notice" role="status">
                  That file and name are the same as the latest version, so nothing changed.
                </p>
              )}
              {source.latestVersion ? (
                <>
                  <p className="row">
                    <span>Latest version: {source.latestVersion.number}</span>
                    <StatusBadge status={source.latestVersion.state} />
                  </p>
                  {source.latestVersion.id !== source.documentId &&
                    source.documentState === 'searchable' && (
                      <p className="notice">
                        {['failed', 'rejected'].includes(source.latestVersion.state)
                          ? 'The new version could not be made searchable. The earlier version is still the one people search.'
                          : 'People keep searching the earlier version while the new one is read.'}
                      </p>
                    )}
                  {source.latestVersion.rejectCode && (
                    <details>
                      <summary>Technical details about the latest version</summary>
                      <p className="technical-reference">{source.latestVersion.rejectCode}</p>
                    </details>
                  )}
                  {['received', 'parsing'].includes(source.latestVersion.state) ? (
                    <p>
                      The latest version is still being read. Check its progress before uploading
                      another one.
                    </p>
                  ) : (
                    <KnowledgeForm
                      action={uploadKnowledgeVersionAction}
                      hidden={hidden}
                      submit="Upload replacement version"
                      className="fields"
                      description="The new file keeps this document's privacy level and who can read it. The current version stays searchable until the new one is ready."
                      fields={[
                        {
                          name: 'file',
                          kind: 'file',
                          label: 'Replacement document',
                          required: true,
                          help: 'Text, Markdown, CSV, HTML or JSON, up to 25 MB. If the upload fails, choose the file again.',
                        },
                        {
                          name: 'title',
                          label: 'Source name',
                          required: true,
                          maxLength: 512,
                          value: source.title ?? '',
                        },
                      ]}
                    />
                  )}
                </>
              ) : (
                <p>Version details are not available right now. Check again before uploading.</p>
              )}
              <p>
                <Link
                  className="button secondary"
                  href={`${base}/sources/${sourceId}#source-versions`}
                >
                  Check version progress
                </Link>
              </p>
            </section>
          )}
          {managing && (
            <section className="card stack" aria-labelledby="source-access-heading">
              <div className="section-intro">
                <h2 id="source-access-heading">Source access</h2>
                <p>The people and teams who can read this document.</p>
              </div>
              {source.grantsManagedByProvider ? (
                <p>
                  Who can read this follows the connected service. Change it there, then sync the
                  connection.
                </p>
              ) : (
                <>
                  <ul className="list">
                    {source.grants.map((grant) => (
                      <li key={grant.id}>
                        <div>
                          {principalName(grant)}
                          {!grantAllowedFor(grant.kind, source.classification) && (
                            <>
                              <br />
                              <small>Not in effect at this privacy level</small>
                            </>
                          )}
                        </div>
                        <div>
                          <KnowledgeForm
                            action={changeSourceGrantsAction}
                            hidden={{ ...hidden, removeGrantId: grant.id }}
                            submit={`Remove access for ${principalName(grant)}`}
                            className="grant-remove"
                            submitClassName="ghost"
                            fields={[]}
                          />
                        </div>
                      </li>
                    ))}
                  </ul>
                  <KnowledgeForm
                    action={changeSourceGrantsAction}
                    hidden={hidden}
                    submit="Add access"
                    className="inline-form"
                    submitClassName="secondary"
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
            </section>
          )}
        </div>
        <aside className="card">
          <dl className="details">
            <div>
              <dt>Who can see this</dt>
              <dd>
                <ClassificationBadge value={source.classification} />
              </dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>
                <StatusBadge status={source.state} />
              </dd>
            </div>
            <div>
              <dt>Kind</dt>
              <dd>{source.kind === 'connector' ? 'Connected source' : 'Uploaded file'}</dd>
            </div>
          </dl>
          {source.state !== 'active' ? (
            <p className="link-line gap-above-large">
              <Link href={`${base}/sources/${sourceId}/purge`}>View removal progress</Link>
            </p>
          ) : (
            source.canManage && (
              <div className="stack gap-above-large">
                {source.classification !== 'restricted' && (
                  <details>
                    <summary>Make this source more private</summary>
                    <p className="muted">
                      A more private level can stop some people and teams from reading it. You
                      cannot make it less private here.
                    </p>
                    <KnowledgeForm
                      action={raiseSourceClassAction}
                      hidden={hidden}
                      submit="Make more private"
                      className="fields"
                      submitClassName="secondary"
                      fields={[
                        {
                          name: 'classification',
                          kind: 'choices',
                          label: 'New level',
                          required: true,
                          options: sourceLevelChoices(
                            ['public', 'internal', 'confidential', 'restricted'].filter(
                              (value) =>
                                value !== source.classification &&
                                canRaiseClass(
                                  source.classification,
                                  value as typeof source.classification,
                                ),
                            ),
                          ),
                        },
                      ]}
                    />
                  </details>
                )}
                <details>
                  <summary>Remove this source</summary>
                  <p className="muted">
                    Nobody can read it from the moment you confirm. Its file and everything made
                    from it are then removed in the background; holds and unfinished work can delay
                    the confirmation.
                  </p>
                  <KnowledgeForm
                    action={closeKnowledgeAction}
                    hidden={hidden}
                    submit="Close source and start removal"
                    className="fields"
                    submitClassName="danger"
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
                        rows: 3,
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
              </div>
            )
          )}
        </aside>
      </div>
    </>
  );
}
