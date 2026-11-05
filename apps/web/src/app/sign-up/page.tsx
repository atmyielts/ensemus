import Link from 'next/link';
import { notFound } from 'next/navigation';
import { signUpAction } from '@/server/actions';
import { getRuntime } from '@/server/runtime';

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (!getRuntime().config.allowSignup) notFound();
  const { error } = await searchParams;
  return (
    <main>
      <h1>Create your account</h1>
      {error && (
        <p className="error" role="alert">
          We could not create that account. Check your details, and use a password of at least 12
          characters.
        </p>
      )}
      <form action={signUpAction}>
        <label>
          Name
          <input name="name" autoComplete="name" required />
        </label>
        <label>
          Email
          <input name="email" type="email" autoComplete="username" required />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            required
          />
        </label>
        <button type="submit">Create account</button>
      </form>
      <p>
        Already have an account? <Link href="/sign-in">Sign in</Link>
      </p>
    </main>
  );
}
