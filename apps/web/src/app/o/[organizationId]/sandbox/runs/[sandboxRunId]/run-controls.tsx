'use client';

import { useActionState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { SubmitButton } from '@/components/submit-button';
import { ErrorNotice } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { stopSandboxTrial, type SandboxCancelFormState } from '../../actions';

const initial: SandboxCancelFormState = {};

export function SandboxRunControls({
  organizationId,
  sandboxRunId,
}: {
  organizationId: string;
  sandboxRunId: string;
}) {
  const router = useRouter();
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [router]);
  const href = `/o/${organizationId}/sandbox/runs/${sandboxRunId}`;
  const [state, action] = useActionState(
    stopSandboxTrial.bind(null, organizationId, sandboxRunId),
    initial,
    href,
  );
  return (
    <div className="grid gap-3">
      <ErrorNotice code={state.code} />
      {state.requested && <p role="status">Cancellation requested.</p>}
      <div className="flex flex-wrap items-start gap-2">
        <Button asChild variant="outline" className="w-full sm:w-auto">
          <a href={href}>Refresh status</a>
        </Button>
        {!state.requested && (
          <form action={action} className="w-full sm:w-auto">
            <SubmitButton className="w-full sm:w-auto secondary" working="Requesting cancellation">
              Cancel trial
            </SubmitButton>
          </form>
        )}
      </div>
    </div>
  );
}
