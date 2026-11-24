import {
  acceptGrantInvitation,
  confirmGrant,
  endGrant,
  getFederationSettings,
  getGrant,
  listGrants,
  noPlanGate,
  previewGrantInvitation,
  proposeGrant,
  setFederationEnabled,
} from '@ensemus/application';
import { createOrganization, openAppDatabase, type TenantContext } from '@ensemus/database';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { client, clearDeploymentProfile, setDeploymentProfile } from '../helpers/federation';
import { inFixtureTenant } from '../helpers/fixture-tenant';
import { makePerson, nativePersonContext, proveSecondFactor } from '../helpers/product';
import { urls } from '../helpers/stack';

describe('native federation consent and revocation', () => {
  type Database = ReturnType<typeof openAppDatabase>;
  let app: Database;
  let sql: Awaited<ReturnType<typeof client>>;
  const proposal = {
    purpose: 'document_review',
    maxClassification: 'internal',
    expiresInDays: 10,
    invitationExpiresInDays: 2,
    note: 'Generated review scope',
  } as const;

  async function person(organizationId?: string, role: 'owner' | 'admin' | 'member' = 'owner') {
    const fixture = await makePerson('federation-test');
    const id = fixture.userId;
    if (organizationId) {
      await inFixtureTenant(sql, organizationId, () =>
        sql.query(
          "insert into org.memberships (organization_id,user_id,role,status) values ($1,$2,$3,'active')",
          [organizationId, id, role],
        ),
      );
    } else {
      organizationId = (
        await createOrganization(app.db, {
          userId: id,
          name: 'Same name',
          commercialMode: 'sovereign',
        })
      ).organizationId;
    }
    const context = await nativePersonContext(app.db, fixture, organizationId);
    await proveSecondFactor(fixture);
    return context;
  }

  const enable = (person: TenantContext) =>
    setFederationEnabled(app.db, person, { enabled: true, expectedVersion: 0 }, noPlanGate);

  beforeAll(async () => {
    app = openAppDatabase(urls.app());
    sql = await client(urls.superuser());
  });
  beforeEach(() => setDeploymentProfile({ crossOrgEnabled: true }));
  afterEach(clearDeploymentProfile);
  afterAll(async () => {
    await app?.close();
    await sql?.end();
  });

  it('starts off, checks deployment, plan, role and version, and keeps same-version retries quiet', async () => {
    const owner = await person();
    const admin = await person(owner.organizationId, 'admin');
    const member = await person(owner.organizationId, 'member');
    expect(await getFederationSettings(app.db, owner)).toEqual({
      available: true,
      enabled: false,
      version: 0,
      changedAt: null,
    });
    await expect(enable(admin)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(getFederationSettings(app.db, member)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      setFederationEnabled(
        app.db,
        owner,
        { enabled: true, expectedVersion: 0 },
        {
          allows: async () => false,
        },
      ),
    ).rejects.toMatchObject({ code: 'ENTITLEMENT_DENIED' });
    await clearDeploymentProfile();
    await expect(enable(owner)).rejects.toMatchObject({ code: 'FEDERATION_NOT_AVAILABLE' });
    await setDeploymentProfile({ crossOrgEnabled: true });
    expect(await enable(owner)).toMatchObject({ enabled: true, version: 1 });
    await expect(enable(owner)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(
      await setFederationEnabled(app.db, owner, { enabled: true, expectedVersion: 1 }, noPlanGate),
    ).toMatchObject({ enabled: true, version: 1 });
    const { rows } = await sql.query(
      "select payload from platform.domain_events where organization_id=$1 and event_type='federation.settings_changed'",
      [owner.organizationId],
    );
    expect(rows).toEqual([{ payload: { enabled: true } }]);
  });

  it('binds all three consents to the exact terms, gives a token once, and lets an admin revoke', async () => {
    const sharing = await person();
    const receiving = await person();
    const outsider = await person();
    await enable(sharing);
    await enable(receiving);
    await enable(outsider);
    const { grant, token } = await proposeGrant(app.db, sharing, proposal);
    await expect(previewGrantInvitation(app.db, sharing, { token })).rejects.toMatchObject({
      code: 'FEDERATION_INVITATION_INVALID',
    });
    const preview = await previewGrantInvitation(app.db, receiving, { token });
    expect(preview).toMatchObject({ termsHash: grant.termsHash, sharingDisplayName: 'Same name' });
    expect(await listGrants(app.db, receiving)).toEqual([]);
    await expect(getGrant(app.db, outsider, grant.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      acceptGrantInvitation(app.db, receiving, { token, termsHash: '0'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'FEDERATION_TERMS_CHANGED' });
    const accepted = await acceptGrantInvitation(app.db, receiving, {
      token,
      termsHash: preview.termsHash,
    });
    expect(accepted).toMatchObject({ status: 'accepted', version: 2, role: 'receiving' });
    await expect(
      acceptGrantInvitation(app.db, outsider, { token, termsHash: preview.termsHash }),
    ).rejects.toMatchObject({ code: 'FEDERATION_INVITATION_INVALID' });
    const confirmation = { grantId: grant.id, termsHash: grant.termsHash, expectedVersion: 2 };
    await expect(confirmGrant(app.db, receiving, confirmation)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const active = await confirmGrant(app.db, sharing, confirmation);
    expect(active).toMatchObject({ status: 'active', version: 3, role: 'sharing' });
    expect(active.counterpartyFingerprint).not.toBe(preview.sharingFingerprint);
    const admin = await person(receiving.organizationId, 'admin');
    const ended = await endGrant(app.db, admin, {
      grantId: grant.id,
      reason: 'revoked',
      expectedVersion: 3,
    });
    expect(ended).toMatchObject({
      status: 'ended',
      version: 4,
      endReason: 'revoked',
      endedByUs: true,
    });
    const { rows } = await sql.query(
      "select payload from platform.domain_events where organization_id=$1 and aggregate_id=$2 and event_type='federation.grant_ended'",
      [receiving.organizationId, grant.id],
    );
    expect(rows).toEqual([{ payload: { reason: 'revoked' } }]);
    expect(JSON.stringify(await listGrants(app.db, sharing))).not.toContain(token);
  });

  it('serializes two recipients and records an ending for every open grant before switching off', async () => {
    const sharing = await person();
    const first = await person();
    const second = await person();
    for (const owner of [sharing, first, second]) await enable(owner);
    const { grant, token } = await proposeGrant(app.db, sharing, proposal);
    await proposeGrant(app.db, sharing, proposal);
    const results = await Promise.allSettled(
      [first, second].map((candidate) =>
        acceptGrantInvitation(app.db, candidate, { token, termsHash: grant.termsHash }),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'FEDERATION_INVITATION_INVALID' },
    });
    expect(
      await setFederationEnabled(
        app.db,
        sharing,
        { enabled: false, expectedVersion: 1 },
        noPlanGate,
      ),
    ).toMatchObject({ enabled: false, version: 2 });
    expect(await listGrants(app.db, sharing)).toMatchObject([
      { status: 'ended', endReason: 'disabled' },
      { status: 'ended', endReason: 'disabled' },
    ]);
    const { rows } = await sql.query(
      "select event_type from platform.domain_events where organization_id=$1 and event_type='federation.grant_ended'",
      [sharing.organizationId],
    );
    expect(rows).toHaveLength(2);
  });
});
