// Owned by the invoicing slice (BILL-02, BILL-03). See docs/06-delivery/m8-slices.md and ADR-032 D2.
import type { AppDatabase, TenantContext, Tx } from '@ensemus/database';
import type { DraftInvoice } from '@ensemus/saas/invoice';
import type { UsageLedgerPort } from './ports';

export type InvoiceSummary = {
  id: string;
  invoiceNumber: number | null;
  kind: 'subscription' | 'top_up';
  status: string;
  currency: string;
  totalMicros: bigint;
  issuedAt: Date | null;
  dueAt: Date | null;
  paidAt: Date | null;
};

export type InvoiceDetail = InvoiceSummary & {
  subtotalMicros: bigint;
  taxMicros: bigint;
  minorUnitExponent: number | null;
  lines: readonly {
    lineNo: number;
    kind: string;
    meter: string | null;
    quantity: bigint | null;
    unit: string | null;
    unitPriceMicros: bigint | null;
    amountMicros: bigint;
  }[];
  version: number;
};

/** `billing.view`. A member without it gets the usual not found. */
export function listInvoices(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { after?: string; limit?: number },
): Promise<{ items: readonly InvoiceSummary[]; nextCursor: string | null }> {
  throw new Error('NOT_IMPLEMENTED');
}

export function getInvoice(
  _database: AppDatabase,
  _context: TenantContext,
  _invoiceId: string,
): Promise<InvoiceDetail> {
  throw new Error('NOT_IMPLEMENTED');
}

export type DueWork = {
  closedPeriods: number;
  draftedInvoices: number;
  refusedCode: string | null;
};

/**
 * Service only, from the billing cycle. For each period past its end: sums usage through the port, prices
 * the overage from the period's own card, and writes a draft. No approved card, a missing ledger, or a
 * missing tax treatment leaves the draft unwritten with `refusedCode`, audited once, and billing stops there
 * rather than sending anything wrong. A period that cannot be billed stays open and is tried again.
 */
export function draftDuePeriodInvoices(
  _database: AppDatabase,
  _context: TenantContext,
  _ports: { usage: UsageLedgerPort },
  _now: Date,
): Promise<DueWork> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Service only. Every draft waiting for tax, for the Activity that asks the port. IDs only. */
export function listDraftsNeedingTax(
  _database: AppDatabase,
  _context: TenantContext,
): Promise<readonly string[]> {
  throw new Error('NOT_IMPLEMENTED');
}

export type TaxQuestion = {
  invoiceId: string;
  treatmentId: string;
  treatment: 'provider_computed' | 'not_collected';
  input: import('@ensemus/saas/tax').TaxInput;
};

/** Service only. Null if the invoice is no longer a draft, or TAX_TREATMENT_MISSING if nothing is approved. */
export function loadTaxQuestion(
  _database: AppDatabase,
  _context: TenantContext,
  _invoiceId: string,
): Promise<TaxQuestion | null> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * Service only. Writes the tax, the bill-to snapshot, the next number and the due date, and opens the invoice
 * in one transaction, and emits INVOICE_ISSUED. A repeat finds it open and changes nothing. The due date
 * comes from the plan's `paymentTermsDays`, and a top-up falls due when issued.
 */
export function issueInvoice(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { invoiceId: string; tax: { taxMicros: bigint; providerRef: string | null } },
): Promise<'issued' | 'already_issued'> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Called by top-ups, in its transaction. One line, for what the person agreed to. */
export function createTopUpInvoiceInTx(
  _tx: Tx,
  _context: TenantContext,
  _input: { topUpId: string; rateCardId: string; draft: DraftInvoice },
): Promise<{ invoiceId: string }> {
  throw new Error('NOT_IMPLEMENTED');
}

/** `billing.manage`, with a code. Only an unpaid invoice with no live payment. It is kept, marked void. */
export function voidInvoice(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { invoiceId: string; reasonCode: string; expectedVersion: number },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}
