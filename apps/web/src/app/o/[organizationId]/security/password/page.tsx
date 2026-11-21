import { SubmitButton } from '@/components/submit-button';
import { BackLink, PageHead } from '@/components/ui';
import { changePasswordAction } from '@/server/account-mail-actions';
import { requireTenant } from '@/server/tenant';

export const metadata = { title: 'Change your password | Ensemus' };

const ERRORS: Record<string, string> = {
  current: 'Your current password was not right.',
  match: 'The two new passwords were not the same. Type them again.',
  weak: 'Use a new password of at least 12 characters, and no more than 128.',
  rate: 'Too many attempts. Wait a minute, then try again.',
  failed:
    'We could not change your password. If you sign in through your company, change it there instead.',
};

export default async function ChangePasswordPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { organizationId } = await params;
  const query = await searchParams;
  await requireTenant(organizationId);
  return (
    <>
      <BackLink href={`/o/${organizationId}/security`}>Back to security</BackLink>
      <PageHead
        title="Change your password"
        description="Your password is the same in every company you belong to. Changing it signs you out everywhere else."
      />
      {query.error && (
        <p className="notice error" role="alert">
          {ERRORS[query.error] ?? ERRORS.failed}
        </p>
      )}
      {query.notice === 'changed' && (
        <p className="notice good" role="status">
          Your password is changed. You’re still signed in here, and signed out everywhere else.
        </p>
      )}
      <form
        className="card fields form-width"
        action={changePasswordAction.bind(null, organizationId)}
      >
        <label>
          Current password
          <input name="current" type="password" autoComplete="current-password" required />
        </label>
        <label>
          New password
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            required
          />
          <small>At least 12 characters. A short sentence is easy to remember.</small>
        </label>
        <label>
          Type the new password again
          <input
            name="confirm"
            type="password"
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            required
          />
        </label>
        <div>
          <SubmitButton working="Changing your password">Change password</SubmitButton>
        </div>
      </form>
    </>
  );
}
