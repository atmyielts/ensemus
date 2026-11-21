// Actual shipped connector constructors through the generated adapter protocol; no socket/provider.
import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { createCrmConnector } from '../crm';
import { createTicketingConnector } from '../ticketing';
import { createAccountingConnector } from '../accounting';
import { createFakeAdapter, type FakeAdapterBehaviour } from '../testing/business-adapter';
import type { ActionRequest, ConnectorContext } from '../index';
import type { BusinessConnectorConfig } from '@ensemus/contracts/business-records';
import { BUSINESS_STREAMS } from '@ensemus/domain/business-connector';
import type { BusinessRecordSink } from './kit';
const rows = [
  {
    type: 'crm_http',
    make: createCrmConnector,
    stream: 'crm.accounts',
    tool: 'crm.record.update',
    changes: { status: 'reviewed' },
  },
  {
    type: 'ticketing_http',
    make: createTicketingConnector,
    stream: 'ticketing.tickets',
    tool: 'ticketing.record.update',
    changes: { priority: 'normal' },
  },
  {
    type: 'accounting_http',
    make: createAccountingConnector,
    stream: 'accounting.invoices',
    tool: 'accounting.record.update',
    changes: { memo: 'Generated memo' },
  },
] as const;
const sample: Record<string, Record<string, unknown>> = {
  'crm.accounts': { name: 'Generated account', status: 'open' },
  'crm.contacts': { name: 'Generated person', email: 'generated@example.invalid' },
  'crm.deals': { name: 'Generated deal', amount: '100.10', currency: 'USD', stage: 'open' },
  'ticketing.tickets': { subject: 'Generated ticket', status: 'open' },
  'ticketing.comments': {
    ticket_ref: 'generated-ticket',
    author_ref: 'generated-person',
    body: 'Generated internal note',
    visibility: 'internal',
    posted_at: '2026-11-21T00:00:00Z',
  },
  'accounting.invoices': { number: 'GENERATED-1', total: '100.10', currency: 'USD' },
  'accounting.bills': { number: 'GENERATED-2', total: '100.10', currency: 'USD' },
  'accounting.payments': { reference: 'GENERATED-3', amount: '100.10', currency: 'USD' },
};
function fixture(
  row: (typeof rows)[number],
  options: Parameters<typeof createFakeAdapter>[0] = {},
) {
  const adapter = createFakeAdapter(options),
    stored: Parameters<BusinessRecordSink['applyPage']>[0][] = [];
  const connector = row.make({
    tls: 'none',
    beforeCommitMs: 1000,
    answerMs: 40,
    sink: {
      applyPage: async (p) => {
        stored.push(p);
      },
    },
  });
  const config = connector.parseConfig({
    streams: Object.keys(BUSINESS_STREAMS[row.type]),
    scopes: [row.type + '.read', row.type + '.write'],
  });
  const context: ConnectorContext<BusinessConnectorConfig> = {
    organizationId: randomUUID(),
    connectionId: randomUUID(),
    config,
    grantedScopes: config.scopes,
    credentials: adapter.credentials,
    network: adapter.network,
    signal: new AbortController().signal,
  };
  const id = randomUUID(),
    request: ActionRequest = {
      externalActionId: id,
      attemptId: randomUUID(),
      attemptNo: 1,
      toolName: row.tool,
      toolVersion: '1',
      idempotencyKey: 'ensemus-' + id,
      requestHash: 'generated-hash',
      payload: {
        record: { stream: row.stream, external_id: 'generated-record', expected_version: '17' },
        changes: row.changes,
      },
    };
  return { adapter, stored, connector, context, request };
}
for (const row of rows)
  describe(row.type + ' shipped protocol', () => {
    it.each(Object.keys(BUSINESS_STREAMS[row.type]))(
      'keeps only listed %s fields and source grants, with the classification floor',
      async (stream) => {
        const fields = sample[stream]!,
          f = fixture(row, {
            streams: {
              [stream]: [
                {
                  id: 'same-generated-id',
                  version: '1',
                  classification: 'public',
                  fields: { ...fields, unknown_secret: 'DROP-GENERATED-CANARY' },
                  acl: [
                    {
                      principal_kind: 'user',
                      principal_external_id: 'generated@example.invalid',
                      access: 'read',
                    },
                  ],
                },
              ],
            },
          });
        const page = await f.connector.sync!.readPage(f.context, {
          stream,
          cursor: null,
          fullSync: true,
          pageSize: 200,
        });
        expect(f.stored[0]!.records[0]!.fields).toEqual(fields);
        expect(JSON.stringify(f.stored)).not.toContain('DROP-GENERATED-CANARY');
        expect(page.resources[0]!.acl).toEqual([
          {
            principalKind: 'user',
            principalExternalId: 'generated@example.invalid',
            access: 'read',
          },
        ]);
        expect(page.resources[0]!.classification).toBe(
          row.type === 'accounting_http' ? 'confidential' : 'internal',
        );
      },
    );
    it('requires both saved settings and actual row scopes before any read or write contact', async () => {
      for (const grantedScopes of [undefined, []]) {
        const f = fixture(row);
        const context = { ...f.context, ...(grantedScopes === undefined ? {} : { grantedScopes }) };
        if (grantedScopes === undefined) delete context.grantedScopes;
        await expect(
          f.connector.sync!.readPage(context, {
            stream: row.stream,
            cursor: null,
            fullSync: true,
            pageSize: 1,
          }),
        ).rejects.toMatchObject({ code: 'SYNC_AUTH_FAILED' });
        await expect(f.connector.actions!.send(context, f.request)).rejects.toMatchObject({
          code: 'AUTH_FAILED',
          retryable: false,
        });
        expect(f.adapter.opened()).toBe(0);
      }
      const f = fixture(row);
      f.context.config = { ...f.context.config, scopes: [] };
      await expect(f.connector.actions!.send(f.context, f.request)).rejects.toMatchObject({
        code: 'AUTH_FAILED',
      });
      expect(f.adapter.opened()).toBe(0);
    });
    it('makes no contact for an unselected stream and refuses another kind of stream', async () => {
      const f = fixture(row);
      f.context.config = { ...f.context.config, streams: [] };
      expect(
        await f.connector.sync!.readPage(f.context, {
          stream: row.stream,
          cursor: 'kept',
          fullSync: false,
          pageSize: 1,
        }),
      ).toMatchObject({ resources: [], nextCursor: 'kept' });
      await expect(f.connector.actions!.send(f.context, f.request)).rejects.toMatchObject({
        code: 'AUTH_FAILED',
      });
      expect(f.adapter.opened()).toBe(0);
      await expect(
        f.connector.sync!.readPage(f.context, {
          stream: 'a.foreign_stream',
          cursor: null,
          fullSync: true,
          pageSize: 1,
        }),
      ).rejects.toMatchObject({ code: 'SYNC_UNAVAILABLE' });
    });
    it.each([
      'accounting.payment.create',
      'bank.transfer',
      'accounting.invoice.post',
      'ticketing.reply.send',
    ])('refuses %s without lending a credential or contacting an adapter', async (tool) => {
      const f = fixture(row);
      await expect(
        f.connector.actions!.send(f.context, { ...f.request, toolName: tool }),
      ).rejects.toMatchObject({ code: 'PAYLOAD_CHANGED' });
      expect(f.adapter.opened()).toBe(0);
    });
    it.each([
      { amount: '100.10' },
      { total: '100.10' },
      { name: 'Overwrite source name' },
      { unknown_field: 'No' },
    ])('refuses a non-writable change %j', async (changes) => {
      const f = fixture(row);
      await expect(
        f.connector.actions!.send(f.context, {
          ...f.request,
          payload: {
            record: { stream: row.stream, external_id: 'generated-record', expected_version: '17' },
            changes,
          },
        }),
      ).rejects.toMatchObject({ code: 'PAYLOAD_CHANGED' });
      expect(f.adapter.opened()).toBe(0);
    });
    it('refuses a missing source version before lending a credential or contacting the adapter', async () => {
      const f = fixture(row);
      await expect(
        f.connector.actions!.send(f.context, {
          ...f.request,
          payload: {
            record: { stream: row.stream, external_id: 'generated-record', expected_version: null },
            changes: row.changes,
          },
        }),
      ).rejects.toMatchObject({ code: 'PAYLOAD_CHANGED' });
      expect(f.adapter.opened()).toBe(0);
      expect(f.adapter.effects()).toHaveLength(0);
    });
    it('keeps the exact expected version, refuses a foreign stream and applies a repeated key once', async () => {
      const f = fixture(row);
      await expect(
        f.connector.actions!.send(f.context, {
          ...f.request,
          payload: {
            record: {
              stream: row.type === 'crm_http' ? 'accounting.invoices' : 'crm.accounts',
              external_id: 'generated-record',
              expected_version: '17',
            },
            changes: row.changes,
          },
        }),
      ).rejects.toMatchObject({ code: 'PAYLOAD_CHANGED' });
      expect(f.adapter.opened()).toBe(0);
      expect((await f.connector.actions!.send(f.context, f.request)).outcome).toBe('accepted');
      await f.connector.actions!.send(f.context, f.request);
      expect(f.adapter.effects()).toHaveLength(1);
      expect(f.adapter.effects()[0]!.payload).toEqual(f.request.payload);
    });
    it.each(['silent_after_effect', 'drop_after_effect'] as const)(
      'keeps %s uncertain and looks it up instead of sending again',
      async (behaviour) => {
        const f = fixture(row);
        f.adapter.next(behaviour);
        expect((await f.connector.actions!.send(f.context, f.request)).outcome).toBe(
          'indeterminate',
        );
        expect(f.adapter.effects()).toHaveLength(1);
        expect(await f.connector.actions!.reconcile(f.context, f.request)).toMatchObject({
          answer: 'found',
        });
        expect(f.adapter.effects()).toHaveLength(1);
      },
    );
    it('does not treat an absent lookup as proof that the effect did not happen', async () => {
      const f = fixture(row);
      f.adapter.next('silent_without_effect');
      expect((await f.connector.actions!.send(f.context, f.request)).outcome).toBe('indeterminate');
      expect(await f.connector.actions!.reconcile(f.context, f.request)).toEqual({
        answer: 'not_found',
      });
      expect(f.connector.manifest.capabilities.reconcile).toBe('best_effort');
    });
    it.each([{ status: 500 }, { raw: 'GENERATED-PROVIDER-TEXT' }] satisfies FakeAdapterBehaviour[])(
      'does not repeat an uncertain provider answer %j',
      async (behaviour) => {
        const f = fixture(row);
        f.adapter.next(behaviour);
        const answer = await f.connector.actions!.send(f.context, f.request);
        expect(answer.outcome).toBe('indeterminate');
        expect(JSON.stringify(answer)).not.toContain('GENERATED-PROVIDER-TEXT');
        expect(f.adapter.requests()).toHaveLength(1);
      },
    );
    it('classifies a refusal before contact and an explicit version conflict honestly', async () => {
      const f = fixture(row);
      f.adapter.next('refuse_connection');
      await expect(f.connector.actions!.send(f.context, f.request)).rejects.toMatchObject({
        code: 'CONNECT_FAILED',
        retryable: true,
      });
      f.adapter.next({ status: 409 });
      expect(await f.connector.actions!.send(f.context, f.request)).toMatchObject({
        outcome: 'rejected',
        providerStatus: 409,
      });
      expect(f.adapter.effects()).toHaveLength(0);
    });
  });
describe('internal ticket notes and accounting drafts', () => {
  it('allows only an internal ticket note, with one effect for a repeated key', async () => {
    const f = fixture(rows[1]),
      request = {
        ...f.request,
        toolName: 'ticketing.comment.add',
        payload: {
          ticket: { external_id: 'generated-ticket' },
          visibility: 'internal',
          body: 'Generated note',
        },
      };
    await expect(
      f.connector.actions!.send(f.context, {
        ...request,
        payload: { ...request.payload, visibility: 'public' },
      }),
    ).rejects.toMatchObject({ code: 'PAYLOAD_CHANGED' });
    expect(f.adapter.opened()).toBe(0);
    await f.connector.actions!.send(f.context, request);
    await f.connector.actions!.send(f.context, request);
    expect(f.adapter.effects()).toHaveLength(1);
    await expect(
      f.connector.actions!.send(f.context, {
        ...f.request,
        payload: {
          record: {
            stream: 'ticketing.comments',
            external_id: 'generated-note',
            expected_version: '1',
          },
          changes: { body: 'Overwrite' },
        },
      }),
    ).rejects.toMatchObject({ code: 'PAYLOAD_CHANGED' });
  });
  it('refuses an invalid posted time rather than storing a partial page', async () => {
    const f = fixture(rows[1], {
      streams: {
        'ticketing.comments': [
          {
            id: 'generated-note',
            version: '1',
            fields: { ...sample['ticketing.comments'], posted_at: 'yesterday' },
            acl: [],
          },
        ],
      },
    });
    await expect(
      f.connector.sync!.readPage(f.context, {
        stream: 'ticketing.comments',
        cursor: null,
        fullSync: true,
        pageSize: 1,
      }),
    ).rejects.toMatchObject({ code: 'SYNC_PAGE_INVALID' });
    expect(f.stored).toEqual([]);
  });
  it('creates only a draft and refuses status, bank or payment instructions', async () => {
    const f = fixture(rows[2]),
      payload = {
        customer_ref: 'generated-customer',
        currency: 'USD',
        lines: [{ description: 'Generated service', quantity: '1', unit_price: '100.10' }],
      },
      request = { ...f.request, toolName: 'accounting.invoice_draft.create', payload };
    for (const extra of [
      { status: 'posted' },
      { pay_now: true },
      { bank_account: 'GENERATED-BANK' },
    ])
      await expect(
        f.connector.actions!.send(f.context, { ...request, payload: { ...payload, ...extra } }),
      ).rejects.toMatchObject({ code: 'PAYLOAD_CHANGED' });
    expect(f.adapter.opened()).toBe(0);
    await f.connector.actions!.send(f.context, request);
    expect(f.adapter.effects()[0]!.payload).toEqual(payload);
    expect(f.connector.manifest.capabilities.actions).toEqual([
      'accounting.record.update',
      'accounting.invoice_draft.create',
    ]);
  });
  it('keeps every field of accounting payments read only, including its reference', async () => {
    const f = fixture(rows[2]);
    for (const changes of [
      { reference: 'GENERATED' },
      { direction: 'incoming' },
      { amount: '100.10' },
      { currency: 'USD' },
      { paid_on: '2026-11-21' },
    ])
      await expect(
        f.connector.actions!.send(f.context, {
          ...f.request,
          payload: {
            record: {
              stream: 'accounting.payments',
              external_id: 'generated-payment',
              expected_version: '1',
            },
            changes,
          },
        }),
      ).rejects.toMatchObject({ code: 'PAYLOAD_CHANGED' });
    expect(f.adapter.opened()).toBe(0);
  });
  it('never rounds decimal source money and refuses a float', async () => {
    for (const total of ['100.10', 100.1]) {
      const f = fixture(rows[2], {
          streams: {
            'accounting.invoices': [
              {
                id: 'generated-invoice',
                version: '1',
                fields: { number: 'GENERATED', total },
                acl: [],
              },
            ],
          },
        }),
        read = () =>
          f.connector.sync!.readPage(f.context, {
            stream: 'accounting.invoices',
            cursor: null,
            fullSync: true,
            pageSize: 1,
          });
      if (typeof total === 'number') {
        await expect(read()).rejects.toMatchObject({ code: 'SYNC_PAGE_INVALID' });
        expect(f.stored).toEqual([]);
      } else {
        await read();
        expect(f.stored[0]!.records[0]!.fields.total).toBe('100.10');
      }
    }
  });
});
