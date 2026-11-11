'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { PageHead } from '@/components/ui';

// Keeps the navigation in place when one page fails, so there is always a way on from here.
export default function OrganizationError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { organizationId } = useParams<{ organizationId: string }>();
  // Asks the server again: on its own, reset only redraws what the browser already has, which here is
  // the failure.
  const router = useRouter();
  const [, startTransition] = useTransition();
  const tryAgain = () =>
    startTransition(() => {
      router.refresh();
      reset();
    });
  return (
    <>
      <PageHead
        title="This page could not be shown"
        description="Something went wrong on our side, not because of anything you did."
      />
      <div className="card">
        <p role="alert">
          Nothing you saved has been lost, and the rest of Ensemus should still work. Try this page
          again, or go back to Home and carry on from there.
        </p>
        <div className="row">
          <button type="button" onClick={tryAgain}>
            Try again
          </button>
          <Link className="button secondary" href={`/o/${organizationId}`}>
            Go to Home
          </Link>
        </div>
      </div>
      {error.digest && (
        <details className="error-reference gap-above-large">
          <summary>If this keeps happening</summary>
          <p>
            Give your administrator this reference, so they can find what went wrong:{' '}
            <code>{error.digest}</code>
          </p>
        </details>
      )}
    </>
  );
}
