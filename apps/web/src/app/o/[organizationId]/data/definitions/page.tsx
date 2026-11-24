import { Card } from '@/components/ui/card';
import { listImportedDefinitions } from '@ensemus/application';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHead } from '@/components/ui';
import { requireTenant } from '@/server/tenant';

function definitionLabel(row: Awaited<ReturnType<typeof listImportedDefinitions>>[number]) {
  if (row.record.kind === 'marketplace_publisher_history')
    return `Marketplace publisher · ${row.record.display_name}`;
  if (row.record.kind === 'residency_requirement') {
    const scope = row.record.scope === 'all' ? 'All data' : row.record.scope;
    return `Residency · ${scope} · ${row.record.region}`;
  }
  return `${row.record_kind.replaceAll('_', ' ')} · ${row.source_id}`;
}

export const metadata = { title: 'Imported definitions | Ensemus' };
export default async function ImportedDefinitionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ after?: string }>;
}) {
  const { organizationId } = await params;
  const { after } = await searchParams;
  const { context, database } = await requireTenant(organizationId);
  if (!['owner', 'admin'].includes(context.role)) notFound();
  const rows = await listImportedDefinitions(database, context, { ...(after ? { after } : {}) });
  const last = rows.at(-1);
  return (
    <>
      <PageHead
        title="Imported definitions"
        description="Review the settings and reference records brought from another organization."
      />
      <Card asChild>
        <section className="card" aria-labelledby="definition-review">
          <h2 id="definition-review">These records need review</h2>
          <p>
            Nothing listed here is active. Agent publications, provider permissions and verified
            facts must be checked again here before use. Uploaded originals are processed locally;
            search indexes and private transcripts are not imported.
          </p>
          <p>
            Review each definition with its owner before entering it through the relevant setup
            screen. Connections need new credentials and a fresh permission check. Imported fact
            claims remain unverified reference material.
          </p>
          {rows.length === 0 ? (
            <p>No imported definitions are available on this page.</p>
          ) : (
            rows.map((row) => (
              <details key={`${row.record_kind}:${row.source_id}`}>
                <summary className="[overflow-wrap:anywhere]">{definitionLabel(row)}</summary>
                {row.record.kind === 'residency_requirement' && (
                  <p>
                    <Link href={`/o/${organizationId}/deployment`}>
                      Review deployment residency
                    </Link>
                  </p>
                )}
                <pre className="record-text">{JSON.stringify(row.record, null, 2)}</pre>
              </details>
            ))
          )}
          {rows.length === 100 && last && (
            <p>
              <Link
                href={`/o/${organizationId}/data/definitions?after=${encodeURIComponent(`${last.source_id}:${last.record_kind}`)}`}
              >
                More imported definitions
              </Link>
            </p>
          )}
          <p>
            <Link href={`/o/${organizationId}/data`}>Back to export and import</Link>
          </p>
        </section>
      </Card>
    </>
  );
}
