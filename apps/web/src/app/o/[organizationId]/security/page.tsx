import { headers } from 'next/headers';
import { getSecurityPolicy, listMemberSecondFactors } from '@ensemus/application/security-policy';
import { canProduct } from '@ensemus/domain/product-policy';
import { can } from '@ensemus/domain/policy';
import { ActionLink, ErrorNotice, PageHead } from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
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
        description="Keep your own account safe, and choose when your company asks people to confirm it’s really them."
      />
      <ErrorNotice code={query.error} />
      {notice && (
        <p className="notice good" role="status">
          {notice}
        </p>
      )}
      <div className="stack">
        <section className="card" aria-labelledby="your-sign-in">
          <div className="spread">
            <h2 id="your-sign-in">Your sign-in</h2>
            <span className={`badge ${enrolled ? 'done' : 'attention'}`}>
              {enrolled ? 'Two-step sign-in is on' : 'Two-step sign-in is off'}
            </span>
          </div>
          <p className="gap-above-small">
            {enrolled
              ? 'Signing in asks for a code from your authenticator app, and you have recovery codes for when your phone is not with you.'
              : 'Add an authenticator app, so signing in needs a code from your phone as well. It also lets you make sensitive changes. It takes about two minutes.'}
          </p>
          <div className="gap-above">
            <ActionLink
              variant={enrolled ? 'secondary' : 'primary'}
              href={`/o/${organizationId}/security/two-factor`}
            >
              {enrolled ? 'Manage authenticator app' : 'Set up authenticator app'}
            </ActionLink>
          </div>
        </section>
        {canProduct(context.role, 'sso.manage') && (
          <section className="card" aria-labelledby="company-sign-in">
            <h2 id="company-sign-in">Company sign-in</h2>
            <p>
              Let people sign in through your company’s own sign-in service, and let it add and
              remove people for you.
            </p>
            <div className="gap-above">
              <ActionLink variant="secondary" href={`/o/${organizationId}/security/sso`}>
                Manage company sign-in
              </ActionLink>
            </div>
          </section>
        )}
        <section className="card" aria-labelledby="confirmation-rules">
          <h2 id="confirmation-rules">Company confirmation rules</h2>
          <p>
            Sensitive changes always ask for a recent code. Your company{' '}
            {policy.mfaForAdministration ? 'also asks' : 'does not yet ask'} when someone manages
            people, connections and company settings. A confirmation lasts{' '}
            {policy.mfaMaxAgeSeconds % 60 === 0
              ? `${policy.mfaMaxAgeSeconds / 60} minutes`
              : `${policy.mfaMaxAgeSeconds} seconds`}
            .
          </p>
          {canProduct(context.role, 'security_policy.manage') ? (
            <form
              className="fields gap-above"
              action={updateSecurityPolicyAction.bind(null, organizationId)}
            >
              <input type="hidden" name="version" value={policy.version} />
              <label className="choice">
                <input
                  name="mfaForAdministration"
                  type="checkbox"
                  defaultChecked={policy.mfaForAdministration}
                />
                <strong>Also require a recent code for administration</strong>
                <small>When someone manages people, connections or company settings.</small>
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
            <p className="muted gap-above-small">A company owner can change these rules.</p>
          )}
        </section>
        {people && (
          <section className="card" aria-labelledby="people-setup">
            <h2 id="people-setup">Who has set up an authenticator app</h2>
            <p className="muted">
              Only whether each person has set one up is shown here. Their keys and recovery codes
              stay private.
            </p>
            <div className="table-wrap row-titled gap-above">
              <table>
                <caption className="visually-hidden">
                  Active members’ authenticator app status
                </caption>
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
                      <td>
                        <span className={`badge ${person.enrolled ? 'done' : ''}`}>
                          {person.enrolled ? 'Set up' : 'Not set up'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </>
  );
}
