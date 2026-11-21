import { SubmitButton } from '@/components/submit-button';
import { BackLink, PageHead } from '@/components/ui';
import { changeEmailAction, resendVerificationAction } from '@/server/account-mail-actions';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/tenant';

export const metadata = { title: 'Your email address | Ensemus' };

const ERRORS: Record<string, string> = {
  password: 'Your password was not right.',
  address: 'That doesn’t look like an email address.',
  same: 'That is already your email address.',
  rate: 'Too many attempts. Wait a few minutes, then try again.',
  failed: 'We could not start the change. Try again in a few minutes.',
};

const NOTICES: Record<string, string> = {
  sent: 'We’ve sent you a new link. Open it to confirm your address.',
  approve:
    'Check your current inbox. Approve the change there, and we’ll send a last link to the new address.',
  verify: 'Check the new address’s inbox, and open the link there to finish the change.',
};

export default async function EmailAddressPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { organizationId } = await params;
  const query = await searchParams;
  const { actor } = await requireTenant(organizationId);
  const { mailEnabled } = getRuntime().config;
  const notice = query.notice ? NOTICES[query.notice] : undefined;
  return (
    <>
      <BackLink href={`/o/${organizationId}/security`}>Back to security</BackLink>
      <PageHead
        title="Your email address"
        description="You sign in with this address, and it is where we send your notifications and password resets."
      />
      {query.error && (
        <p className="notice error" role="alert">
          {ERRORS[query.error] ?? ERRORS.failed}
        </p>
      )}
      {notice && (
        <p className="notice good" role="status">
          {notice}
        </p>
      )}
      <div className="stack">
        <section className="card" aria-labelledby="current-address">
          <div className="spread">
            <h2 id="current-address">{actor.email}</h2>
            <span className={`badge ${actor.emailVerified ? 'done' : 'attention'}`}>
              {actor.emailVerified ? 'Confirmed' : 'Not confirmed yet'}
            </span>
          </div>
          {!actor.emailVerified && (
            <>
              <p className="gap-above-small">
                Confirm it, and we can tell you by email when something needs you.
              </p>
              {mailEnabled && (
                <form
                  className="gap-above"
                  action={resendVerificationAction.bind(null, organizationId)}
                >
                  <SubmitButton working="Sending">Send me a link</SubmitButton>
                </form>
              )}
            </>
          )}
        </section>
        <section className="card" aria-labelledby="change-address">
          <h2 id="change-address">Change your email address</h2>
          {mailEnabled ? (
            <form
              className="fields gap-above"
              action={changeEmailAction.bind(null, organizationId)}
            >
              <p className="muted">
                Nothing changes until you follow the links we email you
                {actor.emailVerified ? ', first at this address, then at the new one' : ''}.
              </p>
              <label>
                New email address
                <input name="email" type="email" autoComplete="email" maxLength={254} required />
              </label>
              <label>
                Your password
                <input name="password" type="password" autoComplete="current-password" required />
                <small>We ask again to make sure it’s really you.</small>
              </label>
              <div>
                <SubmitButton working="Sending">Email me a link</SubmitButton>
              </div>
            </form>
          ) : (
            <p className="muted gap-above-small">
              Changing your address needs email, which isn’t set up here. Ask whoever looks after
              Ensemus at your company.
            </p>
          )}
        </section>
      </div>
    </>
  );
}
