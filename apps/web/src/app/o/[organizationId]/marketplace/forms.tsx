'use client';

import { useActionState } from 'react';
import { SubmitButton } from '@/components/submit-button';
import { ErrorNotice } from '@/components/ui';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { marketplaceAction, type MarketplaceFormState, type MarketplaceOperation } from './actions';

const INITIAL: MarketplaceFormState = {};

function Refusal({ state, href }: { state: MarketplaceFormState; href: string }) {
  return (
    <>
      <ErrorNotice code={state.code} />
      {state.stepUp && <a href={state.stepUp}>Verify your identity</a>}
      {state.code === 'VERSION_CONFLICT' && <a href={href}>Reload this page</a>}
    </>
  );
}

export function PublisherRegistrationForm({
  organizationId,
  href,
}: {
  organizationId: string;
  href: string;
}) {
  const [state, action] = useActionState(marketplaceAction.bind(null, 'register'), INITIAL, href);
  return (
    <form className="fields" action={action}>
      <input type="hidden" name="organizationId" value={organizationId} />
      <Refusal state={state} href={href} />
      <Label>
        Publisher name
        <Input name="displayName" defaultValue={state.displayName} maxLength={120} required />
      </Label>
      <div>
        <SubmitButton working="Registering publisher">Become a publisher</SubmitButton>
      </div>
    </form>
  );
}

export function MarketplaceChangeForm({
  organizationId,
  href,
  operation,
  targetId,
  version,
  confirmation,
  label,
  working,
  destructive = false,
}: {
  organizationId: string;
  href: string;
  operation: Exclude<MarketplaceOperation, 'register'>;
  targetId: string;
  version?: number;
  confirmation: string;
  label: string;
  working: string;
  destructive?: boolean;
}) {
  const [state, action] = useActionState(marketplaceAction.bind(null, operation), INITIAL, href);
  return (
    <form action={action} className="fields">
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="targetId" value={targetId} />
      {version !== undefined && <input type="hidden" name="version" value={version} />}
      <Refusal state={state} href={href} />
      {state.code !== 'VERSION_CONFLICT' && (
        <>
          <Label className="check">
            <input type="checkbox" name="confirm" value="yes" required />
            <span>{confirmation}</span>
          </Label>
          <div>
            <SubmitButton className={destructive ? 'danger' : undefined} working={working}>
              {label}
            </SubmitButton>
          </div>
        </>
      )}
    </form>
  );
}
