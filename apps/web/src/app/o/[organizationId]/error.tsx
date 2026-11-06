'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';

// Keeps the navigation in place when one page fails, so there is always a way on from here.
export default function OrganizationError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { organizationId } = useParams<{ organizationId: string }>();
  return (
    <>
      <h1>This page could not be shown</h1>
      <p role="alert">
        Something went wrong on our side. Nothing you saved has been lost, and the rest of Ensemus
        may still work.
      </p>
      <div className="row">
        <button type="button" onClick={reset}>
          Try again
        </button>
        <Link className="button quiet" href={`/o/${organizationId}`}>
          Go to Home
        </Link>
      </div>
      {error.digest && (
        <p className="muted" style={{ marginTop: '1rem' }}>
          If this keeps happening, give your administrator this reference: {error.digest}
        </p>
      )}
    </>
  );
}
