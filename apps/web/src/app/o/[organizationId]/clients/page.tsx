import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { randomUUID } from 'node:crypto';
import { listClients, listProjects } from '@ensemus/application';
import { can } from '@ensemus/domain/policy';
import Link from 'next/link';
import { SubmitButton } from '@/components/submit-button';
import { ClassificationBadge, Empty, ErrorNotice, PageHead } from '@/components/ui';
import { requireTenant } from '@/server/tenant';
import { createClientAction, createProjectAction } from '@/server/work-actions';

export const metadata = { title: 'Clients and projects | Ensemus' };

/** Who can see a client, in words that hold whoever is reading, not only its owner. */
const SEEN_BY: Record<string, string> = {
  public: 'Anyone can see it',
  internal: 'Everyone in this workspace can see it',
  confidential: 'Its owner, the people they name, and owners and admins can see it',
  restricted: 'Only its owner and the people they name can see it',
};

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
        description="The companies you do work for, and the projects that group that work, so everyone can see what belongs together and who may see it."
      />
      <ErrorNotice code={error} />
      <div className="stack">
        <Card asChild>
          <section className="card" aria-labelledby="clients-heading">
            <header className="section-heading">
              <div>
                <h2 id="clients-heading">Clients</h2>
                <p>
                  A client keeps its projects and work together. Each client has an owner, who
                  decides who else can see it.
                </p>
              </div>
            </header>
            {clients.length === 0 ? (
              <Empty title="No clients yet">
                {canAddClient
                  ? 'Add the first company you do work for below. You can then group its work into projects and choose who can see it.'
                  : 'An owner or admin adds clients. Once they do, the ones you can see appear here.'}
              </Empty>
            ) : (
              <ul className="list client-list">
                {clients.map((client) => (
                  <li key={client.id}>
                    <div className="client-who">
                      <span className="client-name">
                        <span>{client.displayName}</span>{' '}
                        <ClassificationBadge value={client.classification} />
                      </span>
                      <small>
                        {SEEN_BY[client.classification] ?? 'Who can see it is not known'}
                      </small>
                    </div>
                    {client.ownerMembershipId === context.membershipId && (
                      <Link
                        className="button secondary compact-action"
                        href={`/o/${organizationId}/clients/${client.id}/access`}
                      >
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
                <Label>
                  Client name
                  <Input name="displayName" required maxLength={200} autoComplete="off" />
                </Label>
                <Label>
                  Who can see this client
                  <NativeSelect name="classification" defaultValue="internal">
                    <option value="internal">Everyone in this workspace</option>
                    <option value="confidential">You, named people and administrators</option>
                    <option value="restricted">Only you and named people</option>
                  </NativeSelect>
                </Label>
                <SubmitButton className="secondary">Add client</SubmitButton>
              </form>
            )}
          </section>
        </Card>

        <Card asChild>
          <section className="card" aria-labelledby="projects-heading">
            <header className="section-heading">
              <div>
                <h2 id="projects-heading">Projects</h2>
                <p>
                  A project groups the work for one job, such as a website refresh. Open one to see
                  its work.
                </p>
              </div>
            </header>
            {projects.length === 0 ? (
              <Empty title="No projects yet">
                {canAddProject
                  ? 'Add one below, with its client if it has one, and its work will appear together.'
                  : 'An owner or admin adds projects. Once they do, they appear here.'}
              </Empty>
            ) : (
              <ul className="list">
                {projects.map((project) => (
                  <li key={project.id}>
                    <Link href={`/o/${organizationId}/work?project=${project.id}`}>
                      {project.name}
                    </Link>
                    <small>{project.clientName ? `For ${project.clientName}` : 'No client'}</small>
                  </li>
                ))}
              </ul>
            )}
            {canAddProject && (
              <form className="inline-form divided" action={createProjectAction}>
                {org}
                <input type="hidden" name="requestKey" value={randomUUID()} />
                <Label>
                  Project name
                  <Input name="name" required maxLength={200} autoComplete="off" />
                </Label>
                {clients.length > 0 && (
                  <Label>
                    Client (optional)
                    <NativeSelect name="clientId" defaultValue="">
                      <option value="">No client</option>
                      {clients.map((client) => (
                        <option key={client.id} value={client.id}>
                          {client.displayName}
                        </option>
                      ))}
                    </NativeSelect>
                  </Label>
                )}
                <SubmitButton className="secondary">Add project</SubmitButton>
              </form>
            )}
          </section>
        </Card>
      </div>
    </>
  );
}
