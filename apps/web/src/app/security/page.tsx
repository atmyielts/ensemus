import Link from 'next/link';
import { PageHead, Wordmark } from '@/components/ui';

export const metadata = { title: 'Security and reporting | Ensemus' };
export default function Security() {
  return (
    <main className="centered">
      <Wordmark />
      <div className="sheet stack">
        <PageHead
          title="Security and reporting"
          description="How to tell us about a security concern, and what happens after you do."
          actions={<Link href="/status">Service status</Link>}
        />
        <section className="stack">
          <h2>Report a concern</h2>
          <p>
            If you have an Ensemus account, open your organization’s Account, then Support, and
            choose Security. Say briefly what you found, which part of Ensemus it affects, and how
            it can be seen safely. Leave out passwords, keys and customer content.
          </p>
          <p>
            Whoever runs Ensemus for your company has not yet published an external security
            contact. If you cannot sign in, contact them the way you usually would and ask for a
            secure way to report it. Please do not publish the details or any confidential data.
          </p>
          <p>
            <Link href="/">Go to your organizations</Link>
          </p>
        </section>
        <section className="stack">
          <h2>What happens next</h2>
          <p>
            The person responsible records your report privately, confirms they have it through the
            channel you agreed, judges how serious it is, and coordinates a fix and anything that
            needs to be announced. The public status page shows only approved service updates.
          </p>
          <p>No response deadline or certification is claimed on this page.</p>
        </section>
        <section className="stack">
          <h2>Testing boundaries</h2>
          <p>
            Do not access another organization’s data, disrupt the service, take secrets, or try
            anything with real consequences. Agree the limits of any test with whoever runs Ensemus
            for your company first.
          </p>
          <p>
            Safe harbor terms require legal review and have not been approved. This page does not
            grant testing authorization or promise legal protection.
          </p>
        </section>
      </div>
    </main>
  );
}
