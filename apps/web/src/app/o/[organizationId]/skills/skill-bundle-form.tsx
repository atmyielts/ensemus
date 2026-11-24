'use client';

import { useActionState } from 'react';
import { SKILL_BUNDLE_CONTENT_TYPE } from '@ensemus/domain/skill';
import { SubmitButton } from '@/components/submit-button';
import { ErrorNotice } from '@/components/ui';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { uploadSkillBundleAction, type UploadFormState } from './actions';

const INITIAL: UploadFormState = {};

export function SkillBundleForm({
  organizationId,
  packageId,
}: {
  organizationId: string;
  packageId: string;
}) {
  const [state, action] = useActionState(
    uploadSkillBundleAction,
    INITIAL,
    `/o/${organizationId}/skills/${packageId}`,
  );
  return (
    <form action={action} className="fields">
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="packageId" value={packageId} />
      <ErrorNotice code={state.code} />
      {state.stepUp && <a href={state.stepUp}>Verify your identity</a>}
      <Label htmlFor="skill-bundle">Signed skill bundle</Label>
      <Input
        id="skill-bundle"
        name="bundle"
        type="file"
        accept={`.json,${SKILL_BUNDLE_CONTENT_TYPE}`}
        aria-describedby="skill-bundle-limit"
        required
        className="h-auto max-w-sm px-0 py-0 file:mr-2.5 file:h-9 file:items-center file:rounded-none file:border-r file:border-input file:bg-muted file:px-3 file:py-0 file:align-middle"
      />
      <small id="skill-bundle-limit">Up to 8 MiB. Verification starts after upload.</small>
      <div className="row">
        <SubmitButton working="Uploading bundle">Upload bundle</SubmitButton>
      </div>
    </form>
  );
}
