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
          description="Report a concern without including credentials or unnecessary customer data."
          actions={<Link href="/status">Service status</Link>}
        />
        <section className="stack">
          <h2>Report a concern</h2>
          <p>
            If you have an Ensemus account, open your organization’s Account → Support page and
            choose Security. Include a short description, affected feature, and a safe way to
            reproduce the issue. Redact tokens and customer content.
          </p>
          <p>
            The deployment owner has not yet published an external security contact. If you cannot
            sign in, use your existing contact with the deployment owner and ask for a secure
            reporting channel. Do not publish exploit details or confidential data here.
          </p>
          <Link href="/">Open your organizations</Link>
        </section>
        <section className="stack">
          <h2>What happens next</h2>
          <p>
            A responsible operator records a private reference to the report, acknowledges it
            through the agreed channel, assesses severity, and coordinates a fix and any disclosure.
            The public status page carries only approved service updates.
          </p>
          <p>No response deadline or certification is claimed on this page.</p>
        </section>
        <section className="stack">
          <h2>Testing boundaries</h2>
          <p>
            Do not access another organization’s data, disrupt service, extract secrets, or attempt
            consequential actions. Ask the deployment owner to agree a bounded test first.
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
