// Account recovery reads only the current sign-in policy. A full-serving context never escapes.
import { interactiveSessionOf, type AppDatabase, type TenantContext } from '@ensemus/database';
import { accountContextOf } from '@ensemus/database/account';
import { getSecurityPolicy } from '../product/security-policy';
import { AppError } from '../errors';

export function getAccountSecurityPolicy(database: AppDatabase, context: TenantContext) {
  if (context.actorType !== 'user' || !interactiveSessionOf(context))
    throw new AppError('NOT_FOUND');
  // The existing reader checks fresh active same-user membership in the actual transaction.
  return getSecurityPolicy(database, accountContextOf(context));
}
