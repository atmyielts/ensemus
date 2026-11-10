import { randomUUID } from 'node:crypto';
import { listClients, listProjects } from '@ensemus/application';
import { can } from '@ensemus/domain/policy';
import Link from 'next/link';
import { SubmitButton } from '@/components/submit-button';
import { ClassificationBadge, Empty, ErrorNotice, PageHead } from '@/components/ui';
import { requireTenant } from '@/server/tenant';
import { createClientAction, createProjectAction } from '@/server/work-actions';

export const metadata = { title: 'Clients and projects | Ensemus' };

export default async function ClientsPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { organizationId } = await params;
  const { error } = await searchParams;
  const { context, database } = await requireTenant(organizationId);
  const [clients, projects] = await Promise.all([
    listClients(database, context),
    listProjects(database, context),
  ]);
  const canAddClient = can(context.role, 'client.manage');
  const canAddProject = can(context.role, 'project.manage');
  const org = <input type="hidden" name="organizationId" value={organizationId} />;

  return (
    <>
      <PageHead
        title="Clients and projects"
        description="Who the work is for, and how it is grouped."
      />
      <ErrorNotice code={error} />
      <div className="stack">
        <section className="card" aria-labelledby="clients-heading">
          <h2 id="clients-heading">Clients</h2>
          {clients.length === 0 ? (
            <Empty>
              {canAddClient ? 'No clients yet. Add your first one.' : 'No clients yet.'}
            </Empty>
          ) : (
            <ul className="list">
              {clients.map((client) => (
                <li key={client.id}>
                  <div>
                    <span>{client.displayName}</span>{' '}
                    <ClassificationBadge value={client.classification} />
                  </div>
                  {client.ownerMembershipId === context.membershipId && (
                    <Link href={`/o/${organizationId}/clients/${client.id}/access`}>
                      Manage access
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          )}
          {canAddClient && (
            <form className="inline-form divided" action={createClientAction}>
              {org}
              <input type="hidden" name="requestKey" value={randomUUID()} />
              <label>
                Client name
                <input name="displayName" required maxLength={200} autoComplete="off" />
              </label>
              <label>
                Who can see this client
                <select name="classification" defaultValue="internal">
                  <option value="internal">Everyone in this workspace</option>
                  <option value="confidential">You, named people and administrators</option>
                  <option value="restricted">Only you and named people</option>
                </select>
              </label>
              <SubmitButton className="quiet">Add client</SubmitButton>
            </form>
          )}
        </section>

        <section className="card" aria-labelledby="projects-heading">
          <h2 id="projects-heading">Projects</h2>
          {projects.length === 0 ? (
            <Empty>
              {canAddProject ? 'No projects yet. Add your first one.' : 'No projects yet.'}
            </Empty>
          ) : (
            <ul className="list">
              {projects.map((project) => (
                <li key={project.id}>
                  <Link href={`/o/${organizationId}/work?project=${project.id}`}>
                    {project.name}
                  </Link>
                  <small>{project.clientName ?? 'No client'}</small>
                </li>
              ))}
            </ul>
          )}
          {canAddProject && (
            <form className="inline-form divided" action={createProjectAction}>
              {org}
              <input type="hidden" name="requestKey" value={randomUUID()} />
              <label>
                Project name
                <input name="name" required maxLength={200} autoComplete="off" />
              </label>
              {clients.length > 0 && (
                <label>
                  Client (optional)
                  <select name="clientId" defaultValue="">
                    <option value="">No client</option>
                    {clients.map((client) => (
                      <option key={client.id} value={client.id}>
                        {client.displayName}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <SubmitButton className="quiet">Add project</SubmitButton>
            </form>
          )}
        </section>
      </div>
    </>
  );
}
