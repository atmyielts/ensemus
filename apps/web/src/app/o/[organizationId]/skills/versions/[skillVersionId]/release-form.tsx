'use client';

import { useActionState } from 'react';
import { SubmitButton } from '@/components/submit-button';
import { ErrorNotice } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { changeSkillReleaseAction, type ReleaseFormState } from '../../actions';

const INITIAL: ReleaseFormState = {};

export function SkillReleaseForm({
  organizationId,
  skillVersionId,
  version,
  canPublish,
  canYank,
}: {
  organizationId: string;
  skillVersionId: string;
  version: number;
  canPublish: boolean;
  canYank: boolean;
}) {
  const path = `/o/${organizationId}/skills/versions/${skillVersionId}`;
  const [state, action] = useActionState(changeSkillReleaseAction, INITIAL, path);
  const fields = (
    <>
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="skillVersionId" value={skillVersionId} />
      <input type="hidden" name="version" value={version} />
    </>
  );
  return (
    <>
      <ErrorNotice code={state.code} />
      {state.stepUp && <a href={state.stepUp}>Verify your identity</a>}
      {state.code === 'VERSION_CONFLICT' ? (
        <Button asChild variant="outline">
          <a href={path}>Reload version</a>
        </Button>
      ) : (
        <>
          {canPublish && (
            <form action={action}>
              {fields}
              <input type="hidden" name="operation" value="publish" />
              <SubmitButton working="Publishing version">Publish version</SubmitButton>
            </form>
          )}
          {canYank && (
            <details className="confirm" open={state.operation === 'yank' ? true : undefined}>
              <summary>Withdraw version</summary>
              <form action={action} className="fields">
                {fields}
                <input type="hidden" name="operation" value="yank" />
                <div className="grid gap-1.5">
                  <Label htmlFor="withdraw-skill-reason">Reason</Label>
                  <NativeSelect id="withdraw-skill-reason" name="code">
                    <option value="WITHDRAWN_BY_OWNER">Withdrawn by the workspace</option>
                    <option value="SECURITY_ISSUE">Security issue</option>
                  </NativeSelect>
                </div>
                <Label className="check">
                  <input type="checkbox" name="confirm" value="yes" required />
                  <span>This version can no longer be used after withdrawal.</span>
                </Label>
                <div>
                  <SubmitButton className="danger" working="Withdrawing version">
                    Confirm withdrawal
                  </SubmitButton>
                </div>
              </form>
            </details>
          )}
        </>
      )}
    </>
  );
}
