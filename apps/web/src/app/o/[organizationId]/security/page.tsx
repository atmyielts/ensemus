import Link from 'next/link';
import { headers } from 'next/headers';
import { getSecurityPolicy, listMemberSecondFactors } from '@ensemus/application/security-policy';
import { canProduct } from '@ensemus/domain/product-policy';
import { can } from '@ensemus/domain/policy';
import { PageHead, ErrorNotice } from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import styles from '@/components/security/security.module.css';
import { updateSecurityPolicyAction } from '@/server/security-actions';
import { getRuntime } from '@/server/runtime';
import { requireTenant, orNotFound } from '@/server/tenant';
export const metadata = { title: 'Security | Ensemus' };
export default async function SecurityPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { organizationId } = await params,
    { actor, context, database } = await requireTenant(organizationId),
    query = await searchParams;
  const policy = await orNotFound(getSecurityPolicy(database, context));
  const enrolled = await getRuntime().mfa.isEnrolled(
    { sessionId: actor.sessionId, userId: actor.userId },
    await headers(),
  );
  const people = can(context.role, 'member.manage')
    ? await orNotFound(listMemberSecondFactors(database, context))
    : null;
  const notice =
    query.notice === 'saved'
      ? 'Security settings saved.'
      : query.notice === 'enrolled'
        ? 'Two-step sign-in is on.'
        : query.notice === 'disabled'
          ? 'Two-step sign-in is off.'
          : null;
  return (
    <>
      <PageHead
        title="Security"
        description="Protect your account and choose when this company asks people to confirm it is them."
      />
      <ErrorNotice code={query.error} />
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <section className={styles.section}>
        <h2>Your sign-in</h2>
        <p>
          {enrolled
            ? 'Your account uses an authenticator app and recovery codes.'
            : 'Add an authenticator app to protect your account and make sensitive changes.'}
        </p>
        <Link className="button" href={`/o/${organizationId}/security/two-factor`}>
          {enrolled ? 'Manage authenticator app' : 'Set up authenticator app'}
        </Link>
      </section>
      {canProduct(context.role, 'sso.manage') && (
        <section className={styles.section}>
          <h2>Company sign-in</h2>
          <p>Connect your company’s identity provider and manage provisioning access.</p>
          <Link className="button quiet" href={`/o/${organizationId}/security/sso`}>
            Manage company sign-in
          </Link>
        </section>
      )}
      <section className={styles.section}>
        <h2>Company confirmation rules</h2>
        <p>
          Sensitive changes always ask for a recent code. This company{' '}
          {policy.mfaForAdministration ? 'also asks' : 'does not yet ask'} when managing people,
          connections and company settings. Confirmations last{' '}
          {policy.mfaMaxAgeSeconds % 60 === 0
            ? `${policy.mfaMaxAgeSeconds / 60} minutes`
            : `${policy.mfaMaxAgeSeconds} seconds`}
          .
        </p>
        {canProduct(context.role, 'security_policy.manage') ? (
          <form className="fields" action={updateSecurityPolicyAction.bind(null, organizationId)}>
            <input type="hidden" name="version" value={policy.version} />
            <label className={styles.check}>
              <input
                name="mfaForAdministration"
                type="checkbox"
                defaultChecked={policy.mfaForAdministration}
              />
              Also require a recent code for administration
            </label>
            <label>
              Ask for another code after
              <select name="mfaMaxAgeSeconds" defaultValue={policy.mfaMaxAgeSeconds}>
                {![60, 300, 600, 900, 1800, 3600].includes(policy.mfaMaxAgeSeconds) && (
                  <option value={policy.mfaMaxAgeSeconds}>
                    Current: {policy.mfaMaxAgeSeconds} seconds
                  </option>
                )}
                {[60, 300, 600, 900, 1800, 3600].map((seconds) => (
                  <option key={seconds} value={seconds}>
                    {seconds / 60} {seconds === 60 ? 'minute' : 'minutes'}
                  </option>
                ))}
              </select>
            </label>
            <p className="muted">A shorter time asks for codes more often.</p>
            <input type="hidden" name="ssoEnforcement" value={policy.ssoEnforcement} />
            <div>
              <SubmitButton working="Saving">Save security settings</SubmitButton>
            </div>
          </form>
        ) : (
          <p className="muted">A company owner can change these rules.</p>
        )}
      </section>
      {people && (
        <section className={styles.section}>
          <h2>Authenticator app setup</h2>
          <p>Only setup status is shared here. Keys and recovery codes remain private.</p>
          <table className={styles.table}>
            <caption>Active members’ authenticator app status</caption>
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Authenticator app</th>
              </tr>
            </thead>
            <tbody>
              {people.map((person) => (
                <tr key={person.membershipId}>
                  <th scope="row">{person.name}</th>
                  <td>{person.enrolled ? 'Set up' : 'Not set up'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
