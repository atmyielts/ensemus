// ADR-029 D2 addendum, question 4, migration 0712. Real roles, generated people and domains. Written in the
// rc-know builder without a database: it runs in the integration project once the stack is available.
// A provider's share with a whole domain reaches only active members with a verified email in a domain this
// organization verified, while the organization has turned the setting on; never another tenant's people,
// never "anyone with the link", and never a confidential or restricted source.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getDomainGrantSetting,
  setDomainGrantSetting,
} from '@ensemus/application/knowledge/domain-grants';
import { listStaleConnectorResources } from '@ensemus/application/knowledge/ingest';
import { searchLexical } from '@ensemus/application/knowledge/retrieval';
import { assertRecentMfa } from '@ensemus/application/privileged';
import {
  connections,
  externalResourceAcl,
  externalResources,
  knowledgeChunks,
  knowledgeDocuments,
  knowledgeSources,
  openAppDatabase,
  withTenantTx,
} from '@ensemus/database';
import { ssoConnections } from '@ensemus/database/product';
import { createServiceContext } from '@ensemus/database/service';
import type { Classification } from '@ensemus/domain/policy';
import { eq } from 'drizzle-orm';
import { inFixtureTenant } from '../helpers/fixture-tenant';
import { knowledgeCanary, sha256 } from '../helpers/knowledge';
import { makeTwoTenants, proveSecondFactor, type TestPerson } from '../helpers/product';
import { urls } from '../helpers/stack';

describe('verified domain grants', () => {
  let database: ReturnType<typeof openAppDatabase>;
  let tenants: Awaited<ReturnType<typeof makeTwoTenants>>;
  let su: pg.Client;
  const domain = `${randomUUID()}.example.invalid`;
  // Tenant A verified the domain; tenant B has people at the same domain and claims it, unverified.
  let atDomain: TestPerson;
  let unverifiedEmail: TestPerson;
  let elsewhere: TestPerson;
  let otherTenantAtDomain: TestPerson;

  const setEmail = (person: TestPerson, email: string, verified: boolean) =>
    su.query('update identity.users set email = $2, email_verified = $3 where id = $1', [
      person.userId,
      email,
      verified,
    ]);

  const claimDomain = async (owner: TestPerson, verify: boolean) => {
    const id = randomUUID();
    await proveSecondFactor(owner);
    await withTenantTx(database.db, owner.context, async (tx) => {
      await assertRecentMfa(tx, owner.context, 'sso.manage', { sessionId: owner.sessionId });
      await tx.insert(ssoConnections).values({
        organizationId: owner.context.organizationId,
        id,
        providerId: `saml-${id}`,
        displayName: 'Generated provider',
        domain,
        createdByMembershipId: owner.context.membershipId,
      });
    });
    if (verify)
      await inFixtureTenant(su, owner.context.organizationId, () =>
        su.query(`update org.sso_connections set domain_state = 'verified' where id = $1`, [id]),
      );
  };

  const turn = async (owner: TestPerson, enabled: boolean) => {
    await proveSecondFactor(owner);
    const current = await getDomainGrantSetting(database.db, owner.context);
    return setDomainGrantSetting(
      database.db,
      owner.context,
      { sessionId: owner.sessionId },
      { enabled, expectedVersion: current.version },
    );
  };

  /** A connector's searchable source whose only provider grant is the given domain-wide share. */
  async function domainShared(
    owner: TestPerson,
    word: string,
    grant: { kind: 'domain' | 'anyone'; id: string },
    classification: Classification = 'internal',
  ) {
    const organizationId = owner.context.organizationId;
    const connectionId = randomUUID(),
      resourceId = randomUUID(),
      sourceId = randomUUID(),
      documentId = randomUUID();
    await withTenantTx(database.db, owner.context, async (tx) => {
      await tx.insert(connections).values({
        organizationId,
        id: connectionId,
        connectorType: 'google_workspace',
        displayName: 'Generated drive',
      });
      // M3 maps a domain-only share to nobody, so the resource is `unmapped`.
      await tx.insert(externalResources).values({
        organizationId,
        id: resourceId,
        connectionId,
        stream: 'drive_files',
        resourceType: 'file',
        externalId: resourceId,
        aclState: 'unmapped',
        classification,
      });
      await tx.insert(externalResourceAcl).values({
        organizationId,
        resourceId,
        principalKind: grant.kind,
        // Providers report a domain as they like; the rule compares it in lower case.
        principalExternalId: grant.id.toUpperCase(),
        access: 'read',
        membershipId: null,
        teamId: null,
      });
    });
    const service = createServiceContext(organizationId);
    await withTenantTx(database.db, service, async (tx) => {
      await tx.insert(knowledgeSources).values({
        organizationId,
        id: sourceId,
        kind: 'connector',
        connectionId,
        externalResourceId: resourceId,
        classification,
      });
      await tx.insert(knowledgeDocuments).values({
        organizationId,
        id: documentId,
        sourceId,
        versionNo: 1,
        title: word,
        contentSha256: sha256(word),
        sizeBytes: word.length,
        mediaType: 'text/plain',
        classification,
      });
    });
    await withTenantTx(database.db, service, async (tx) => {
      await tx
        .update(knowledgeDocuments)
        .set({ state: 'parsing' })
        .where(eq(knowledgeDocuments.id, documentId));
      await tx.insert(knowledgeChunks).values({
        organizationId,
        documentId,
        sourceId,
        ordinal: 0,
        textBody: word,
        contentSha256: sha256(word),
        tokenEstimate: Math.ceil(word.length / 4),
        charStart: 0,
        charEnd: word.length,
      });
      await tx
        .update(knowledgeDocuments)
        .set({ state: 'searchable', searchableAt: new Date() })
        .where(eq(knowledgeDocuments.id, documentId));
    });
    return { sourceId, resourceId };
  }

  const reads = async (person: TestPerson, word: string) =>
    (await searchLexical(database.db, person.context, { query: word })).map((hit) => hit.sourceId);

  beforeAll(async () => {
    database = openAppDatabase(urls.app(), { max: 2 });
    su = new pg.Client({ connectionString: urls.superuser() });
    await su.connect();
    tenants = await makeTwoTenants(database.db);
    atDomain = tenants.a.member;
    unverifiedEmail = tenants.a.admin;
    elsewhere = tenants.a.owner;
    otherTenantAtDomain = tenants.b.member;
    await setEmail(atDomain, `member-${randomUUID()}@${domain}`, true);
    // At the domain, in another case, but the address itself was never proven, so it reaches nothing.
    await setEmail(unverifiedEmail, `admin-${randomUUID()}@${domain.toUpperCase()}`, false);
    await setEmail(elsewhere, `owner-${randomUUID()}@other-${domain}`, true);
    await setEmail(otherTenantAtDomain, `b-${randomUUID()}@${domain}`, true);
    await claimDomain(tenants.a.owner, true);
    await claimDomain(tenants.b.owner, false);
  });
  afterAll(async () => {
    await su?.end();
    await database?.close();
  });

  it('maps nothing by default, so a domain share still reads as nobody', async () => {
    const word = knowledgeCanary();
    await domainShared(tenants.a.owner, word, { kind: 'domain', id: domain });
    expect(await getDomainGrantSetting(database.db, atDomain.context)).toEqual({
      enabled: false,
      version: 1,
    });
    expect(await reads(atDomain, word)).toEqual([]);
  });

  it('reaches only verified addresses in the verified domain, and stops in the commit that turns it off', async () => {
    const word = knowledgeCanary();
    const shared = await domainShared(tenants.a.owner, word, { kind: 'domain', id: domain });
    const on = await turn(tenants.a.owner, true);
    expect(on.enabled).toBe(true);
    expect(await reads(atDomain, word)).toEqual([shared.sourceId]);
    expect(await reads(unverifiedEmail, word)).toEqual([]);
    expect(await reads(elsewhere, word)).toEqual([]);
    expect(await reads(otherTenantAtDomain, word)).toEqual([]);
    // A disabled member at the domain reads nothing.
    await inFixtureTenant(su, tenants.a.organizationId, () =>
      su.query(`update org.memberships set status = 'disabled' where id = $1`, [
        atDomain.context.membershipId,
      ]),
    );
    expect(await reads(atDomain, word).catch(() => [])).toEqual([]);
    await inFixtureTenant(su, tenants.a.organizationId, () =>
      su.query(`update org.memberships set status = 'active' where id = $1`, [
        atDomain.context.membershipId,
      ]),
    );
    await turn(tenants.a.owner, false);
    expect(await reads(atDomain, word)).toEqual([]);
    await turn(tenants.a.owner, true);
  });

  it('never maps anyone-with-the-link, a subdomain, or a confidential source', async () => {
    await turn(tenants.a.owner, true);
    const link = knowledgeCanary();
    await domainShared(tenants.a.owner, link, { kind: 'anyone', id: 'anyoneWithLink' });
    const sub = knowledgeCanary();
    await domainShared(tenants.a.owner, sub, { kind: 'domain', id: `sub.${domain}` });
    const secret = knowledgeCanary();
    await domainShared(tenants.a.owner, secret, { kind: 'domain', id: domain }, 'confidential');
    for (const word of [link, sub, secret]) expect(await reads(atDomain, word)).toEqual([]);
  });

  it('gives another tenant with the same domain nothing, even with its own setting on', async () => {
    await turn(tenants.b.owner, true);
    const word = knowledgeCanary();
    await domainShared(tenants.b.owner, word, { kind: 'domain', id: domain });
    // B claimed the domain but never verified it, and A's verification is A's alone.
    expect(await reads(otherTenantAtDomain, word)).toEqual([]);
    expect(await reads(atDomain, word)).toEqual([]);
  });

  it('lets the sweep fetch a domain-shared resource only while the mapping applies', async () => {
    const service = createServiceContext(tenants.a.organizationId);
    await turn(tenants.a.owner, false);
    const word = knowledgeCanary();
    const shared = await domainShared(tenants.a.owner, word, { kind: 'domain', id: domain });
    const stale = async () =>
      (await listStaleConnectorResources(database.db, service, { limit: 100 })).map(
        (row) => row.externalResourceId,
      );
    // It already has a document at its version, so it is never stale; the sweep's filter is what is
    // checked here, through a resource with no document yet.
    expect(await stale()).not.toContain(shared.resourceId);
    const fresh = randomUUID();
    await withTenantTx(database.db, tenants.a.owner.context, async (tx) => {
      const [first] = await tx
        .select({ connectionId: externalResources.connectionId })
        .from(externalResources)
        .where(eq(externalResources.id, shared.resourceId));
      await tx.insert(externalResources).values({
        organizationId: tenants.a.organizationId,
        id: fresh,
        connectionId: first!.connectionId,
        stream: 'drive_files',
        resourceType: 'file',
        externalId: fresh,
        aclState: 'unmapped',
        classification: 'internal',
      });
      await tx.insert(externalResourceAcl).values({
        organizationId: tenants.a.organizationId,
        resourceId: fresh,
        principalKind: 'domain',
        principalExternalId: domain,
        access: 'read',
      });
    });
    expect(await stale()).not.toContain(fresh);
    await turn(tenants.a.owner, true);
    expect(await stale()).toContain(fresh);
  });

  it('needs security policy rights and a recent second factor to change', async () => {
    const current = await getDomainGrantSetting(database.db, atDomain.context);
    await expect(
      setDomainGrantSetting(
        database.db,
        atDomain.context,
        { sessionId: atDomain.sessionId },
        { enabled: true, expectedVersion: current.version },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const owner = tenants.a.owner;
    const ownerCurrent = await getDomainGrantSetting(database.db, owner.context);
    await expect(
      setDomainGrantSetting(database.db, owner.context, null, {
        enabled: !ownerCurrent.enabled,
        expectedVersion: ownerCurrent.version,
      }),
    ).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
    await proveSecondFactor(owner);
    await expect(
      setDomainGrantSetting(
        database.db,
        owner.context,
        { sessionId: owner.sessionId },
        { enabled: !ownerCurrent.enabled, expectedVersion: ownerCurrent.version + 5 },
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });
});
