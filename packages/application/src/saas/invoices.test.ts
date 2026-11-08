import { randomUUID } from 'node:crypto';
import type { AppDatabase, TenantContext, Tx } from '@ensemus/database';
import { describe, it, expect, vi } from 'vitest';
import {
  createTopUpInvoiceInTx,
  draftDuePeriodInvoices,
  getInvoice,
  issueInvoice,
  listDraftsNeedingTax,
  listInvoices,
  loadTaxQuestion,
  voidInvoice,
} from './invoices';
const context = {
  actorType: 'user',
  role: 'member',
  organizationId: randomUUID(),
  membershipId: randomUUID(),
  userId: randomUUID(),
} as TenantContext;
const transaction = vi.fn();
const database = { transaction } as unknown as AppDatabase;
const tx = {} as Tx;
const invoiceId = randomUUID();
describe('invoice authority is checked before opening a transaction', () => {
  it.each([
    ['list', () => listInvoices(database, context, {})],
    ['detail', () => getInvoice(database, context, invoiceId)],
    [
      'draft',
      () =>
        draftDuePeriodInvoices(
          database,
          context,
          {
            usage: {
              listSince: async () => ({ entries: [], nextCursor: null }),
              sumForPeriod: async () => [],
            },
          },
          new Date(),
        ),
    ],
    ['tax list', () => listDraftsNeedingTax(database, context)],
    ['tax question', () => loadTaxQuestion(database, context, invoiceId)],
    [
      'issue',
      () =>
        issueInvoice(database, context, { invoiceId, tax: { taxMicros: 0n, providerRef: null } }),
    ],
    [
      'void',
      () =>
        voidInvoice(database, context, { invoiceId, reasonCode: 'TEST_VOID', expectedVersion: 1 }),
    ],
    [
      'top-up invoice',
      () =>
        createTopUpInvoiceInTx(tx, context, {
          topUpId: randomUUID(),
          rateCardId: randomUUID(),
          draft: { currency: 'XTS', lines: [], subtotalMicros: 0n, taxMicros: 0n, totalMicros: 0n },
        }),
    ],
  ] as const)('member %s returns not found', async (_label, call) => {
    await expect(call()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(transaction).not.toHaveBeenCalled();
  });
});
