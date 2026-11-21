import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { GuideBlocks } from '@/components/guide-blocks';
import { Wordmark } from '@/components/ui';
import { blocksFor, pageFor } from '@/lib/guides';
import { getRuntime } from '@/server/runtime';

type Props = { params: Promise<{ slug: string }> };

/** The slug is the only input, and it is only compared with the compiled list. See ADR-036 D5. */
async function requested({ params }: Props) {
  const { slug } = await params;
  const mode = getRuntime().config.mode;
  return { mode, page: pageFor(slug, mode) };
}

/** The tab says as little as the page does about anything this deployment does not have. */
export async function generateMetadata(props: Props): Promise<Metadata> {
  const { page } = await requested(props);
  return { title: page ? `${page.title} | Ensemus` : 'Not found | Ensemus' };
}

// A page for another mode gets the same answer as a page that never existed, and before anything renders.
export default async function GuidePage(props: Props) {
  const { mode, page } = await requested(props);
  if (!page) notFound();
  return (
    <main className="centered help">
      <Wordmark />
      <p className="back">
        <Link href="/help">All help pages</Link>
      </p>
      <article className="sheet">
        <h1>{page.title}</h1>
        <GuideBlocks blocks={blocksFor(page, mode)} />
      </article>
    </main>
  );
}
