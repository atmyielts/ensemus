import Link from 'next/link';
import { Empty, Wordmark } from '@/components/ui';
import { hrefOf, sectionsFor } from '@/lib/guides';
import { getRuntime } from '@/server/runtime';

export const metadata = { title: 'Help | Ensemus' };

// No sign-in, because "I cannot sign in" has to be answerable, and so no session and no tenant data
// either: everyone in a deployment gets the same page (ADR-036 D5).
export default function HelpPage() {
  const sections = sectionsFor(getRuntime().config.mode);
  return (
    <main className="centered help">
      <Wordmark />
      <div className="sheet">
        <h1>Help</h1>
        {sections.length === 0 ? (
          <Empty>
            This version of Ensemus has no help pages yet. If you need help now, ask an
            administrator in your organization.
          </Empty>
        ) : (
          sections.map(({ section, pages }) => (
            <section key={section.id} className="help-section">
              <h2>{section.title}</h2>
              <ul className="list">
                {pages.map((page) => (
                  <li key={page.slug}>
                    <Link href={hrefOf(page.slug)}>{page.title}</Link>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </main>
  );
}
