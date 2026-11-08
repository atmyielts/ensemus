import { accountStepUpPath } from '@/lib/step-up';
import { ErrorNotice } from './ui';

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
