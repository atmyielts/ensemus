import { randomUUID } from 'node:crypto';
import type { CommercialMode } from '@ensemus/config';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { SubmitButton } from '@/components/submit-button';
import { ErrorNotice } from '@/components/ui';
import { createOrganizationAction, signOutAction } from '@/server/actions';
import { requireActor } from '@/server/actor';
import { organizationsWithAccess } from '@/server/organizations';
import { getRuntime } from '@/server/runtime';

export const metadata = { title: 'Your organizations | Ensemus' };

// The honest version of each commercial mode (docs/01-product/05-commercial-modes.md). No claims
// about certifications here, and none about AI features that do not run yet.
const RESPONSIBILITY: Record<CommercialMode, { name: string; points: string[] }> = {
  cloud: {
    name: 'Ensemus Cloud',
    points: [
      'Ensemus hosts this service and stores your organization’s data. The data stays yours.',
      'When AI features are available, Ensemus supplies the approved AI model providers. Your content may then be sent to them, under disclosed terms and your organization’s policy.',
    ],
  },
  byom: {
    name: 'Ensemus with your own models',
    points: [
      'Ensemus hosts this service and stores your organization’s data. The data stays yours.',
      'When AI features are available, they use the AI model providers you choose, with your own keys, and you pay those providers directly.',
      'This is not zero-knowledge. Using your own models does not keep your data from Ensemus, because Ensemus still processes it in the hosted service.',
    ],
  },
  sovereign: {
    name: 'Ensemus Sovereign',
    points: [
      'Your organization runs this deployment on infrastructure it controls, including the database, the file storage and the AI models.',
      'It does not rely on services hosted by Ensemus to keep running. Diagnostics leave only if you choose to send them.',
      'Your organization is responsible for operating, securing and backing up this deployment, and for what its models cost.',
    ],
  },
};

const ROLE_LABEL: Record<string, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };

function Account({ email }: { email: string }) {
  return (
    <div className="row" style={{ justifyContent: 'space-between', marginBottom: '1.5rem' }}>
      <span className="muted">{email}</span>
      <form action={signOutAction}>
        <button className="link" type="submit">
          Sign out
        </button>
      </form>
    </div>
  );
}

function Page({ children, email }: { children: ReactNode; email: string }) {
  return (
    <main className="centered">
      <Account email={email} />
      {children}
    </main>
  );
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const actor = await requireActor();
  const organizations = await organizationsWithAccess(actor.userId);
  const [only] = organizations;
  if (only && organizations.length === 1) redirect(`/o/${only.id}`);

  if (only) {
    return (
      <Page email={actor.email}>
        <h1>Your organizations</h1>
        <ul className="list">
          {organizations.map((organization) => (
            <li key={organization.id}>
              <Link href={`/o/${organization.id}`}>{organization.name}</Link>
              <span className="badge">{ROLE_LABEL[organization.role] ?? organization.role}</span>
            </li>
          ))}
        </ul>
      </Page>
    );
  }

  const { error } = await searchParams;
  const responsibility = RESPONSIBILITY[getRuntime().config.mode];
  return (
    <Page email={actor.email}>
      <h1>Set up your organization</h1>
      <p className="muted">
        Your organization is where your work, people and approvals live. You can invite people as
        soon as it exists.
      </p>
      {error === 'name' ? (
        <p className="notice error" role="alert">
          Enter a name of up to 120 characters.
        </p>
      ) : (
        <ErrorNotice code={error} />
      )}
      <form className="fields" action={createOrganizationAction}>
        {/* One rendered form makes one organization, however many times it is sent. */}
        <input type="hidden" name="requestKey" value={randomUUID()} />
        <label>
          Organization name
          <input name="name" autoComplete="organization" required maxLength={120} />
        </label>
        <section className="card" aria-labelledby="responsibility-heading">
          <h2 id="responsibility-heading">Who is responsible for your data</h2>
          <p>This deployment is {responsibility.name}.</p>
          {responsibility.points.map((point) => (
            <p key={point}>{point}</p>
          ))}
          <p style={{ marginBottom: 0 }}>
            AI features are not active yet, so nothing in your organization is sent to an AI model
            today.
          </p>
        </section>
        <div>
          <SubmitButton working="Creating your organization">Create organization</SubmitButton>
        </div>
      </form>
    </Page>
  );
}
