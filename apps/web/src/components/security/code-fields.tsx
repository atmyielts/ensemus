export function CodeFields({ backup = true }: { backup?: boolean }) {
  return (
    <>
      {backup ? (
        <label>
          Code type
          <select name="kind" defaultValue="totp">
            <option value="totp">Authenticator app</option>
            <option value="backup_code">Recovery code</option>
          </select>
        </label>
      ) : (
        <input type="hidden" name="kind" value="totp" />
      )}
      <label>
        Verification code
        <input
          name="code"
          type="text"
          autoComplete="one-time-code"
          inputMode={backup ? 'text' : 'numeric'}
          pattern={backup ? '[0-9A-Za-z-]{6,32}' : '[0-9]{6}'}
          maxLength={backup ? 32 : 6}
          minLength={6}
          required
          spellCheck={false}
          autoCapitalize="none"
        />
      </label>
    </>
  );
}
export function FactorError({ code }: { code?: string | undefined }) {
  if (!code) return null;
  const message =
    code === 'rate'
      ? 'Too many attempts. Wait before trying a new code.'
      : code === 'setup'
        ? 'An authenticator setup is already waiting. Finish with the key you saved. If you lost that key, ask the installation operator to reset it before starting again.'
        : code === 'already'
          ? 'Your authenticator app is already set up. Reload this page to manage it.'
          : code === 'enroll'
            ? 'Set up an authenticator app first.'
            : code === 'primary'
              ? 'Sign in again, then restart setup. Your earlier sign-in or setup confirmation is no longer current.'
              : code === 'unavailable'
                ? 'We could not confirm this right now. Try again with a new code.'
                : 'Those details could not be used. Check them, or wait for the next app code.';
  return (
    <p className="notice error" role="alert">
      {message}
    </p>
  );
}
