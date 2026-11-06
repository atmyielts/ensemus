'use client';
import { useActionState } from 'react';
import { SubmitButton } from '@/components/submit-button';
import {
  enableSecondFactorAction,
  finishEnrollmentAction,
  regenerateRecoveryCodesAction,
} from '@/server/security-actions';
import { CodeFields, FactorError } from './code-fields';
import type { SecretState } from './security-types';
import styles from './security.module.css';

const INITIAL: SecretState = { status: 'idle' };
function RecoveryCodes({ codes }: { codes: readonly string[] }) {
  return (
    <section aria-labelledby="recovery-codes-heading">
      <h2 id="recovery-codes-heading">Save your recovery codes</h2>
      <p>
        Keep these somewhere private, away from this device. Each code works once. They will not be
        shown again.
      </p>
      <ul className={styles.codes}>
        {codes.map((code) => (
          <li key={code}>
            <code>{code}</code>
          </li>
        ))}
      </ul>
    </section>
  );
}
export function EnrollmentForm({ organizationId }: { organizationId: string }) {
  const [state, action] = useActionState(
    enableSecondFactorAction.bind(null, organizationId),
    INITIAL,
    `/o/${organizationId}/security/two-factor`,
  );
  return state.status === 'ready' ? (
    <div className={styles.flow}>
      <section>
        <h2>Add Ensemus to your authenticator app</h2>
        <p>
          Choose “Enter a setup key” in your app, then enter this key. Choose a time-based code.
        </p>
        <p className={styles.secret}>
          <code>{state.secret}</code>
        </p>
        <p>
          <a href={state.totpURI}>Open in an authenticator app on this device</a>
        </p>
      </section>
      <RecoveryCodes codes={state.backupCodes ?? []} />
      <section>
        <h2>Confirm the app is ready</h2>
        <p>Two-step sign-in stays off until you enter a current app code.</p>
        <form className="fields" action={finishEnrollmentAction.bind(null, organizationId)}>
          <CodeFields backup={false} />
          <div>
            <SubmitButton working="Checking">Confirm and turn on</SubmitButton>
          </div>
        </form>
      </section>
    </div>
  ) : (
    <form className="fields" action={action}>
      <FactorError code={state.error} />
      <label>
        Password, if you use one
        <input name="password" type="password" autoComplete="current-password" maxLength={128} />
      </label>
      <p className="muted">
        Use any authenticator app that makes time-based codes. No text messages or external service
        are needed.
      </p>
      <div>
        <SubmitButton working="Preparing">Set up authenticator app</SubmitButton>
      </div>
    </form>
  );
}
export function RecoveryCodeForm({ organizationId }: { organizationId: string }) {
  const [state, action] = useActionState(
    regenerateRecoveryCodesAction.bind(null, organizationId),
    INITIAL,
    `/o/${organizationId}/security/two-factor`,
  );
  return state.status === 'ready' ? (
    <RecoveryCodes codes={state.backupCodes ?? []} />
  ) : (
    <form className="fields" action={action}>
      <FactorError code={state.error} />
      <label>
        Password, if you use one
        <input name="password" type="password" autoComplete="current-password" maxLength={128} />
      </label>
      <CodeFields />
      <p className="muted">The new codes replace every unused recovery code you saved before.</p>
      <div>
        <SubmitButton working="Replacing codes">Replace recovery codes</SubmitButton>
      </div>
    </form>
  );
}
