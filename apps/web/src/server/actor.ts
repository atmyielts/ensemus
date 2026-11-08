import 'server-only';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getRuntime } from './runtime';
import {isRestoreAdmissionDenied} from '@ensemus/database';

/** The signed-in person, always resolved on the server. Client input never decides this. */
export async function requireActor() {
  const session = await getRuntime().readInteractiveSession(await headers()).catch((error:unknown)=>{
    if(isRestoreAdmissionDenied(error))redirect('/restoring');throw error;
  });
  if (!session) redirect('/sign-in');
  return {
    userId: session.user.id,
    /** For recent-MFA checks. From the verified cookie, and never from a form or a header. */
    sessionId: session.session.id,
    interactiveIdentity: session.identity,
    name: session.user.name,
    email: session.user.email,
    emailVerified: session.user.emailVerified,
  };
}
