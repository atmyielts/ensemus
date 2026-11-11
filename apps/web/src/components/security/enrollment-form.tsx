'use client';
import { useActionState } from 'react';
import { SubmitButton } from '@/components/submit-button';
import { CodeFields, FactorError } from './code-fields';
import type { SecretState } from './security-types';
import styles from './security.module.css';

const INITIAL: SecretState = { status: 'idle' };
function RecoveryCodes({ codes }: { codes: readonly string[] }) {
  return (
    <section aria-labelledby="recovery-codes-heading">
      <h2 id="recovery-codes-heading">Save your recovery codes</h2>
      <p>
        If your phone is ever lost, a recovery code lets you sign in. Keep these somewhere private,
        away from this device. Each code works once, and they will not be shown again.
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
type SecretAction = (previous: SecretState, form: FormData) => Promise<SecretState>;
// Bind tenant arguments in the ServerPage. A fresh client-render .bind() Promise makes native
// postback signature matching suspend forever in the pinned Fizz renderer.
export function EnrollmentForm({
  organizationId,
  enableAction,
  finishAction,
  permalink,
}: {
  organizationId: string;
  enableAction: SecretAction;
  finishAction: (form: FormData) => Promise<void>;
  permalink?: string;
}) {
  const [state, action] = useActionState(
    enableAction,
    INITIAL,
    permalink ?? `/o/${organizationId}/security/two-factor`,
  );
  return state.status === 'ready' ? (
    <div className={styles.flow}>
      <section>
        <p className="muted">Step 1 of 3</p>
        <h2>Add Ensemus to your authenticator app</h2>
        <p>
          In your app, choose “Enter a setup key”, then type this key and choose a time-based code.
        </p>
        <p className={styles.secret}>
          <code>{state.secret}</code>
        </p>
        <p>
          <a href={state.totpURI}>Open in an authenticator app on this device</a>
        </p>
      </section>
      <div>
        <p className="muted">Step 2 of 3</p>
        <RecoveryCodes codes={state.backupCodes ?? []} />
      </div>
      <section>
        <p className="muted">Step 3 of 3</p>
        <h2>Confirm the app is ready</h2>
        <p>Enter the code your app shows now. Two-step sign-in stays off until you do.</p>
        <form className="fields" action={finishAction}>
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
        Any authenticator app that makes time-based codes works. No text messages, and nothing else
        to sign up for.
      </p>
      <div>
        <SubmitButton working="Preparing">Set up authenticator app</SubmitButton>
      </div>
    </form>
  );
}
export function RecoveryCodeForm({
  organizationId,
  regenerateAction,
}: {
  organizationId: string;
  regenerateAction: SecretAction;
}) {
  const [state, action] = useActionState(
    regenerateAction,
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
