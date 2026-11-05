import { listMyOrganizations } from '@ensemus/database';
import Link from 'next/link';
import { createOrganizationAction, signOutAction } from '@/server/actions';
import { requireActor } from '@/server/actor';
import { getRuntime } from '@/server/runtime';

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const actor = await requireActor();
  const organizations = await listMyOrganizations(getRuntime().app, actor.userId);
  const { error } = await searchParams;

  return (
    <main>
      <div className="bar">
        <span className="muted">{actor.email}</span>
        <form action={signOutAction}>
          <button className="quiet" type="submit">
            Sign out
          </button>
        </form>
      </div>
      <h1>Your organizations</h1>
      {organizations.length === 0 ? (
        <p className="muted">Create your first organization to get started.</p>
      ) : (
        <ul>
          {organizations.map((organization) => (
            <li key={organization.id}>
              <Link href={`/o/${organization.id}`}>{organization.name}</Link>{' '}
              <span className="muted">({organization.role})</span>
            </li>
          ))}
        </ul>
      )}
      <h2>New organization</h2>
      {error === 'name' && (
        <p className="error" role="alert">
          Enter a name of up to 120 characters.
        </p>
      )}
      <form action={createOrganizationAction}>
        <label>
          Name
          <input name="name" required maxLength={120} />
        </label>
        <button type="submit">Create organization</button>
      </form>
    </main>
  );
}
