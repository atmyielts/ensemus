import Link from 'next/link';
import { signInAction } from '@/server/actions';
import { getRuntime } from '@/server/runtime';

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const { allowSignup } = getRuntime().config;
  return (
    <main>
      <h1>Sign in to Ensemus</h1>
      {error && (
        <p className="error" role="alert">
          That email and password did not match.
        </p>
      )}
      <form action={signInAction}>
        <label>
          Email
          <input name="email" type="email" autoComplete="username" required />
        </label>
        <label>
          Password
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        <button type="submit">Sign in</button>
      </form>
      {allowSignup && (
        <p>
          New here? <Link href="/sign-up">Create an account</Link>
        </p>
      )}
    </main>
  );
}
