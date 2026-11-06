// COMM-06: the differences between modes that the commercial contract allows, and nothing else. It is
// the machine form of docs/01-product/05-commercial-modes.md and docs/07-commercial/04-deployment-and-
// support-matrix.md. The parity contract there allows differences "only in hosting, local provider
// availability, external integrations, licensing/billing and support", so each dimension must name
// which of those it falls under. A difference that fits none of them is a parity failure, not a new row.
//
// A value here says who does what. It holds no price, no allowance and no service level, because those
// are the owner's decisions (delivery plan, "Decisions only you can make").
import type { CommercialMode } from './rules';

export const ALLOWED_DIFFERENCES = [
  'hosting',
  'local provider availability',
  'external integrations',
  'licensing and billing',
  'support',
] as const;
export type AllowedDifference = (typeof ALLOWED_DIFFERENCES)[number];

export interface ContractDimension {
  readonly allowedAs: AllowedDifference;
  /** The row of the matrix in the docs this comes from, kept verbatim so a test can find it. */
  readonly source: {
    readonly doc:
      | 'docs/01-product/05-commercial-modes.md'
      | 'docs/07-commercial/04-deployment-and-support-matrix.md';
    readonly row: string;
  };
  readonly expected: Readonly<Record<CommercialMode, string>>;
}

const MODES_DOC = 'docs/01-product/05-commercial-modes.md';
const MATRIX_DOC = 'docs/07-commercial/04-deployment-and-support-matrix.md';

export const MODE_CONTRACT = {
  model_supply: {
    allowedAs: 'local provider availability',
    source: { doc: MODES_DOC, row: 'Model routing' },
    expected: {
      cloud: 'ensemus_providers',
      byom: 'customer_providers',
      sovereign: 'customer_providers',
    },
  },
  inference_billing: {
    allowedAs: 'licensing and billing',
    source: { doc: MODES_DOC, row: 'External AI inference bills' },
    expected: { cloud: 'ensemus', byom: 'customer_direct', sovereign: 'customer_direct' },
  },
  recurring_platform_license: {
    allowedAs: 'licensing and billing',
    source: { doc: MODES_DOC, row: 'Platform recurring license' },
    expected: { cloud: 'yes', byom: 'yes', sovereign: 'no' },
  },
  hosting_owner: {
    allowedAs: 'hosting',
    source: { doc: MODES_DOC, row: 'Hosting ownership' },
    expected: { cloud: 'ensemus', byom: 'ensemus', sovereign: 'customer' },
  },
  offline_operation: {
    allowedAs: 'hosting',
    source: { doc: MODES_DOC, row: 'Offline operation' },
    expected: { cloud: 'no', byom: 'no', sovereign: 'supported_profile' },
  },
  vendor_telemetry: {
    allowedAs: 'hosting',
    source: { doc: MODES_DOC, row: 'Vendor telemetry' },
    expected: { cloud: 'minimal', byom: 'minimal', sovereign: 'off_by_default' },
  },
  updates: {
    allowedAs: 'support',
    source: { doc: MODES_DOC, row: 'Updates' },
    expected: { cloud: 'ensemus_managed', byom: 'ensemus_managed', sovereign: 'self_applied' },
  },
  license_validation: {
    allowedAs: 'licensing and billing',
    source: { doc: MATRIX_DOC, row: 'License validation' },
    expected: { cloud: 'online_service', byom: 'online_service', sovereign: 'offline_certificate' },
  },
  maintenance_lapse: {
    allowedAs: 'support',
    source: { doc: MATRIX_DOC, row: 'Continued use if maintenance ends' },
    expected: {
      cloud: 'subscription_terms',
      byom: 'subscription_terms',
      sovereign: 'continues_operating',
    },
  },
  responsibility_statement: {
    allowedAs: 'hosting',
    source: { doc: MATRIX_DOC, row: 'Holds business records' },
    expected: { cloud: 'ensemus_hosted', byom: 'ensemus_hosted', sovereign: 'customer_controlled' },
  },
} as const satisfies Record<string, ContractDimension>;

export type ContractDimensionName = keyof typeof MODE_CONTRACT;

/** The one value a mode_contract scenario must observe, so it cannot quietly pick its own. */
export const expectedFor = (dimension: ContractDimensionName, mode: CommercialMode): string =>
  MODE_CONTRACT[dimension].expected[mode];
