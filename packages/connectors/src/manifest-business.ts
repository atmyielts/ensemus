// What the business connectors say they can do (ADR-033 D2), for pages that show what can be connected. Plain
// data with no I/O, and the one other file in this package the web tier may import. Literals rather than the
// domain's constants, so a page importing this pulls in nothing else. A test holds them equal to
// BUSINESS_STREAMS and BUSINESS_TOOLS, and the conformance suite holds each connector to its entry.
//
// The final merge adds these to CONNECTOR_MANIFESTS in ./manifest.ts, and to SHIPPED_CONNECTOR_RULES in
// @ensemus/domain/connector, both of which arrive with m3-sdk. See docs/06-delivery/m11a-slices.md.
import type { ConnectorManifest } from './manifest';

const common = {
  version: '1',
  credential: { required: true, purpose: 'connector_credential' },
} as const;

const adapterCapabilities = {
  // A lookup that finds an operation is believed. One that does not find it proves nothing, since a real
  // system may be slow to show it, so it stays with a person (ADR-027 D2).
  reconcile: 'best_effort',
  nativeIdempotency: true,
  aclMapping: true,
  webhooks: { scheme: 'ensemus_hmac_sha256_v1' },
  network: 'egress_gateway',
} as const;

export const CRM_CONNECTOR_MANIFEST: ConnectorManifest = {
  ...common,
  type: 'crm_http',
  displayName: 'CRM (adapter)',
  capabilities: {
    ...adapterCapabilities,
    actions: ['crm.record.update'],
    sync: { streams: ['crm.accounts', 'crm.contacts', 'crm.deals'], pageSize: 200 },
  },
};

export const TICKETING_CONNECTOR_MANIFEST: ConnectorManifest = {
  ...common,
  type: 'ticketing_http',
  displayName: 'Ticketing (adapter)',
  capabilities: {
    ...adapterCapabilities,
    actions: ['ticketing.record.update', 'ticketing.comment.add'],
    sync: { streams: ['ticketing.tickets', 'ticketing.comments'], pageSize: 200 },
  },
};

export const ACCOUNTING_CONNECTOR_MANIFEST: ConnectorManifest = {
  ...common,
  type: 'accounting_http',
  displayName: 'Accounting (adapter)',
  capabilities: {
    ...adapterCapabilities,
    actions: ['accounting.record.update', 'accounting.invoice_draft.create'],
    sync: {
      streams: ['accounting.invoices', 'accounting.bills', 'accounting.payments'],
      pageSize: 200,
    },
  },
};

/** Reads titles and permissions only, and reads a note's text on request, after consent (ADR-033 D5). */
export const MEETING_NOTES_CONNECTOR_MANIFEST: ConnectorManifest = {
  ...common,
  type: 'meeting_notes_http',
  displayName: 'Meeting notes (adapter)',
  capabilities: {
    actions: [],
    reconcile: 'none',
    nativeIdempotency: false,
    sync: { streams: ['meetings.notes'], pageSize: 100 },
    aclMapping: true,
    webhooks: null,
    network: 'egress_gateway',
  },
};

export const BUSINESS_CONNECTOR_MANIFESTS: readonly ConnectorManifest[] = [
  CRM_CONNECTOR_MANIFEST,
  TICKETING_CONNECTOR_MANIFEST,
  ACCOUNTING_CONNECTOR_MANIFEST,
  MEETING_NOTES_CONNECTOR_MANIFEST,
];
