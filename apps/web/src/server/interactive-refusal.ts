import 'server-only';
import { AppError } from '@ensemus/application';
import { redirect } from 'next/navigation';

/** A revoked company identity needs the actual company sign-in flow, not another local factor. */
export function redirectForSsoRefusal(error: unknown): void {
  if (error instanceof AppError && error.code === 'SSO_REQUIRED') redirect('/sign-in/sso');
}
