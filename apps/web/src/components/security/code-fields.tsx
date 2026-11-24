import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Input } from '@/components/ui/input';
export function CodeFields({ backup = true }: { backup?: boolean }) {
  return (
    <>
      {backup ? (
        <Label>
          Code type
          <NativeSelect name="kind" defaultValue="totp">
            <option value="totp">Authenticator app</option>
            <option value="backup_code">Recovery code</option>
          </NativeSelect>
        </Label>
      ) : (
        <input type="hidden" name="kind" value="totp" />
      )}
      <Label>
        Verification code
        <Input
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
      </Label>
    </>
  );
}
export function FactorError({ code }: { code?: string | undefined }) {
  if (!code) return null;
  const message =
    code === 'rate'
      ? 'Too many attempts. Wait before trying a new code.'
      : code === 'setup'
        ? 'An authenticator setup is already waiting. Finish with the key you saved. If you lost that key, ask whoever set up Ensemus for your company to reset it before starting again.'
        : code === 'already'
          ? 'Your authenticator app is already set up. Reload this page to manage it.'
          : code === 'enroll'
            ? 'Set up an authenticator app first.'
            : code === 'primary'
              ? 'Sign in again, then restart setup. If you sign in through your company, sign in there again first. If that still does not work, ask whoever set up Ensemus for your company.'
              : code === 'unavailable'
                ? 'We could not check that just now. Try again with a new code.'
                : 'Those details could not be used. Check them, or wait for the next app code.';
  return (
    <p className="notice error" role="alert">
      {message}
    </p>
  );
}
