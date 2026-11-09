// Audit of refused requests (NEXT-01). A forged tenant, role or state is refused by the checks that
// were always there. This adds the record that it happened, written after the refused work has rolled
// back. It takes no text from the request: a code from the list below, a surface we name, and who.
import {
  appendRefusal,
  withNewTenantTx,
  withTenantTx,
  type AppDatabase,
  type RefusalSurface,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { AppError, pgCode, type ErrorCode } from './errors';

/**
 * Being told no about a tenant, role or state a request had no business asking for. Mistyped input,
 * and someone else getting there first, are ordinary and leave no record here.
 */
const REFUSALS: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'NOT_FOUND',
  'FORBIDDEN',
  'INVALID_TRANSITION',
  'INVALID_STATE',
  'PREREQUISITES_INCOMPLETE',
  'EVIDENCE_MISSING',
  'OWNER_CONFIRMATION_REQUIRED',
  'APPROVAL_WRONG_APPROVER',
  'APPROVAL_SELF_APPROVAL',
  'APPROVAL_HASH_MISMATCH',
  'MFA_REQUIRED',
  'SSO_REQUIRED',
]);

/** Whether this error is one a person should be able to find in the audit log afterwards. */
export const isAuditedRefusal = (error: unknown): error is AppError =>
  error instanceof AppError && (error.auditAs !== undefined || REFUSALS.has(error.code));

export type RefusalCode = ErrorCode | NonNullable<AppError['auditAs']>;

/** The code a refusal goes on the record under. */
export const refusalCode = (error: AppError): RefusalCode => error.auditAs ?? error.code;

/** Every code isAuditedRefusal can produce, and so every code a refusal row may carry. */
const AUDITED_CODES: ReadonlySet<RefusalCode> = new Set<RefusalCode>([
  ...REFUSALS,
  'FOREIGN_REFERENCE',
]);

/**
 * A refusal inside the tenant this person belongs to. Returns whether a new row was written.
 *
 * A tenant that is not served in full gets a read-only withTenantTx (ADR-032 D5), and the refusal row
 * is a write, so it would fail with 25006 and the record that someone was refused would be lost exactly
 * when a restricted tenant is most likely being probed. ADR-032 D5 therefore exempts this one write:
 * for an audited refusal code, the row goes through a writable transaction bound to the same tenant,
 * holding nothing but appendRefusal. RLS still confines it to that tenant, the row is still one an hour
 * per person, surface and code, and no caller code runs inside it. That is the reach auditTenantRefusal
 * already has into any tenant, whatever its standing. TENANT_READ_ONLY, the standing's own answer to a
 * write, is not an audited refusal, so it keeps the read-only path and still writes nothing.
 */
export function auditRefusal(
  database: AppDatabase,
  context: TenantContext,
  refusal: { code: RefusalCode; surface: RefusalSurface; now?: Date },
) {
  const append = (tx: Tx) =>
    appendRefusal(tx, {
      organizationId: context.organizationId,
      actorId: context.membershipId,
      surface: refusal.surface,
      code: refusal.code,
      ...(refusal.now ? { now: refusal.now } : {}),
    });
  if (context.serving && context.serving !== 'full' && AUDITED_CODES.has(refusal.code))
    return withNewTenantTx(database, context.organizationId, context.userId, append);
  return withTenantTx(database, context, append);
}

const FOREIGN_KEY_VIOLATION = '23503';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Someone named a tenant they do not belong to. The row goes to that tenant, whose admins are the ones
 * who need to know, and nobody in the person's own tenant can see it. An ID that is no organization at
 * all has nowhere to go, so it leaves no row, and the answer to the caller is the same either way.
 */
export async function auditTenantRefusal(
  database: AppDatabase,
  refusal: { userId: string; organizationId: string; surface: RefusalSurface; now?: Date },
) {
  if (!UUID.test(refusal.organizationId)) return false;
  // This came straight from a request, with no membership row to take the real spelling from.
  const organizationId = refusal.organizationId.toLowerCase();
  try {
    return await withNewTenantTx(database, organizationId, refusal.userId, (tx) =>
      appendRefusal(tx, {
        organizationId,
        actorId: refusal.userId,
        surface: refusal.surface,
        code: 'TENANT_ACCESS_DENIED',
        ...(refusal.now ? { now: refusal.now } : {}),
      }),
    );
  } catch (error) {
    if (pgCode(error) === FOREIGN_KEY_VIOLATION) return false;
    throw error;
  }
}
