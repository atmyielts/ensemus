'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { PageHead } from '@/components/ui';

/**
 * The page could not be read, which says nothing about the run itself. Someone looking here may be
 * trying to stop it, so this states that it may still be going, and that nothing here stopped it.
 */
export default function RunError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { organizationId, workUnitId } = useParams<{
    organizationId: string;
    workUnitId: string;
  }>();
  const router = useRouter();
  const [, startTransition] = useTransition();
  const tryAgain = () =>
    startTransition(() => {
      router.refresh();
      reset();
    });
  return (
    <>
      <PageHead title="This run could not be shown" />
      <p role="alert">
        We could not read this run just now, so we cannot say what it is doing. If it was running, it
        may still be, and nothing on this page stopped it.
      </p>
      <div className="row">
        <button type="button" onClick={tryAgain}>
          Try again
        </button>
        <Link className="button quiet" href={`/o/${organizationId}/work/${workUnitId}`}>
          Back to the work
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
