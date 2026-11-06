import 'server-only';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getRuntime } from './runtime';

/** The signed-in person, always resolved on the server. Client input never decides this. */
export async function requireActor() {
  const session = await getRuntime().auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/sign-in');
  return {
    userId: session.user.id,
    /** For recent-MFA checks. From the verified cookie, and never from a form or a header. */
    sessionId: session.session.id,
    name: session.user.name,
    email: session.user.email,
    emailVerified: session.user.emailVerified,
  };
}
