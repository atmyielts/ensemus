// ADR-033: the same rules exist in code, in reviewed SQL, in the contracts and in the OpenAPI spec, since the web
// and the worker share a role. These keep every copy the same, and hold the rules nobody should relax quietly.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  acceptProposedWorkSchema,
  approveProviderSchema,
  meetingItemsOutputSchema,
  meetingSummaryOutputSchema,
  recordConsentSchema,
} from '@ensemus/contracts/meetings';
import {
  invoiceDraftCreatePayloadSchema,
  recordUpdatePayloadSchema,
  ticketCommentAddPayloadSchema,
} from '@ensemus/contracts/business-records';
import { adapterChangeNoticeSchema, adapterPageSchema } from '@ensemus/contracts/business-adapter';
import { BUSINESS_CONNECTOR_MANIFESTS } from '@ensemus/connectors/manifest-business';
import {
  BUSINESS_CONNECTOR_TYPES,
  BUSINESS_STREAMS,
  BUSINESS_TOOLS,
  canReadBusinessRecord,
  checkRecordChange,
  connectorTypeOfStream,
  hasWriteScope,
  isToolOf,
  recordClassification,
  selectRecordFields,
} from '@ensemus/domain/business-connector';
import {
  canAdministerMeetings,
  canDecideProposedItem,
  canManageMeeting,
  canReadMeetingContent,
  canSeeMeeting,
  checkBeforeDerivation,
  checkProviderApproval,
  classificationAllowedByApproval,
  consentBasisFor,
  consentStateOf,
  CONSENT_DECISIONS,
  DERIVATION_STATUSES,
  DERIVATION_TRANSITIONS,
  MAX_ITEM_DETAIL_LENGTH,
  MAX_ITEM_TITLE_LENGTH,
  MAX_MEETING_TITLE_LENGTH,
  MAX_NOTES_BYTES,
  MAX_SUMMARY_BYTES,
  MEETING_PURPOSES,
  PROPOSED_ITEM_STATUSES,
  PROPOSED_ITEM_TRANSITIONS,
  type ProviderApprovalFacts,
} from '@ensemus/domain/meeting';
import { MAX_RECORD_FIELDS_BYTES } from '@ensemus/domain/business-connector';
import { ledgerKeyFor, parseLedgerKey } from '@ensemus/domain/tombstone-ledger';
import { spec } from '../helpers/openapi';
import { repoRoot } from '../helpers/stack';

const tables = readFileSync(
  join(repoRoot, 'packages/database/migrations/0600_expansion.sql'),
  'utf8',
);
const security = readFileSync(
  join(repoRoot, 'packages/database/migrations/0601_expansion_security.sql'),
  'utf8',
);
const schemas = spec.components.schemas as Record<string, { properties: Record<string, any> }>;

const NOW = new Date('2026-11-06T12:00:00Z');
const LATER = new Date('2026-12-06T12:00:00Z');

describe('the SQL and the domain', () => {
  it('has one list of derivation transitions', () => {
    const inSql = Object.fromEntries(
      [...security.matchAll(/WHEN '([a-z_]+)' THEN NEW\.status IN \(([^)]+)\)/g)].map(
        ([, from, to]) => [
          from,
          (to as string)
            .split(',')
            .map((name) => name.trim().replaceAll("'", ''))
            .sort(),
        ],
      ),
    );
    for (const status of DERIVATION_STATUSES) {
      expect(inSql[status] ?? [], status).toEqual([...DERIVATION_TRANSITIONS[status]].sort());
    }
  });

  it('has the same item transitions', () => {
    const [, to] = /OLD\.status = 'proposed' AND NEW\.status IN \(([^)]+)\)/.exec(security) ?? [];
    expect(
      (to as string)
        .split(',')
        .map((name) => name.trim().replaceAll("'", ''))
        .sort(),
    ).toEqual([...PROPOSED_ITEM_TRANSITIONS.proposed].sort());
    for (const status of PROPOSED_ITEM_STATUSES) {
      if (status !== 'proposed') expect(PROPOSED_ITEM_TRANSITIONS[status]).toEqual([]);
    }
  });

  it.each([
    ['consent decisions', /meeting_consent_decision" CHECK \([^)]*in \(([^)]+)\)/, CONSENT_DECISIONS],
    [
      'derivation statuses',
      /meeting_derivation_status" CHECK \([^)]*in \(([^)]+)\)/,
      DERIVATION_STATUSES,
    ],
    [
      'proposed item statuses',
      /meeting_proposed_items_status" CHECK \([^)]*in \(([^)]+)\)/,
      PROPOSED_ITEM_STATUSES,
    ],
  ])('has the same %s', (_name, pattern, expected) => {
    const [, found] = (pattern as RegExp).exec(tables) ?? [];
    expect(
      (found as string)
        .split(',')
        .map((name) => name.trim().replaceAll("'", ''))
        .sort(),
    ).toEqual([...(expected as readonly string[])].sort());
  });

  it('has the same limits', () => {
    expect(tables).toContain(`octet_length("meetings"."notes"."body") <= ${MAX_NOTES_BYTES}`);
    expect(tables).toContain(`octet_length("meetings"."summaries"."body") <= ${MAX_SUMMARY_BYTES}`);
    expect(tables).toContain(
      `char_length("meetings"."meetings"."title") between 1 and ${MAX_MEETING_TITLE_LENGTH}`,
    );
    expect(tables).toContain(
      `char_length("meetings"."proposed_items"."title") between 1 and ${MAX_ITEM_TITLE_LENGTH}`,
    );
    expect(tables).toContain(
      `char_length("meetings"."proposed_items"."detail") <= ${MAX_ITEM_DETAIL_LENGTH}`,
    );
    expect(tables).toContain(
      `octet_length("integrations"."business_records"."fields"::text) <= ${MAX_RECORD_FIELDS_BYTES}`,
    );
  });

  it('forces RLS on the meetings schema and both new tables', () => {
    expect(security).toMatch(/schemaname = 'meetings'/);
    expect(security).toContain("tablename IN ('business_records', 'business_record_actions')");
    expect(security).toContain('FORCE ROW LEVEL SECURITY');
  });

  it('grants no role but the application anything here', () => {
    const roles = new Set(
      [...security.matchAll(/GRANT [\s\S]*? TO (\w+);/g)].map(([, role]) => role),
    );
    expect([...roles]).toEqual(['ensemus_app']);
  });

  it('gives nobody a way to change who consented, or what a run or a proposal is about', () => {
    expect(security).not.toMatch(/GRANT[^;]*ON meetings\.consent_records[^;]*UPDATE/);
    expect(security).not.toMatch(/GRANT UPDATE[^;]*ON meetings\.consent_records/);
    for (const fixed of ['kind', 'run_id', 'ordinal', 'classification', 'meeting_id']) {
      const [grant] = /GRANT UPDATE \([^)]*\)\s*ON meetings\.proposed_items/.exec(security) ?? [];
      expect(grant, fixed).not.toMatch(new RegExp(`\\b${fixed}\\b`));
    }
  });

  it('is marked as reviewed security SQL', () => {
    expect(security.split('\n')[0]).toContain('REVIEWED SECURITY SQL');
  });
});

describe('the contracts and the spec', () => {
  it('have the same consent decisions', () => {
    expect(recordConsentSchema.shape.decision.options.sort()).toEqual([...CONSENT_DECISIONS].sort());
  });

  it('have the same derivation statuses', () => {
    expect([...schemas.MeetingDerivation!.properties.status.enum].sort()).toEqual(
      [...DERIVATION_STATUSES].sort(),
    );
  });

  it('have the same item statuses', () => {
    expect([...schemas.MeetingProposedItem!.properties.status.enum].sort()).toEqual(
      [...PROPOSED_ITEM_STATUSES].sort(),
    );
  });

  it('have the same purposes', () => {
    expect([...schemas.MeetingProviderApproval!.properties.purposes.items.enum].sort()).toEqual(
      [...MEETING_PURPOSES].sort(),
    );
  });
});

describe('the manifests and the domain', () => {
  it('list one manifest per connector, and the meeting notes one', () => {
    expect(BUSINESS_CONNECTOR_MANIFESTS.map((manifest) => manifest.type).sort()).toEqual(
      [...BUSINESS_CONNECTOR_TYPES, 'meeting_notes_http'].sort(),
    );
  });

  it.each(BUSINESS_CONNECTOR_TYPES)('%s declares what the domain lists', (type) => {
    const manifest = BUSINESS_CONNECTOR_MANIFESTS.find((one) => one.type === type);
    expect(manifest?.capabilities.actions).toEqual(BUSINESS_TOOLS[type]);
    expect(manifest?.capabilities.sync?.streams).toEqual(Object.keys(BUSINESS_STREAMS[type]));
  });

  it('all go only through the gateway, and all need a credential', () => {
    for (const manifest of BUSINESS_CONNECTOR_MANIFESTS) {
      expect(manifest.capabilities.network).toBe('egress_gateway');
      expect(manifest.credential.required).toBe(true);
    }
  });

  it('claim no lookup is proof', () => {
    for (const manifest of BUSINESS_CONNECTOR_MANIFESTS) {
      expect(manifest.capabilities.reconcile).not.toBe('authoritative');
    }
  });

  it('name no vendor', () => {
    const everything = JSON.stringify({ BUSINESS_STREAMS, BUSINESS_TOOLS, BUSINESS_CONNECTOR_MANIFESTS });
    expect(everything).not.toMatch(
      /salesforce|hubspot|zendesk|jira|freshdesk|quickbooks|xero|sage|netsuite|zoom|teams|gong|otter/i,
    );
  });
});

describe('no tool moves money', () => {
  const allTools = BUSINESS_CONNECTOR_TYPES.flatMap((type) => BUSINESS_TOOLS[type]);

  it('has no tool that sounds like it does', () => {
    for (const tool of allTools) {
      expect(tool).not.toMatch(/pay|transfer|wire|refund|disburse|post|approve|void/);
    }
  });

  it('has every money field read-only, in every stream', () => {
    for (const type of BUSINESS_CONNECTOR_TYPES) {
      for (const [stream, rule] of Object.entries(BUSINESS_STREAMS[type])) {
        for (const [name, field] of Object.entries(rule.fields)) {
          if (field.type === 'decimal' || /amount|total|currency|balance/.test(name)) {
            expect(field.writable, `${stream}.${name}`).toBe(false);
          }
        }
      }
    }
  });

  it('has no writable status on anything in accounting', () => {
    for (const [stream, rule] of Object.entries(BUSINESS_STREAMS.accounting_http)) {
      expect(rule.fields.status?.writable ?? false, stream).toBe(false);
    }
  });

  it('cannot write a payment at all', () => {
    expect(
      Object.values(BUSINESS_STREAMS.accounting_http['accounting.payments']!.fields).some(
        (field) => field.writable,
      ),
    ).toBe(false);
  });

  it('makes only a draft, with no status or payment field to set', () => {
    const invoice = {
      customer_ref: 'customer-1',
      currency: 'USD',
      lines: [{ description: 'Work', quantity: '1', unit_price: '10.00' }],
    };
    expect(invoiceDraftCreatePayloadSchema.safeParse(invoice).success).toBe(true);
    for (const extra of [{ status: 'posted' }, { pay_now: true }, { bank_account: 'x' }]) {
      expect(invoiceDraftCreatePayloadSchema.safeParse({ ...invoice, ...extra }).success).toBe(false);
    }
  });

  it('keeps money as a string', () => {
    expect(
      invoiceDraftCreatePayloadSchema.safeParse({
        customer_ref: 'customer-1',
        currency: 'USD',
        lines: [{ description: 'Work', quantity: 1, unit_price: 10.5 }],
      }).success,
    ).toBe(false);
  });
});

describe('selected fields', () => {
  it('finds which connector owns a stream, and no prototype keys', () => {
    expect(connectorTypeOfStream('crm.deals')).toBe('crm_http');
    expect(connectorTypeOfStream('constructor')).toBeUndefined();
    expect(connectorTypeOfStream('__proto__')).toBeUndefined();
  });

  it('drops a field nobody listed, and keeps what is listed', () => {
    expect(
      selectRecordFields('crm.deals', { name: 'A deal', margin_notes: 'CANARY', amount: '10.00' }),
    ).toEqual({ ok: true, fields: { name: 'A deal', amount: '10.00' } });
  });

  it.each([
    ['a number for money', { amount: 10.5 }],
    ['text too long', { name: 'x'.repeat(301) }],
    ['a null byte', { name: 'a\0b' }],
    ['a nested object', { name: { nested: true } }],
    ['a date that is not one', { close_on: 'soon' }],
    ['an impossible date', { close_on: '2026-13-45' }],
  ])('refuses %s', (_name, fields) => {
    expect(selectRecordFields('crm.deals', fields)).toEqual({ ok: false });
  });

  it('refuses a stream nobody declared', () => {
    expect(selectRecordFields('crm.nothing', {})).toEqual({ ok: false });
  });

  it('allows a listed field to be empty', () => {
    expect(selectRecordFields('crm.deals', { close_on: null })).toEqual({
      ok: true,
      fields: { close_on: null },
    });
  });
});

describe('a proposed change', () => {
  it('may touch writable fields', () => {
    expect(checkRecordChange('crm.deals', { stage: 'won', next_step: 'Call' })).toEqual({ ok: true });
  });

  it.each([
    ['a read-only field', { amount: '1.00' }],
    ['a field nobody listed', { margin_notes: 'x' }],
    ['a prototype key', JSON.parse('{"__proto__":"x"}')],
    ['nothing at all', {}],
    ['the wrong shape', { close_on: 'soon' }],
    ['text too long', { next_step: 'x'.repeat(1001) }],
  ])('may not touch %s', (_name, changes) => {
    expect(checkRecordChange('crm.deals', changes)).toEqual({ ok: false });
  });

  it('has to bind the record, the version it saw and the changes', () => {
    expect(
      recordUpdatePayloadSchema.safeParse({
        record: { stream: 'crm.deals', external_id: 'x' },
        changes: { stage: 'won' },
      }).success,
    ).toBe(false);
  });

  it('has no customer-facing form of a ticket comment', () => {
    const comment = { ticket: { external_id: 'x' }, visibility: 'internal', body: 'A note' };
    expect(ticketCommentAddPayloadSchema.safeParse(comment).success).toBe(true);
    expect(
      ticketCommentAddPayloadSchema.safeParse({ ...comment, visibility: 'public' }).success,
    ).toBe(false);
  });

  it('checks the tool belongs to the connector, and the scope was granted', () => {
    expect(isToolOf('crm_http', 'crm.record.update')).toBe(true);
    expect(isToolOf('crm_http', 'accounting.record.update')).toBe(false);
    expect(isToolOf('email_smtp', 'crm.record.update')).toBe(false);
    expect(hasWriteScope('crm_http', ['crm_http.write'])).toBe(true);
    expect(hasWriteScope('crm_http', ['crm_http.read'])).toBe(false);
    expect(hasWriteScope('crm_http', ['ticketing_http.write'])).toBe(false);
  });
});

describe('who reads a record', () => {
  const facts = { aclState: 'mapped', viewerHasGrant: true, deleted: false } as const;

  it('is someone the source granted', () => {
    expect(canReadBusinessRecord(facts)).toBe(true);
    expect(canReadBusinessRecord({ ...facts, aclState: 'partial' })).toBe(true);
  });

  it.each([
    ['no grant', { viewerHasGrant: false }],
    ['nothing mapped', { aclState: 'unmapped' }],
    ['no resource row yet', { aclState: null }],
    ['gone at the source', { deleted: true }],
  ] as const)('is nobody with %s', (_name, change) => {
    expect(canReadBusinessRecord({ ...facts, ...change })).toBe(false);
  });

  it('never lets a source lower a class past the floor', () => {
    expect(recordClassification('accounting_http', 'public')).toBe('confidential');
    expect(recordClassification('accounting_http', undefined)).toBe('confidential');
    expect(recordClassification('crm_http', 'restricted')).toBe('restricted');
  });
});

describe('consent', () => {
  const said = (...decisions: ('granted' | 'declined' | 'withdrawn' | null)[]) =>
    decisions.map((decision, index) => ({ participantId: String(index), decision }));

  it.each([
    ['nobody listed', said(), 'none_listed'],
    ['nobody answered', said(null, null), 'pending'],
    ['one still to answer', said('granted', null), 'pending'],
    ['everyone agreed', said('granted', 'granted'), 'complete'],
    ['one no', said('granted', 'declined'), 'refused'],
    ['one no among silence', said(null, 'declined'), 'refused'],
    ['one withdrawal', said('granted', 'withdrawn'), 'withdrawn'],
    ['a withdrawal beats a no', said('declined', 'withdrawn'), 'withdrawn'],
  ] as const)('with %s', (_name, participants, expected) => {
    expect(consentStateOf(participants)).toBe(expected);
  });

  const organizer = 'organizer';
  const alice = 'alice';

  it('lets a member speak for themselves, and nobody else speak for them', () => {
    const member = {
      participantKind: 'member',
      participantMembershipId: alice,
      organizerMembershipId: organizer,
    } as const;
    expect(consentBasisFor({ ...member, recorderMembershipId: alice })).toBe('self');
    expect(consentBasisFor({ ...member, recorderMembershipId: organizer })).toBeNull();
    expect(consentBasisFor({ ...member, recorderMembershipId: 'admin' })).toBeNull();
  });

  it('lets the organizer attest for someone outside, and nobody else', () => {
    const outside = {
      participantKind: 'external',
      participantMembershipId: null,
      organizerMembershipId: organizer,
    } as const;
    expect(consentBasisFor({ ...outside, recorderMembershipId: organizer })).toBe('attested');
    expect(consentBasisFor({ ...outside, recorderMembershipId: alice })).toBeNull();
  });
});

describe('provider approval', () => {
  const approval: ProviderApprovalFacts = {
    kind: 'model',
    purposes: ['summarize'],
    maxClassification: 'confidential',
    expiresAt: LATER,
    revokedAt: null,
  };
  const wanted = { kind: 'model', purpose: 'summarize', classification: 'internal' } as const;

  it('allows what it names', () => {
    expect(checkProviderApproval(approval, wanted, NOW)).toEqual({ ok: true });
  });

  it.each([
    ['none at all', null, wanted, 'PROVIDER_NOT_APPROVED'],
    ['another kind', { ...approval, kind: 'source' }, wanted, 'PROVIDER_NOT_APPROVED'],
    ['revoked', { ...approval, revokedAt: NOW }, wanted, 'PROVIDER_NOT_APPROVED'],
    [
      'another purpose',
      approval,
      { ...wanted, purpose: 'extract_items' },
      'PROVIDER_NOT_APPROVED',
    ],
    ['expired', { ...approval, expiresAt: NOW }, wanted, 'PROVIDER_APPROVAL_EXPIRED'],
    [
      'a higher class',
      { ...approval, maxClassification: 'internal' },
      { ...wanted, classification: 'confidential' },
      'CLASSIFICATION_NOT_ALLOWED',
    ],
    [
      'restricted, whatever it says',
      approval,
      { ...wanted, classification: 'restricted' },
      'CLASSIFICATION_NOT_ALLOWED',
    ],
  ] as const)('refuses %s', (_name, facts, asked, code) => {
    expect(checkProviderApproval(facts as ProviderApprovalFacts | null, asked, NOW)).toEqual({
      ok: false,
      code,
    });
  });

  it('never allows restricted', () => {
    expect(classificationAllowedByApproval('restricted', 'confidential')).toBe(false);
  });

  it('cannot be asked for restricted through the contract', () => {
    expect(
      approveProviderSchema.safeParse({
        kind: 'model',
        model_profile_id: '6f1c2c6e-1111-4111-8111-111111111111',
        purposes: ['summarize'],
        max_classification: 'restricted',
        terms_ref: 'a-reference',
        expires_at: LATER.toISOString(),
      }).success,
    ).toBe(false);
  });
});

describe('the last check before a provider sees anything', () => {
  const facts = {
    meetingStatus: 'open',
    consent: 'complete',
    provider: { ok: true },
    notesCurrent: true,
    notesPurged: false,
  } as const;

  it('passes when everything holds', () => {
    expect(checkBeforeDerivation(facts)).toEqual({ ok: true });
  });

  it.each([
    ['a purged meeting', { meetingStatus: 'purged' }, 'MEETING_PURGED'],
    ['purged notes', { notesPurged: true }, 'MEETING_PURGED'],
    ['a withdrawal', { consent: 'withdrawn' }, 'CONSENT_WITHDRAWN'],
    ['a no', { consent: 'refused' }, 'CONSENT_INCOMPLETE'],
    ['someone new', { consent: 'pending' }, 'CONSENT_INCOMPLETE'],
    ['nobody listed', { consent: 'none_listed' }, 'CONSENT_INCOMPLETE'],
    [
      'no approval',
      { provider: { ok: false, code: 'PROVIDER_NOT_APPROVED' } },
      'PROVIDER_NOT_APPROVED',
    ],
    ['older notes', { notesCurrent: false }, 'NOTES_NOT_CURRENT'],
  ] as const)('stops for %s', (_name, change, code) => {
    expect(checkBeforeDerivation({ ...facts, ...change })).toEqual({ ok: false, code });
  });

  it('puts withdrawal ahead of everything else it can say', () => {
    expect(
      checkBeforeDerivation({
        ...facts,
        consent: 'withdrawn',
        provider: { ok: false, code: 'PROVIDER_NOT_APPROVED' },
        notesCurrent: false,
      }),
    ).toEqual({ ok: false, code: 'CONSENT_WITHDRAWN' });
  });
});

describe('who reads a meeting', () => {
  const meeting = { organizerMembershipId: 'organizer', isParticipant: false };
  const owner = { membershipId: 'owner', role: 'owner' };
  const admin = { membershipId: 'admin', role: 'admin' };
  const member = { membershipId: 'member', role: 'member' };

  it('shows its content to the people in the room, and nobody else', () => {
    expect(canReadMeetingContent({ ...meeting, isParticipant: true }, member)).toBe(true);
    expect(
      canReadMeetingContent(meeting, { membershipId: 'organizer', role: 'member' }),
    ).toBe(true);
    expect(canReadMeetingContent(meeting, member)).toBe(false);
    expect(canReadMeetingContent(meeting, owner)).toBe(false);
    expect(canReadMeetingContent(meeting, admin)).toBe(false);
  });

  it('lets an owner or admin see that it exists, and nobody else outside it', () => {
    expect(canSeeMeeting(meeting, owner)).toBe(true);
    expect(canSeeMeeting(meeting, admin)).toBe(true);
    expect(canSeeMeeting(meeting, member)).toBe(false);
  });

  it('leaves managing it to its organizer', () => {
    expect(canManageMeeting(meeting, { membershipId: 'organizer', role: 'member' })).toBe(true);
    expect(canManageMeeting({ ...meeting, isParticipant: true }, member)).toBe(false);
    expect(canManageMeeting(meeting, owner)).toBe(false);
  });

  it('leaves proposals to the people in the room', () => {
    expect(canDecideProposedItem({ ...meeting, isParticipant: true }, member)).toBe(true);
    expect(canDecideProposedItem(meeting, owner)).toBe(false);
  });

  it('leaves settings and approvals to owners and admins', () => {
    expect(canAdministerMeetings('owner')).toBe(true);
    expect(canAdministerMeetings('admin')).toBe(true);
    expect(canAdministerMeetings('member')).toBe(false);
    expect(canAdministerMeetings('service')).toBe(false);
  });
});

describe('what a model can hand back', () => {
  it('is data, with no field to name an ID, a URL or an instruction', () => {
    const item = { kind: 'work', title: 'Send the plan' };
    expect(meetingItemsOutputSchema.safeParse({ items: [item] }).success).toBe(true);
    for (const extra of [
      { work_unit_id: '6f1c2c6e-1111-4111-8111-111111111111' },
      { owner_membership_id: '6f1c2c6e-1111-4111-8111-111111111111' },
      { url: 'https://example.invalid/' },
      { status: 'accepted' },
      { apply: true },
    ]) {
      expect(meetingItemsOutputSchema.safeParse({ items: [{ ...item, ...extra }] }).success).toBe(
        false,
      );
    }
    expect(meetingItemsOutputSchema.safeParse({ items: [{ kind: 'send_email', title: 'x' }] }).success).toBe(false);
    expect(meetingSummaryOutputSchema.safeParse({ summary: 'x', actions: [] }).success).toBe(false);
  });

  it('is bounded', () => {
    expect(
      meetingItemsOutputSchema.safeParse({
        items: Array.from({ length: 101 }, () => ({ kind: 'work', title: 'x' })),
      }).success,
    ).toBe(false);
    expect(meetingSummaryOutputSchema.safeParse({ summary: 'x'.repeat(100_001) }).success).toBe(false);
  });

  it('leaves accepting to a person, who sends every field themselves', () => {
    expect(
      acceptProposedWorkSchema.safeParse({ title: 'x', due_at: null }).success,
    ).toBe(false);
  });
});

describe('what an adapter can say', () => {
  it('is a strict page', () => {
    const page = { records: [], deleted: [], next_cursor: null, has_more: false };
    expect(adapterPageSchema.safeParse(page).success).toBe(true);
    expect(adapterPageSchema.safeParse({ ...page, extra: 1 }).success).toBe(false);
  });

  it('can only ask for a sync in a notice', () => {
    expect(adapterChangeNoticeSchema.safeParse({ type: 'records_changed' }).success).toBe(true);
    expect(
      adapterChangeNoticeSchema.safeParse({ type: 'records_changed', record: { id: 'x' } }).success,
    ).toBe(false);
  });
});

describe('a withdrawn meeting after a restore', () => {
  it('can go in the ledger, which holds its ID and nothing else', () => {
    const entry = {
      organizationId: '6f1c2c6e-1111-4111-8111-111111111111',
      targetType: 'meeting',
      targetId: '6f1c2c6e-2222-4222-8222-222222222222',
    };
    expect(parseLedgerKey(ledgerKeyFor(entry))).toEqual(entry);
  });
});
