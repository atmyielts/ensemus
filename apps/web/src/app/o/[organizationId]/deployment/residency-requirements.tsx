import type { ResidencyRequirementView } from '@ensemus/application';
import { RESIDENCY_SCOPES, type ResidencyScope } from '@ensemus/domain/residency';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { ConfirmForm } from '@/components/confirm-form';
import { SubmitButton } from '@/components/submit-button';
import { ErrorNotice } from '@/components/ui';
import { stepUpPath } from '@/lib/step-up';
import { updateResidencyRequirement } from './actions';

const SCOPE_LABELS: Record<ResidencyScope, string> = {
  all: 'All data',
  public: 'Public',
  internal: 'Internal',
  confidential: 'Confidential',
  restricted: 'Restricted',
};

export function ResidencyRequirements({
  organizationId,
  homeRegion,
  requirements,
  owner,
  ready,
  error,
  saved,
}: {
  organizationId: string;
  homeRegion: string | null;
  requirements: readonly ResidencyRequirementView[];
  owner: boolean;
  ready: boolean;
  error: string | undefined;
  saved: boolean;
}) {
  const action = updateResidencyRequirement.bind(null, organizationId);
  const path = `/o/${organizationId}/deployment`;
  return (
    <Card asChild>
      <section className="card min-w-0" aria-labelledby="residency-requirements">
        <h2 id="residency-requirements">Residency requirements</h2>
        <ErrorNotice code={error} />
        {saved && !error && (
          <p className="notice good" role="status">
            Residency requirements saved.
          </p>
        )}
        {requirements.length ? (
          <ul className="list" aria-label="Saved residency requirements">
            {requirements.map((requirement) => (
              <li key={requirement.scope} className="flex-wrap">
                <div className="min-w-0">
                  <h3 className="m-0">{SCOPE_LABELS[requirement.scope]}</h3>
                  <p className="m-0 wrap-anywhere text-sm text-muted-foreground">
                    {requirement.region}
                  </p>
                </div>
                {owner && ready && (
                  <ConfirmForm
                    action={action}
                    fields={
                      <>
                        <input type="hidden" name="operation" value="remove" />
                        <input
                          type="hidden"
                          name="selection"
                          value={`${requirement.scope}:${requirement.version}`}
                        />
                      </>
                    }
                    summary="Remove"
                    summaryLabel={`Remove the ${SCOPE_LABELS[requirement.scope].toLowerCase()} requirement`}
                    consequence="This removes the region restriction for this scope. Any requirement for all data still applies."
                    confirmLabel="Remove requirement"
                  />
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">This organization has no saved residency requirements.</p>
        )}
        {owner && !ready && (homeRegion || requirements.length > 0) && (
          <Button asChild variant="outline">
            <Link href={stepUpPath(organizationId, path)}>
              Confirm your identity to make changes
            </Link>
          </Button>
        )}
        {owner && ready && homeRegion && (
          <form action={action} className="mt-3 grid min-w-0 max-w-sm gap-3">
            <input type="hidden" name="operation" value="set" />
            <input type="hidden" name="region" value={homeRegion} />
            <p className="m-0 text-sm text-muted-foreground">
              Required region{' '}
              <span className="wrap-anywhere font-medium text-foreground">{homeRegion}</span>
            </p>
            <Label>
              Data scope
              <NativeSelect name="selection" required>
                {RESIDENCY_SCOPES.map((scope) => (
                  <option
                    key={scope}
                    value={`${scope}:${requirements.find((row) => row.scope === scope)?.version ?? 0}`}
                  >
                    {SCOPE_LABELS[scope]}
                  </option>
                ))}
              </NativeSelect>
            </Label>
            <div>
              <SubmitButton working="Saving requirement">Save requirement</SubmitButton>
            </div>
          </form>
        )}
      </section>
    </Card>
  );
}
