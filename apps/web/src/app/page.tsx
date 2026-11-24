import { Label } from '@/components/ui/label';
import { randomUUID } from 'node:crypto';
import type { CommercialMode } from '@ensemus/config';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { DraftScope, KeptInput } from '@/components/kept-field';
import { SubmitButton } from '@/components/submit-button';
import { ErrorNotice, Wordmark } from '@/components/ui';
import { createOrganizationAction, signOutAction } from '@/server/actions';
import { requireActor } from '@/server/actor';
import { organizationsWithAccess } from '@/server/organizations';
import { getRuntime } from '@/server/runtime';

export const metadata = { title: 'Your organizations | Ensemus' };

// What each commercial mode controls before a workspace is created.
const RESPONSIBILITY: Record<CommercialMode, { name: string; points: string[] }> = {
  cloud: {
    name: 'Ensemus Cloud',
    points: [
      'Ensemus hosts this service and stores your organization’s data. The data stays yours.',
      'Ensemus supplies the approved AI model providers. Content may be sent to those providers under the applicable terms and your organization’s policy.',
    ],
  },
  byom: {
    name: 'Ensemus with your own models',
    points: [
      'Ensemus hosts this service and stores your organization’s data. The data stays yours.',
      'For third-party providers, you connect models with your own keys and pay those providers directly.',
      'Ensemus still processes your data in the hosted service.',
    ],
  },
  sovereign: {
    name: 'Ensemus Sovereign',
    points: [
      'Your organization runs Ensemus on infrastructure it controls, including the database, the file storage and the AI models.',
      'This installation can run independently of Ensemus-hosted services. Diagnostics leave only if you choose to send them.',
      'Your organization is responsible for operating, securing and backing up this installation, and for what its models cost.',
    ],
  },
};

const ROLE_LABEL: Record<string, string> = {
  owner: 'You are an owner',
  admin: 'You are an admin',
  member: 'You are a member',
};

function Account({ email }: { email: string }) {
  return (
    <div className="account-bar">
      <span>Signed in as {email}</span>
      <form action={signOutAction}>
        <button className="link" type="submit">
          Sign out
        </button>
      </form>
    </div>
  );
}

function Page({
  children,
  actor,
}: {
  children: ReactNode;
  actor: { userId: string; email: string };
}) {
  return (
    <main className="centered">
      <Wordmark />
      <Account email={actor.email} />
      <div className="sheet">
        <DraftScope account={actor.userId}>{children}</DraftScope>
      </div>
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
      <Page actor={actor}>
        <h1 id="organizations-heading">Your organizations</h1>
        <p className="lede">
          An organization is the shared space for one company: its work, people and approvals.
          Choose the one you want to open.
        </p>
        <ul
          className="destination-list organization-choices"
          aria-labelledby="organizations-heading"
        >
          {organizations.map((organization) => (
            <li key={organization.id}>
              <Link className="destination-row" href={`/o/${organization.id}`}>
                <span className="destination-icon organization-initial" aria-hidden="true">
                  {Array.from(organization.name.trim())[0]?.toUpperCase() ?? ''}
                </span>
                <span className="destination-copy">
                  <strong>{organization.name}</strong>
                  <span>{ROLE_LABEL[organization.role] ?? organization.role}</span>
                </span>
                <span className="destination-arrow" aria-hidden="true">
                  →
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </Page>
    );
  }

  const { error } = await searchParams;
  const responsibility = RESPONSIBILITY[getRuntime().config.mode];
  return (
    <Page actor={actor}>
      <h1>Set up your organization</h1>
      <p className="lede">
        An organization is your company’s shared space in Ensemus. Your work, people and approvals
        live there, and you can invite colleagues as soon as it exists.
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
        <Label>
          Organization name
          <KeptInput
            keep="organization-name"
            name="name"
            autoComplete="organization"
            required
            maxLength={120}
          />
        </Label>
        <section className="panel" aria-labelledby="responsibility-heading">
          <h2 id="responsibility-heading">Who is responsible for your data</h2>
          <p>You are using {responsibility.name}.</p>
          <ul className="responsibility-points">
            {responsibility.points.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
          <p>
            AI features use models approved for your organization. Your organization’s policy
            controls what data those models can receive.
          </p>
        </section>
        <div>
          <SubmitButton working="Creating your organization">Create organization</SubmitButton>
        </div>
      </form>
    </Page>
  );
}
