// Session creation/rotation/callback is not authentication time. Passwordless bootstrap needs an
// actual signed provider authentication timestamp; unknown time never falls back to callback time.
import { createHash, createHmac } from 'node:crypto';
import {
  authSchema,
  readSsoProvider,
  admitPrimaryReceipt,
  recordSsoAssurance,
  type openAuthDatabase,
  type SamlLinkPrimaryProof,
} from '@ensemus/database/auth';
import type { SsoCallbacks, VerifiedSsoIdentity } from './sso';
import { ssoBoundary, ssoIdpIssuer, trustedSamlProvider, type AcceptedSaml } from './sso-flow';
import type { AcceptedOidc, OidcTrust } from './oidc-primary';
import type { IdpBridgePayload, IdpBridgePrepared } from './idp-challenge';

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
  ssoCallbacks?: SsoCallbacks,
  currentOidcTrust?: () => Promise<OidcTrust | null>,
) {
  const active = async (input: Identity, now: Date) =>
    db.query.sessions.findFirst({
      where: (row, { and, eq, gt }) =>
        and(eq(row.id, input.sessionId), eq(row.userId, input.userId), gt(row.expiresAt, now)),
    });
  const samlIdentity = async (
    input: Identity,
    samlProviderId: string,
    boundary: string,
    accountId?: string,
    activeSessionId = input.sessionId,
  ): Promise<(VerifiedSsoIdentity & { userId: string; accountId: string }) | null> => {
    if (!ssoCallbacks || !(await active({ ...input, sessionId: activeSessionId }, new Date())))
      return null;
    const provider = await readSsoProvider(db, samlProviderId);
    if (
      !provider?.domainVerified ||
      !trustedSamlProvider(provider) ||
      ssoBoundary(provider) !== boundary
    )
      return null;
    const accounts = await db.query.accounts.findMany({
      where: (row, { and, eq }) =>
        and(eq(row.userId, input.userId), eq(row.providerId, samlProviderId)),
      limit: 2,
    });
    if (accounts.length !== 1 || (accountId && accounts[0]!.id !== accountId)) return null;
    const user = await db.query.users.findFirst({
      where: (row, { eq }) => eq(row.id, input.userId),
    });
    if (!user) return null;
    if (
      !/^[^\s@]+@[^\s@]+$/.test(user.email) ||
      user.email.slice(user.email.lastIndexOf('@') + 1).toLowerCase() !== provider.domain
    )
      return null;
    const issuer = ssoIdpIssuer(provider);
    if (!issuer) return null;
    return {
      providerId: samlProviderId,
      issuer,
      externalSubject: accounts[0]!.accountId,
      email: user.email,
      userId: input.userId,
      accountId: accounts[0]!.id,
    };
  };
  const readSaml = async (
    input: Identity,
    now: Date,
    activeSessionId = input.sessionId,
  ): Promise<
    | (VerifiedSsoIdentity & {
        userId: string;
        accountId: string;
        authenticatedAt: number | null;
        createdAt: Date;
        proofId: string;
      })
    | null
  > => {
    const proof = await db.query.verifications.findFirst({
      where: (row, { and, eq, gt }) =>
        and(eq(row.id, identity(key, input).id), gt(row.expiresAt, now)),
    });
    if (!proof || !proof.value.startsWith('saml:') || proof.createdAt.getTime() > now.getTime())
      return null;
    let marker: {
      providerId?: unknown;
      accountId?: unknown;
      boundary?: unknown;
      authenticatedAt?: unknown;
      bodySha256?: unknown;
    } | null;
    try {
      marker = JSON.parse(proof.value.slice(5)) as typeof marker;
    } catch {
      return null;
    }
    if (
      !marker ||
      typeof marker.providerId !== 'string' ||
      typeof marker.accountId !== 'string' ||
      typeof marker.boundary !== 'string' ||
      typeof marker.bodySha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(marker.bodySha256)
    )
      return null;
    if (
      marker.authenticatedAt !== null &&
      (typeof marker.authenticatedAt !== 'number' ||
        !Number.isFinite(marker.authenticatedAt) ||
        marker.authenticatedAt > now.getTime() + 60000)
    )
      return null;
    const current = await samlIdentity(
      input,
      marker.providerId,
      marker.boundary,
      marker.accountId,
      activeSessionId,
    );
    return current
      ? {
          ...current,
          authenticatedAt: marker.authenticatedAt as number | null,
          createdAt: proof.createdAt,
          proofId: proof.id,
        }
      : null;
  };
  const readOidc = async (
    input: Identity,
    now: Date,
    activeSessionId = input.sessionId,
  ): Promise<{ accountId: string; authenticatedAt: number; proofId: string } | null> => {
    if (
      !providerId ||
      !currentOidcTrust ||
      !(await active({ ...input, sessionId: activeSessionId }, now))
    )
      return null;
    const proof = await db.query.verifications.findFirst({
      where: (row, { and, eq, gt }) =>
        and(eq(row.id, identity(key, input).id), gt(row.expiresAt, now)),
    });
    if (!proof || !proof.value.startsWith('oidc:')) return null;
    const trust = await currentOidcTrust();
    if (!trust || trust.providerId !== providerId) return null;
    let marker: Record<string, unknown> | null;
    try {
      marker = JSON.parse(proof.value.slice(5)) as Record<string, unknown> | null;
    } catch {
      return null;
    }
    if (
      !marker ||
      marker.providerId !== providerId ||
      marker.issuer !== trust.issuer ||
      marker.sourceConfigSha256 !== trust.sourceConfigSha256 ||
      typeof marker.accountId !== 'string' ||
      typeof marker.subjectSha256 !== 'string' ||
      typeof marker.tokenSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(marker.tokenSha256) ||
      typeof marker.authenticatedAt !== 'number' ||
      !Number.isFinite(marker.authenticatedAt) ||
      marker.authenticatedAt > now.getTime() + 60000
    )
      return null;
    const account = await db.query.accounts.findFirst({
      where: (row, { and, eq }) =>
        and(
          eq(row.id, marker!.accountId as string),
          eq(row.userId, input.userId),
          eq(row.providerId, providerId),
        ),
    });
    if (!account) return null;
    const subjectSha256 = createHash('sha256')
      .update(JSON.stringify([providerId, trust.issuer, account.accountId]))
      .digest('hex');
    if (subjectSha256 !== marker.subjectSha256) return null;
    return { accountId: account.id, authenticatedAt: marker.authenticatedAt, proofId: proof.id };
  };
  const fingerprint = async (
    input: Identity & { maxAgeSeconds: number },
    now: Date,
    activeSessionId = input.sessionId,
  ): Promise<string | null> => {
    if (
      !(await active({ ...input, sessionId: activeSessionId }, now)) ||
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
      const saml = await readSaml(input, now, activeSessionId);
      if (saml) {
        const age = saml.authenticatedAt === null ? -1 : now.getTime() - saml.authenticatedAt;
        if (
          age < 0 ||
          age > input.maxAgeSeconds * 1000 ||
          !(await ssoCallbacks?.currentPrimary(saml))
        )
          return null;
        binding = ['saml', saml.accountId, saml.proofId, saml.authenticatedAt];
      } else {
        const oidc = await readOidc(input, now, activeSessionId);
        if (!oidc) return null;
        const age = now.getTime() - oidc.authenticatedAt;
        if (age < 0 || age > input.maxAgeSeconds * 1000) return null;
        binding = ['oidc', oidc.accountId, oidc.proofId, oidc.authenticatedAt];
      }
    }
    return createHmac('sha256', key)
      .update(JSON.stringify(['ensemus-enrollment-binding:v1', binding]))
      .digest('hex');
  };
  const enrollmentIdentity = (input: Identity) =>
    identity(key, { userId: input.userId, sessionId: `enrollment:${input.sessionId}` });
  const operations = {
    async selfLinkProviderCurrent(value: string): Promise<boolean> {
      if (value.startsWith('saml:')) return true; //0421 rechecks the actual pinned source-provider row.
      if (!value.startsWith('oidc:') || !currentOidcTrust) return false;
      try {
        const marker = JSON.parse(value.slice(5)) as Record<string, unknown>,
          trust = await currentOidcTrust();
        return Boolean(
          trust &&
          marker.providerId === trust.providerId &&
          marker.issuer === trust.issuer &&
          marker.sourceConfigSha256 === trust.sourceConfigSha256,
        );
      } catch {
        return false;
      }
    },
    /** A real current signed primary receipt for passwordless explicit self-link preparation. */
    async selfLinkProof(input: Identity, now = new Date()): Promise<SamlLinkPrimaryProof | null> {
      if (!(await fingerprint({ ...input, maxAgeSeconds: 300 }, now))) return null;
      const saml = await readSaml(input, now),
        current = saml ?? (await readOidc(input, now));
      if (!current || current.authenticatedAt === null) return null;
      const proof = await db.query.verifications.findFirst({
        where: (row, { eq }) => eq(row.id, current.proofId),
      });
      const sourceProvider = saml ? await readSsoProvider(db, saml.providerId) : null;
      if (saml && !sourceProvider?.samlConfig) return null;
      return proof
        ? {
            kind: 'provider' as const,
            accountId: current.accountId,
            proofId: current.proofId,
            fingerprint: createHash('sha256').update(proof.value).digest('hex'),
            authenticatedAt: current.authenticatedAt,
            providerId: saml?.providerId ?? providerId!,
            rawConfigSha256: sourceProvider?.samlConfig
              ? createHash('sha256').update(sourceProvider.samlConfig).digest('hex')
              : null,
          }
        : null;
    },
    async recordSaml(
      input: AcceptedSaml & { sessionId: string },
      now = new Date(),
      consumeBridge?: { id: string; value: string },
    ): Promise<boolean> {
      if (
        input.authenticatedAt !== null &&
        (!Number.isFinite(input.authenticatedAt) || input.authenticatedAt > now.getTime() + 60000)
      )
        return false;
      const current = await samlIdentity(input, input.providerId, input.boundary);
      if (
        !current ||
        current.issuer !== input.issuer ||
        current.externalSubject !== input.externalSubject ||
        current.email.toLowerCase() !== input.email.toLowerCase()
      )
        return false;
      if (
        !(await admitPrimaryReceipt(db, {
          kind: 'saml',
          ...input,
          subject: input.externalSubject,
          accountId: current.accountId,
          expectedSamlSha256: input.boundary,
          ...(consumeBridge ? { consumeBridge } : {}),
          receipt: {
            ...identity(key, input),
            value: `saml:${JSON.stringify({ providerId: input.providerId, accountId: current.accountId, boundary: input.boundary, authenticatedAt: input.authenticatedAt, bodySha256: input.bodySha256 })}`,
            createdAt: now,
            expiresAt: new Date(now.getTime() + 3600000),
          },
        }))
      )
        return false;
      return (await readSaml(input, now)) !== null;
    },
    async verifiedSaml(
      input: Identity,
    ): Promise<(VerifiedSsoIdentity & { userId: string }) | null> {
      const current = await readSaml(input, new Date());
      return current
        ? {
            providerId: current.providerId,
            issuer: current.issuer,
            externalSubject: current.externalSubject,
            email: current.email,
            userId: current.userId,
          }
        : null;
    },
    async recordOidc(
      input: AcceptedOidc & Identity,
      now = new Date(),
      consumeBridge?: { id: string; value: string },
    ): Promise<boolean> {
      if (
        !providerId ||
        input.providerId !== providerId ||
        !currentOidcTrust ||
        input.authenticatedAt === null ||
        !Number.isFinite(input.authenticatedAt) ||
        input.authenticatedAt > now.getTime() + 60000 ||
        !/^[0-9a-f]{64}$/.test(input.tokenSha256)
      )
        return false;
      const trust = await currentOidcTrust();
      if (
        !trust ||
        trust.providerId !== providerId ||
        trust.issuer !== input.issuer ||
        trust.sourceConfigSha256 !== input.sourceConfigSha256
      )
        return false;
      const accounts = await db.query.accounts.findMany({
        where: (row, { and, eq }) =>
          and(eq(row.userId, input.userId), eq(row.providerId, providerId)),
        limit: 2,
      });
      if (accounts.length !== 1 || accounts[0]!.accountId !== input.subject) return false;
      const accountId = accounts[0]!.id,
        subjectSha256 = createHash('sha256')
          .update(JSON.stringify([providerId, input.issuer, input.subject]))
          .digest('hex');
      if (
        !(await admitPrimaryReceipt(db, {
          kind: 'oidc',
          ...input,
          accountId,
          ...(consumeBridge ? { consumeBridge } : {}),
          receipt: {
            ...identity(key, input),
            value: `oidc:${JSON.stringify({ providerId, issuer: input.issuer, sourceConfigSha256: input.sourceConfigSha256, accountId, subjectSha256, tokenSha256: input.tokenSha256, authenticatedAt: input.authenticatedAt })}`,
            createdAt: now,
            expiresAt: new Date(now.getTime() + 3600000),
          },
        }))
      )
        return false;
      return (await readOidc(input, now)) !== null;
    },
    async isFresh(input: Identity & { maxAgeSeconds: number }, now = new Date()): Promise<boolean> {
      const credential = await db.query.accounts.findFirst({
        where: (row, { and, eq }) =>
          and(eq(row.userId, input.userId), eq(row.providerId, 'credential')),
      });
      if (credential?.password) return false;
      return (await fingerprint(input, now)) !== null;
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
    async enrollmentCurrentAfterRotation(
      input: Identity & { resultingSessionId: string; maxAgeSeconds: number },
    ): Promise<boolean> {
      const now = new Date(),
        candidate = await fingerprint(input, now, input.resultingSessionId);
      if (!candidate) return false;
      const found = await db.query.verifications.findFirst({
        where: (row, { and, eq, gt }) =>
          and(eq(row.id, enrollmentIdentity(input).id), gt(row.expiresAt, now)),
      });
      const age = found ? now.getTime() - found.createdAt.getTime() : -1;
      return found?.value === candidate && age >= 0 && age <= input.maxAgeSeconds * 1000;
    },
    async prepareIdpChallenge(
      input: Identity,
      candidate: (AcceptedSaml & { kind: 'saml' }) | (AcceptedOidc & { kind: 'oidc' }),
    ): Promise<IdpBridgePrepared | null> {
      if (!(await active(input, new Date()))) return null;
      let accountId: string, subject: string, sourceSha256: string, payloadSha256: string;
      if (candidate.kind === 'saml') {
        if (candidate.userId !== input.userId) return null;
        const current = await samlIdentity(input, candidate.providerId, candidate.boundary);
        if (
          !current ||
          current.issuer !== candidate.issuer ||
          current.externalSubject !== candidate.externalSubject ||
          !(await ssoCallbacks?.authorizeIdentity(current))
        )
          return null;
        accountId = current.accountId;
        subject = current.externalSubject;
        sourceSha256 = candidate.boundary;
        payloadSha256 = candidate.bodySha256;
      } else {
        const trust = await currentOidcTrust?.();
        if (
          !trust ||
          trust.providerId !== candidate.providerId ||
          trust.issuer !== candidate.issuer ||
          trust.sourceConfigSha256 !== candidate.sourceConfigSha256
        )
          return null;
        const accounts = await db.query.accounts.findMany({
          where: (row, { and, eq }) =>
            and(eq(row.userId, input.userId), eq(row.providerId, candidate.providerId)),
          limit: 2,
        });
        if (accounts.length !== 1 || accounts[0]!.accountId !== candidate.subject) return null;
        accountId = accounts[0]!.id;
        subject = accounts[0]!.accountId;
        sourceSha256 = candidate.sourceConfigSha256;
        payloadSha256 = candidate.tokenSha256;
      }
      const subjectSha256 = createHash('sha256')
        .update(JSON.stringify([candidate.providerId, candidate.issuer, subject]))
        .digest('hex');
      return {
        payload: {
          version: 1,
          kind: candidate.kind,
          userId: input.userId,
          sourceSessionId: input.sessionId,
          providerId: candidate.providerId,
          issuer: candidate.issuer,
          accountId,
          subjectSha256,
          sourceSha256,
          payloadSha256,
          authenticatedAt: candidate.authenticatedAt,
        },
        subject,
      };
    },
    async finishIdpChallenge(input: {
      payload: IdpBridgePayload;
      consume: { id: string; value: string };
      sessionId: string;
      userId: string;
    }): Promise<boolean> {
      const { payload } = input;
      if (payload.userId !== input.userId || !(await active(input, new Date()))) return false;
      const account = await db.query.accounts.findFirst({
        where: (row, { and, eq }) =>
          and(
            eq(row.id, payload.accountId),
            eq(row.userId, input.userId),
            eq(row.providerId, payload.providerId),
          ),
      });
      if (
        !account ||
        createHash('sha256')
          .update(JSON.stringify([payload.providerId, payload.issuer, account.accountId]))
          .digest('hex') !== payload.subjectSha256
      )
        return false;
      if (payload.kind === 'saml') {
        const current = await samlIdentity(
          input,
          payload.providerId,
          payload.sourceSha256,
          payload.accountId,
        );
        if (!current || current.issuer !== payload.issuer || !ssoCallbacks) return false;
        if ((await ssoCallbacks.completeIdentity(current)) === 'refused') return false;
        if (
          !(await operations.recordSaml(
            {
              ...current,
              sessionId: input.sessionId,
              boundary: payload.sourceSha256,
              bodySha256: payload.payloadSha256,
              authenticatedAt: payload.authenticatedAt,
            },
            new Date(),
            input.consume,
          ))
        )
          return false;
        if (await ssoCallbacks.currentPrimary(current))
          return recordSsoAssurance(db, {
            ...input,
            providerId: payload.providerId,
            externalSubject: current.externalSubject,
            expectedSha256: payload.sourceSha256,
          });
        return true;
      }
      const trust = await currentOidcTrust?.();
      if (
        !trust ||
        trust.providerId !== payload.providerId ||
        trust.issuer !== payload.issuer ||
        trust.sourceConfigSha256 !== payload.sourceSha256
      )
        return false;
      if (payload.authenticatedAt === null)
        return admitPrimaryReceipt(db, {
          kind: 'oidc',
          userId: input.userId,
          sessionId: input.sessionId,
          providerId: payload.providerId,
          subject: account.accountId,
          accountId: account.id,
          consumeBridge: input.consume,
        });
      return operations.recordOidc(
        {
          ...trust,
          subject: account.accountId,
          tokenSha256: payload.payloadSha256,
          authenticatedAt: payload.authenticatedAt,
          userId: input.userId,
          sessionId: input.sessionId,
        },
        new Date(),
        input.consume,
      );
    },
  };
  return operations;
}
