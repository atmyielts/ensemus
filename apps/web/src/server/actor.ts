import 'server-only';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getRuntime } from './runtime';

/** The signed-in person, always resolved on the server. Client input never decides this. */
export async function requireActor() {
  const session = await getRuntime().auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/sign-in');
  return { userId: session.user.id, name: session.user.name, email: session.user.email };
}
