import { Card } from '@/components/ui/card';
import { listTrustedSigners } from '@ensemus/application';
import { can } from '@ensemus/domain/policy';
import { BackLink, Empty, ErrorNotice, formatDateTime, PageHead } from '@/components/ui';
import { ConfirmForm } from '@/components/confirm-form';
import { requireTenant } from '@/server/tenant';
import { getSkillFeatureGate } from '@/server/skill-runtime';
import { revokeSignerAction } from './actions';
import { SignerForm } from './signer-form';
export const metadata = { title: 'Publisher keys | Ensemus' };
export default async function SignersPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { organizationId } = await params;
  const { context, database } = await requireTenant(organizationId);
  const signers = await listTrustedSigners(database, context);
  const manage = can(context.role, 'skill.manage');
  const enabled = manage && (await getSkillFeatureGate().isEnabled(context, 'skill_catalog'));
  const error = (await searchParams).error;
  return (
    <>
      <BackLink href={`/o/${organizationId}/settings`}>Settings</BackLink>
      <PageHead
        title="Publisher keys"
        description="Choose whose signed skill packages this company may verify. A key identifies a publisher; it grants no tools or access to company data."
      />
      <ErrorNotice code={error} />
      <Card asChild>
        <section className="card" aria-labelledby="trusted-publishers-heading">
          <h2 id="trusted-publishers-heading">Trusted publishers</h2>
          {signers.length === 0 ? (
            <Empty title="No publisher keys yet">
              A package needs a trusted public key before it can pass verification.
            </Empty>
          ) : (
            <ul className="list">
              {signers.map((signer) => (
                <li key={signer.id} className="block">
                  <div className="row">
                    <strong>{signer.displayName}</strong>
                    <span className={`badge ${signer.state === 'active' ? 'done' : ''}`}>
                      {signer.state === 'active' ? 'Trusted' : 'Revoked'}
                    </span>
                  </div>
                  <p className="muted">
                    Added {formatDateTime(signer.createdAt)}
                    {signer.revokedAt && <>; revoked {formatDateTime(signer.revokedAt)}</>}.
                  </p>
                  <p className="technical-reference">Fingerprint: {signer.keyId}</p>
                  {manage && signer.state === 'active' && (
                    <ConfirmForm
                      action={revokeSignerAction}
                      fields={
                        <>
                          <input type="hidden" name="organizationId" value={organizationId} />
                          <input type="hidden" name="signerId" value={signer.id} />
                          <input type="hidden" name="version" value={signer.version} />
                        </>
                      }
                      summary="Revoke"
                      summaryLabel={`Revoke ${signer.displayName}`}
                      consequence="Revoke this key for good and withdraw this company's verified or published packages signed with it. This key cannot be trusted again. Marketplace copies keep their marketplace trust."
                      confirmLabel="Revoke for good"
                      confirmFullLabel={`Revoke for good: ${signer.displayName}`}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </Card>
      {manage && (
        <Card asChild>
          <section className="card" aria-labelledby="add-publisher-heading">
            <h2 id="add-publisher-heading">Trust a publisher</h2>
            {enabled ? (
              <SignerForm
                organizationId={organizationId}
                trustedKeyIds={signers
                  .filter((signer) => signer.state === 'active')
                  .map((signer) => signer.keyId)}
              />
            ) : (
              <p className="muted">
                Adding publisher keys is not enabled for this company. You can still revoke an
                existing key.
              </p>
            )}
          </section>
        </Card>
      )}
    </>
  );
}
