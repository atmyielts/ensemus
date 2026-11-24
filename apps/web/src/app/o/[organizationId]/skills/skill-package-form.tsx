'use client';

import type { SkillPackageView } from '@ensemus/application';
import { useActionState } from 'react';
import { SubmitButton } from '@/components/submit-button';
import { ErrorNotice } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { saveSkillPackageAction, type PackageFormState } from './actions';

const INITIAL: PackageFormState = {};

export function SkillPackageForm({
  organizationId,
  pkg,
}: {
  organizationId: string;
  pkg?: SkillPackageView;
}) {
  const base = `/o/${organizationId}/skills`;
  const path = pkg ? `${base}/${pkg.id}` : `${base}/new`;
  const [state, action] = useActionState(saveSkillPackageAction, INITIAL, path);
  return (
    <form className="fields" action={action}>
      <input type="hidden" name="organizationId" value={organizationId} />
      {pkg && (
        <>
          <input type="hidden" name="packageId" value={pkg.id} />
          <input type="hidden" name="version" value={pkg.version} />
        </>
      )}
      <ErrorNotice code={state.code} />
      {state.stepUp && <a href={state.stepUp}>Verify your identity</a>}
      <Label>
        Display name
        <Input
          name="displayName"
          maxLength={120}
          required
          defaultValue={state.values?.displayName ?? pkg?.displayName}
        />
      </Label>
      {!pkg && (
        <Label>
          Package name
          <small>Use lowercase letters, numbers and hyphens. Start with a letter.</small>
          <Input
            name="name"
            minLength={2}
            maxLength={64}
            pattern="[a-z][a-z0-9\-]{1,63}"
            required
            defaultValue={state.values?.name}
          />
        </Label>
      )}
      {pkg?.origin !== 'marketplace' && (
        <div className="grid gap-1.5">
          <Label htmlFor="skill-package-classification">Content classification</Label>
          <NativeSelect
            id="skill-package-classification"
            name="classification"
            defaultValue={state.values?.classification || pkg?.contentClassification || 'internal'}
          >
            <option value="internal">Internal</option>
            <option value="public">Public</option>
            <option value="confidential">Confidential</option>
            <option value="restricted">Restricted</option>
          </NativeSelect>
        </div>
      )}
      {pkg && (
        <div className="grid gap-1.5">
          <Label htmlFor="skill-package-status">Status</Label>
          <NativeSelect
            id="skill-package-status"
            name="state"
            defaultValue={state.values?.state || pkg.state}
          >
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
          </NativeSelect>
        </div>
      )}
      <div className="row">
        {state.code === 'VERSION_CONFLICT' ? (
          <Button asChild variant="outline">
            <a href={path}>Reload package</a>
          </Button>
        ) : (
          <SubmitButton working={pkg ? 'Saving changes' : 'Creating package'}>
            {pkg ? 'Save changes' : 'Create package'}
          </SubmitButton>
        )}
      </div>
    </form>
  );
}
