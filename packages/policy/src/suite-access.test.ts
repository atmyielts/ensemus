// ADR-038 D5 and D6's connection rule, as a pure function. Every refusal the gateway, the connector
// worker's recheck and M3's intent path rely on is here, with a fixed code.
import {
  SUITE_CONNECTION_RULES,
  toolManifest,
  type ConnectionRule,
} from '@ensemus/domain/ai-tools';
import { describe, expect, it } from 'vitest';
import {
  changeNeedsApproval,
  decideConnectionUse,
  recheckSuiteSend,
  resourceIdOf,
  type ConnectionUseInput,
  type SuiteSendRecheckInput,
} from './suite-access';

const ME = '6f1c2c6e-1111-4111-8111-111111111111';
const SOMEONE_ELSE = '6f1c2c6e-2222-4222-8222-222222222222';
const google = (scope: string) => `https://www.googleapis.com/auth/${scope}`;

const decide = (over: Partial<ConnectionUseInput> & { rule: ConnectionRule }) =>
  decideConnectionUse({
    toolClass: 'read_only',
    initiatorMembershipId: ME,
    dataClass: 'internal',
    connection: null,
    resource: null,
    ...over,
  });

const mine = (scopes: string[], type = 'google_workspace') => ({
  state: 'active',
  connectorType: type,
  ownerMembershipId: ME,
  grantedScopes: scopes,
});
const organizations = (scopes: string[], type = 'google_workspace') => ({
  ...mine(scopes, type),
  ownerMembershipId: null,
});

describe('a member’s own connection', () => {
  const rule = SUITE_CONNECTION_RULES['gmail.send'];

  it('may be used by its owner with the tool’s scopes', () => {
    expect(
      decide({ rule, toolClass: 'external_write', connection: mine([google('gmail.send')]) }),
    ).toMatchObject({ ok: true, ownerKind: 'member', checkEachResult: false });
  });

  it('is never another member’s to use, whatever else holds', () => {
    expect(
      decide({
        rule,
        toolClass: 'external_write',
        connection: { ...mine([google('gmail.send')]), ownerMembershipId: SOMEONE_ELSE },
      }),
    ).toEqual({ ok: false, code: 'CONNECTION_NOT_YOURS', auditAs: 'CONNECTION_NOT_YOURS' });
  });

  it('compares IDs without regard to case', () => {
    expect(
      decide({
        rule,
        toolClass: 'external_write',
        initiatorMembershipId: ME.toUpperCase(),
        connection: mine([google('gmail.send')]),
      }),
    ).toMatchObject({ ok: true });
  });
});

describe('refusals, each with its own code', () => {
  it('refuses a missing scope', () => {
    expect(
      decide({
        rule: SUITE_CONNECTION_RULES['gmail.send'],
        toolClass: 'external_write',
        connection: mine([google('gmail.readonly')]),
      }),
    ).toMatchObject({ ok: false, code: 'SCOPE_NOT_GRANTED' });
  });

  it('refuses a connection of a type the tool does not list', () => {
    expect(
      decide({
        rule: SUITE_CONNECTION_RULES['gmail.search'],
        connection: mine(['Mail.ReadWrite'], 'microsoft_365'),
      }),
    ).toMatchObject({ ok: false, code: 'CONNECTION_TYPE_MISMATCH' });
    expect(
      decide({
        rule: toolManifest('email.send')!.connection!,
        toolClass: 'external_write',
        connection: organizations([google('gmail.send')]),
      }),
    ).toMatchObject({ ok: false, code: 'CONNECTION_TYPE_MISMATCH' });
  });

  it('refuses the organization’s connection for a tool only a member’s own may use', () => {
    expect(
      decide({
        rule: SUITE_CONNECTION_RULES['gmail.search'],
        connection: organizations([google('gmail.readonly')]),
      }),
    ).toMatchObject({ ok: false, code: 'CONNECTION_NOT_YOURS' });
  });

  it('refuses a member’s own connection for a tool only the organization’s may use', () => {
    expect(
      decide({
        rule: SUITE_CONNECTION_RULES['drive.search'],
        connection: mine([google('drive.metadata.readonly')]),
      }),
    ).toMatchObject({ ok: false, code: 'CONNECTION_NOT_YOURS' });
  });

  it('refuses a connection that is missing, disabled or revoked', () => {
    const rule = SUITE_CONNECTION_RULES['gmail.search'];
    expect(decide({ rule, connection: null })).toMatchObject({
      ok: false,
      code: 'RESOURCE_NOT_PERMITTED',
      auditAs: 'CONNECTION_NOT_FOUND',
    });
    for (const state of ['disabled', 'revoked']) {
      expect(
        decide({ rule, connection: { ...mine([google('gmail.readonly')]), state } }),
      ).toMatchObject({ ok: false, auditAs: 'CONNECTION_NOT_ACTIVE' });
    }
  });

  it('refuses restricted data leaving by an external write or a draft, and lets a read go on', () => {
    for (const [id, toolClass, scope] of [
      ['gmail.send', 'external_write', 'gmail.send'],
      ['gmail.create_draft', 'draft_only', 'gmail.compose'],
    ] as const) {
      expect(
        decide({
          rule: SUITE_CONNECTION_RULES[id],
          toolClass,
          dataClass: 'restricted',
          connection: mine([google(scope)]),
        }),
      ).toMatchObject({ ok: false, code: 'CLASS_DENIED' });
    }
    expect(
      decide({
        rule: SUITE_CONNECTION_RULES['gmail.search'],
        dataClass: 'restricted',
        connection: mine([google('gmail.readonly')]),
      }),
    ).toMatchObject({ ok: true });
  });
});

describe('the organization’s content, through the source’s own ACL', () => {
  const docs = [google('documents')];

  it('refuses a document that never synced, or synced without a mapped ACL', () => {
    for (const resource of [null, { synced: false, access: ['owner' as const] }]) {
      expect(
        decide({
          rule: SUITE_CONNECTION_RULES['docs.read'],
          connection: organizations(docs),
          resource,
        }),
      ).toMatchObject({
        ok: false,
        code: 'RESOURCE_NOT_PERMITTED',
        auditAs: 'RESOURCE_NOT_SYNCED',
      });
    }
  });

  it('refuses a document whose source ACL does not grant the initiator what the tool needs', () => {
    expect(
      decide({
        rule: SUITE_CONNECTION_RULES['docs.read'],
        connection: organizations(docs),
        resource: { synced: true, access: [] },
      }),
    ).toMatchObject({ ok: false, auditAs: 'SOURCE_ACL_DENIED' });
    expect(
      decide({
        rule: SUITE_CONNECTION_RULES['docs.edit'],
        toolClass: 'external_write',
        connection: organizations(docs),
        resource: { synced: true, access: ['read'] },
      }),
    ).toMatchObject({ ok: false, auditAs: 'SOURCE_ACL_DENIED' });
  });

  it('allows what the source grants, and a writer may also read', () => {
    expect(
      decide({
        rule: SUITE_CONNECTION_RULES['docs.read'],
        connection: organizations(docs),
        resource: { synced: true, access: ['write'] },
      }),
    ).toMatchObject({ ok: true, ownerKind: 'organization', checkEachResult: false });
    expect(
      decide({
        rule: SUITE_CONNECTION_RULES['docs.edit'],
        toolClass: 'external_write',
        connection: organizations(docs),
        resource: { synced: true, access: ['owner'] },
      }),
    ).toMatchObject({ ok: true });
  });

  it('skips the ACL on the initiator’s own account, which is theirs', () => {
    expect(
      decide({
        rule: SUITE_CONNECTION_RULES['docs.read'],
        connection: mine(docs),
        resource: null,
      }),
    ).toMatchObject({ ok: true, ownerKind: 'member' });
  });

  it('has a search check each result, since it names no one resource', () => {
    expect(
      decide({
        rule: SUITE_CONNECTION_RULES['drive.search'],
        connection: organizations([google('drive.metadata.readonly')]),
      }),
    ).toMatchObject({ ok: true, checkEachResult: true });
  });

  it('reads the named resource from the argument the rule names, and nothing else', () => {
    expect(
      resourceIdOf(SUITE_CONNECTION_RULES['docs.read'], { document_id: 'd', other: 'x' }),
    ).toBe('d');
    expect(resourceIdOf(SUITE_CONNECTION_RULES['drive.search'], { query: 'q' })).toBeNull();
    expect(resourceIdOf(SUITE_CONNECTION_RULES['docs.read'], { document_id: 3 })).toBeNull();
  });

  it('names a Microsoft drive item as the drive sync keys it, and nothing without both parts', () => {
    for (const tool of ['word.read', 'excel.read_range', 'excel.write_range'] as const) {
      expect(
        resourceIdOf(SUITE_CONNECTION_RULES[tool], { drive_id: 'b!drv', item_id: '01ITEM' }),
        tool,
      ).toBe(JSON.stringify(['b!drv', '01ITEM']));
      expect(resourceIdOf(SUITE_CONNECTION_RULES[tool], { item_id: '01ITEM' }), tool).toBeNull();
      expect(resourceIdOf(SUITE_CONNECTION_RULES[tool], { drive_id: 'b!drv' }), tool).toBeNull();
    }
    for (const [tool, arg] of [
      ['docs.read', 'document_id'],
      ['docs.edit', 'document_id'],
      ['sheets.read_range', 'spreadsheet_id'],
      ['sheets.write_range', 'spreadsheet_id'],
    ] as const) {
      expect(resourceIdOf(SUITE_CONNECTION_RULES[tool], { [arg]: '1AbC_d-E' }), tool).toBe(
        '1AbC_d-E',
      );
    }
  });
});

describe('who is asked', () => {
  it('asks a person for every external write, and nobody for a draft', () => {
    expect(changeNeedsApproval({ class: 'external_write', requiresApproval: false })).toBe(true);
    expect(changeNeedsApproval(toolManifest('gmail.send')!)).toBe(true);
    expect(changeNeedsApproval(toolManifest('gmail.create_draft')!)).toBe(false);
  });
});

describe('a suite change approved earlier, read again at the send', () => {
  const recheck = (over: Partial<SuiteSendRecheckInput> & { rule: ConnectionRule }) =>
    recheckSuiteSend({
      toolClass: 'external_write',
      initiator: { membershipId: ME, active: true },
      dataClass: 'internal',
      connection: null,
      resource: null,
      ...over,
    });
  const send = SUITE_CONNECTION_RULES['gmail.send'];
  const edit = SUITE_CONNECTION_RULES['docs.edit'];
  const create = SUITE_CONNECTION_RULES['drive.create_file'];
  const docs = [google('documents')];

  it('goes when nothing changed since it was approved', () => {
    expect(recheck({ rule: send, connection: mine([google('gmail.send')]) })).toEqual({ ok: true });
    expect(
      recheck({
        rule: edit,
        connection: organizations(docs),
        resource: { synced: true, access: ['write'] },
      }),
    ).toEqual({ ok: true });
  });

  it('stops when the initiator left, or cannot be found', () => {
    const connection = mine([google('gmail.send')]);
    expect(
      recheck({ rule: send, connection, initiator: { membershipId: ME, active: false } }),
    ).toEqual({ ok: false, code: 'ACCESS_REVOKED' });
    expect(recheck({ rule: send, connection, initiator: null })).toEqual({
      ok: false,
      code: 'ACCESS_REVOKED',
    });
  });

  it('stops when the connection was revoked or is gone', () => {
    expect(
      recheck({ rule: send, connection: { ...mine([google('gmail.send')]), state: 'revoked' } }),
    ).toEqual({ ok: false, code: 'CONNECTION_NOT_ACTIVE' });
    expect(recheck({ rule: send, connection: null })).toEqual({
      ok: false,
      code: 'CONNECTION_NOT_ACTIVE',
    });
  });

  it('stops when the provider narrowed the scopes', () => {
    expect(recheck({ rule: send, connection: mine([google('gmail.readonly')]) })).toEqual({
      ok: false,
      code: 'SCOPE_NOT_GRANTED',
    });
  });

  it('stops when the connection is no longer the initiator’s to use', () => {
    expect(
      recheck({
        rule: send,
        connection: { ...mine([google('gmail.send')]), ownerMembershipId: SOMEONE_ELSE },
      }),
    ).toEqual({ ok: false, code: 'CONNECTION_CHANGED' });
    expect(recheck({ rule: send, connection: organizations([google('gmail.send')]) })).toEqual({
      ok: false,
      code: 'CONNECTION_CHANGED',
    });
  });

  it('stops when the source no longer grants the initiator the file, or the folder', () => {
    for (const resource of [
      { synced: true, access: ['read' as const] },
      { synced: false, access: ['write' as const] },
      null,
    ]) {
      expect(recheck({ rule: edit, connection: organizations(docs), resource })).toEqual({
        ok: false,
        code: 'ACCESS_REVOKED',
      });
    }
    expect(
      recheck({ rule: create, connection: organizations([google('drive.file')]), resource: null }),
    ).toEqual({ ok: false, code: 'ACCESS_REVOKED' });
  });
});

describe('a new file through the organization’s connection', () => {
  it('needs write on a synced parent folder, and none on a member’s own', () => {
    const drive = SUITE_CONNECTION_RULES['drive.create_file'];
    const onedrive = SUITE_CONNECTION_RULES['onedrive.create_file'];
    const scopes = [google('drive.file')];
    expect(
      decide({ rule: drive, toolClass: 'external_write', connection: organizations(scopes) }),
    ).toMatchObject({ ok: false, auditAs: 'RESOURCE_NOT_SYNCED' });
    expect(
      decide({
        rule: drive,
        toolClass: 'external_write',
        connection: organizations(scopes),
        resource: { synced: true, access: ['read'] },
      }),
    ).toMatchObject({ ok: false, auditAs: 'SOURCE_ACL_DENIED' });
    expect(
      decide({
        rule: drive,
        toolClass: 'external_write',
        connection: organizations(scopes),
        resource: { synced: true, access: ['write'] },
      }),
    ).toMatchObject({ ok: true });
    expect(
      decide({ rule: drive, toolClass: 'external_write', connection: mine(scopes) }),
    ).toMatchObject({ ok: true, ownerKind: 'member' });
    expect(resourceIdOf(drive, { parent_id: 'folder-1', name: 'a.txt' })).toBe('folder-1');
    expect(resourceIdOf(drive, { name: 'a.txt' })).toBeNull();
    expect(resourceIdOf(onedrive, { drive_id: 'b!d', parent_id: '01F' })).toBe('["b!d","01F"]');
    expect(resourceIdOf(onedrive, { parent_id: '01F' })).toBeNull();
  });
});
