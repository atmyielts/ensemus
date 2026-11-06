// Session creation/rotation is not authentication time. Only a successful allowlisted primary OIDC
// callback mints this immutable receipt; refresh, factor enable/disable and code checks cannot renew it.
import { createHmac } from 'node:crypto';
import type { BetterAuthPlugin } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import { authSchema, type openAuthDatabase } from '@ensemus/database/auth';

type Identity = { userId: string; sessionId: string };
type Database = ReturnType<typeof openAuthDatabase>['db'];
const identity = (key: string, input: Identity) => {
  const bytes = createHmac('sha256', key)
    .update(JSON.stringify(['ensemus-primary:v1', input.userId, input.sessionId]))
    .digest();
  const identifier = `ensemus-primary:v1:${bytes.toString('hex')}`,
    uuid = Buffer.from(bytes.subarray(0, 16));
  uuid[6] = (uuid[6]! & 15) | 128;
  uuid[8] = (uuid[8]! & 63) | 128;
  const hex = uuid.toString('hex');
  return {
    id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    identifier,
  };
};
export function createPrimaryAuthentication(
  db: Database,
  key: string,
  providerId: string | undefined,
) {
  const active = async (input: Identity, now: Date) =>
    db.query.sessions.findFirst({
      where: (row, { and, eq, gt }) =>
        and(eq(row.id, input.sessionId), eq(row.userId, input.userId), gt(row.expiresAt, now)),
    });
  const fingerprint = async (
    input: Identity & { maxAgeSeconds: number },
    now: Date,
  ): Promise<string | null> => {
    if (
      !(await active(input, now)) ||
      !Number.isInteger(input.maxAgeSeconds) ||
      input.maxAgeSeconds < 60 ||
      input.maxAgeSeconds > 3600
    )
      return null;
    const credential = await db.query.accounts.findFirst({
      where: (row, { and, eq }) =>
        and(eq(row.userId, input.userId), eq(row.providerId, 'credential')),
    });
    let binding: unknown;
    if (credential?.password) binding = ['credential', credential.id, credential.password];
    else {
      if (!providerId) return null;
      const provider = await db.query.accounts.findFirst({
        where: (row, { and, eq }) =>
          and(eq(row.userId, input.userId), eq(row.providerId, providerId)),
      });
      const proof = await db.query.verifications.findFirst({
        where: (row, { and, eq, gt }) =>
          and(eq(row.id, identity(key, input).id), gt(row.expiresAt, now)),
      });
      const age = proof ? now.getTime() - proof.createdAt.getTime() : -1;
      if (
        !provider ||
        proof?.value !== `oidc:${providerId}` ||
        age < 0 ||
        age > input.maxAgeSeconds * 1000
      )
        return null;
      binding = ['oidc', provider.id, proof.id, proof.createdAt.toISOString()];
    }
    return createHmac('sha256', key)
      .update(JSON.stringify(['ensemus-enrollment-binding:v1', binding]))
      .digest('hex');
  };
  const enrollmentIdentity = (input: Identity) =>
    identity(key, { userId: input.userId, sessionId: `enrollment:${input.sessionId}` });
  return {
    async record(input: Identity, now = new Date()) {
      if (!providerId) return;
      const current = await db.query.sessions.findFirst({
        where: (row, { and, eq, gt }) =>
          and(eq(row.id, input.sessionId), eq(row.userId, input.userId), gt(row.expiresAt, now)),
      });
      if (!current) return;
      await db
        .insert(authSchema.verification)
        .values({
          ...identity(key, input),
          value: `oidc:${providerId}`,
          createdAt: now,
          expiresAt: new Date(now.getTime() + 3600000),
        })
        .onConflictDoNothing();
    },
    async isFresh(input: Identity & { maxAgeSeconds: number }, now = new Date()): Promise<boolean> {
      if (
        !providerId ||
        !Number.isInteger(input.maxAgeSeconds) ||
        input.maxAgeSeconds < 60 ||
        input.maxAgeSeconds > 3600
      )
        return false;
      const credential = await db.query.accounts.findFirst({
        where: (row, { and, eq }) =>
          and(eq(row.userId, input.userId), eq(row.providerId, 'credential')),
      });
      if (credential?.password) return false;
      const provider = await db.query.accounts.findFirst({
        where: (row, { and, eq }) =>
          and(eq(row.userId, input.userId), eq(row.providerId, providerId)),
      });
      if (!provider) return false;
      const current = await db.query.sessions.findFirst({
        where: (row, { and, eq, gt }) =>
          and(eq(row.id, input.sessionId), eq(row.userId, input.userId), gt(row.expiresAt, now)),
      });
      if (!current) return false;
      const found = await db.query.verifications.findFirst({
        where: (row, { and, eq, gt }) =>
          and(eq(row.id, identity(key, input).id), gt(row.expiresAt, now)),
      });
      const age = found ? now.getTime() - found.createdAt.getTime() : -1;
      return found?.value === `oidc:${providerId}` && age >= 0 && age <= input.maxAgeSeconds * 1000;
    },
    prepareEnrollment: (input: Identity & { maxAgeSeconds: number }) =>
      fingerprint(input, new Date()),
    async recordEnrollment(
      input: Identity & { maxAgeSeconds: number },
      candidate: string,
    ): Promise<boolean> {
      const now = new Date();
      if ((await fingerprint(input, now)) !== candidate) return false;
      await db
        .insert(authSchema.verification)
        .values({
          ...enrollmentIdentity(input),
          value: candidate,
          createdAt: now,
          expiresAt: new Date(now.getTime() + 3600000),
        })
        .onConflictDoUpdate({
          target: authSchema.verification.id,
          set: { value: candidate, createdAt: now, expiresAt: new Date(now.getTime() + 3600000) },
        });
      return true;
    },
    async enrollmentCurrent(input: Identity & { maxAgeSeconds: number }): Promise<boolean> {
      const now = new Date(),
        candidate = await fingerprint(input, now);
      if (!candidate) return false;
      const found = await db.query.verifications.findFirst({
        where: (row, { and, eq, gt }) =>
          and(eq(row.id, enrollmentIdentity(input).id), gt(row.expiresAt, now)),
      });
      const age = found ? now.getTime() - found.createdAt.getTime() : -1;
      return found?.value === candidate && age >= 0 && age <= input.maxAgeSeconds * 1000;
    },
  };
}
export function primaryAuthenticationPlugin(
  providerId: string | undefined,
  record: (identity: Identity) => Promise<void>,
): BetterAuthPlugin {
  return {
    id: 'ensemus-primary-auth',
    hooks: {
      after: providerId
        ? [
            {
              matcher: (context) => context.path === '/callback/:id',
              handler: createAuthMiddleware(async (context) => {
                if (context.params?.id !== providerId) return;
                const current = context.context.newSession;
                if (current)
                  await record({ userId: current.user.id, sessionId: current.session.id });
              }),
            },
          ]
        : [],
    },
  };
}
