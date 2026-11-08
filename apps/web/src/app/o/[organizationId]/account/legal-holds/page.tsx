import { listLegalHolds, listLegalHoldTargets } from '@ensemus/application/saas/legal-holds';
import Link from 'next/link';
import { ConfirmForm } from '@/components/confirm-form';
import { AccountReasonSelect } from '@/components/account-reason-select';
import { Empty, ErrorNotice, PageHead, formatDateTime } from '@/components/ui';
import { releaseLegalHoldAction } from '@/server/lifecycle-actions';
import { orNotFound, requireAccountTenant } from '@/server/tenant';
import { LegalHoldForm } from './hold-form';
export const metadata = { title: 'Legal holds | Ensemus' };
export default async function LegalHoldsPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { organizationId } = await params,
    { database, context } = await requireAccountTenant(organizationId);
  const [holds, targets] = await Promise.all([
    orNotFound(listLegalHolds(database, context)),
    orNotFound(listLegalHoldTargets(database, context)),
  ]);
  return (
    <div className="stack">
      <PageHead
        title="Legal holds"
        description="Preserve records while a matter remains open. Only an organization owner can manage holds."
        actions={<Link href={`/o/${organizationId}/account`}>Account</Link>}
      />
      <ErrorNotice code={(await searchParams).error} />
      {holds.length === 0 ? (
        <Empty>No legal holds have been recorded.</Empty>
      ) : (
        <ul className="list">
          {holds.map((hold) => (
            <li key={hold.id}>
              <div className="stack">
                <div>
                  <strong>{hold.matterRef}</strong>
                  <p>{hold.status === 'active' ? 'Active · records preserved' : 'Released'}</p>
                  <p className="muted">
                    Placed {formatDateTime(hold.placedAt)}
                    {hold.releasedAt && <> · Released {formatDateTime(hold.releasedAt)}</>}
                  </p>
                </div>
                <ul>
                  {hold.scopes.map((scope) => (
                    <li key={`${scope.type}:${scope.id ?? ''}`}>
                      {scope.type === 'organization'
                        ? 'Entire organization'
                        : `${scope.type.replaceAll('_', ' ')} · ${targets.find((group) => group.type === scope.type)?.items.find((item) => item.id === scope.id)?.label ?? 'Recorded scope'}`}
                    </li>
                  ))}
                </ul>
                {hold.status === 'active' && (
                  <ConfirmForm
                    action={releaseLegalHoldAction}
                    summary="Release this hold"
                    consequence="I confirm that this hold can be released. Applicable retention and deletion requests may then remove these records."
                    confirmLabel="Release hold"
                    fields={
                      <>
                        <input type="hidden" name="organizationId" value={organizationId} />
                        <input type="hidden" name="holdId" value={hold.id} />
                        <input type="hidden" name="version" value={hold.version} />
                        <AccountReasonSelect forAction="release_hold"/>
                      </>
                    }
                  />
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <section className="stack" aria-labelledby="new-hold">
        <h2 id="new-hold">Place a hold</h2>
        <LegalHoldForm organizationId={organizationId} targets={targets} />
      </section>
    </div>
  );
}
