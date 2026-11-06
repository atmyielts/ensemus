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
      <PageHead title="This page could not be shown" />
      <p role="alert">
        Something went wrong on our side. Nothing you saved has been lost, and the rest of Ensemus
        may still work.
      </p>
      <div className="row">
        <button type="button" onClick={tryAgain}>
          Try again
        </button>
        <Link className="button quiet" href={`/o/${organizationId}`}>
          Go to Home
        </Link>
      </div>
      {error.digest && (
        <p className="muted gap-above-large">
          If this keeps happening, give your administrator this reference: {error.digest}
        </p>
      )}
    </>
  );
}
