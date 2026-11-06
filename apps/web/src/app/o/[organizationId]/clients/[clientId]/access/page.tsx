import { getClientSharing, listDirectory } from '@ensemus/application';
import Link from 'next/link';
import { SubmitButton } from '@/components/submit-button';
import { ClassificationBadge, Empty, ErrorNotice, PageHead } from '@/components/ui';
import { orNotFound, requireTenant } from '@/server/tenant';
import { setClientReadersAction } from '@/server/work-actions';

export const metadata = { title: 'Client access | Ensemus' };
export default async function ClientAccessPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string; clientId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { organizationId, clientId } = await params;
  const { error } = await searchParams;
  const { context, database } = await requireTenant(organizationId);
  const sharing = await orNotFound(getClientSharing(database, context, clientId));
  const directory = (await listDirectory(database, context)).filter(
    (person) => person.status === 'active' && person.membershipId !== context.membershipId,
  );
  const selected = new Set(sharing.readers.map((person) => person.membershipId));
  return (
    <>
      <PageHead title="Client access" description={sharing.name} />
      <p>
        <Link href={`/o/${organizationId}/clients`}>Back to clients and projects</Link>
      </p>
      <ErrorNotice code={error} />
      <section className="card stack" aria-labelledby="client-access-heading">
        <h2 id="client-access-heading">People who can see this client</h2>
        <p>
          <ClassificationBadge value={sharing.classification} />
        </p>
        <p>
          {sharing.classification === 'restricted'
            ? 'Only you and the people you select can see this client and its projects.'
            : sharing.classification === 'confidential'
              ? 'You, organization owners and administrators can see this client. You can name additional people below.'
              : 'Everyone in this workspace can see this client. Named access also remains if the client becomes more restricted.'}
        </p>
        <form action={setClientReadersAction} className="stack">
          <input type="hidden" name="organizationId" value={organizationId} />
          <input type="hidden" name="clientId" value={clientId} />
          <input type="hidden" name="expectedVersion" value={sharing.version} />
          <fieldset className="group">
            <legend>Named people</legend>
            {directory.length ? (
              directory.map((person) => (
                <label key={person.membershipId} className="check">
                  <input
                    type="checkbox"
                    name="readerMembershipId"
                    value={person.membershipId}
                    defaultChecked={selected.has(person.membershipId)}
                  />
                  <span>{person.name}</span>
                </label>
              ))
            ) : (
              <Empty>Invite someone to the workspace before sharing this client.</Empty>
            )}
          </fieldset>
          <p className="muted">
            Only you can change this named access. Removing someone also removes their access to
            associated projects, search results and facts. Access to source documents is managed
            separately.
          </p>
          {sharing.readers.some((person) => person.status !== 'active') && (
            <p className="notice">
              Inactive people have no access and are removed from this list when you save.
            </p>
          )}
          <SubmitButton>Save access</SubmitButton>
        </form>
      </section>
    </>
  );
}
