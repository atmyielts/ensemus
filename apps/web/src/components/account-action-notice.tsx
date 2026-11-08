import { accountStepUpPath, safeAccountStepUpReturn } from '@/lib/step-up';
import { ErrorNotice, ReloadLink } from './ui';

/** Keep the submitted form and its original version in this tab while proving identity elsewhere. */
export function AccountActionNotice({
  code,
  organizationId,
  returnTo,
}: {
  code?: string | undefined;
  organizationId: string;
  returnTo: string;
}) {
  return (
    <>
      <ErrorNotice code={code} />
      {code === 'VERSION_CONFLICT' && (
        <div className="notice" role="status">
          <p>Your entered details are still here and have not been saved. Trying again uses the same original version.</p>
          <p>To use the latest saved details, reload and discard this draft. Copy anything you want to keep before choosing to reload.</p>
          <ReloadLink href={safeAccountStepUpReturn(organizationId, returnTo)}>Reload and discard my draft</ReloadLink>
        </div>
      )}
      {code === 'MFA_REQUIRED' && (
        <div className="notice" role="status">
          <p>
            <a
              className="button secondary"
              href={accountStepUpPath(organizationId, returnTo)}
              target="_blank"
              rel="noopener"
            >
              Confirm your identity in another tab
            </a>
          </p>
          <p>
            After confirming, return to this tab and submit the form again. Your entered details and
            the version you were editing stay here.
          </p>
        </div>
      )}
    </>
  );
}
