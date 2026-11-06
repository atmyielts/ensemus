// The decision contracts every caller and every test agrees on. See ADR-028 FD-8, FD-9, FD-14 and G7.
import type {
  AiClassification,
  AiReasonCode,
  BillingOwner,
  EgressDestination,
  ModelPurpose,
  RetentionBasis,
} from '@ensemus/domain/ai';
import type { ToolClass } from '@ensemus/domain/ai-tools';

/** The profile facts egress depends on. Never a key, and never anything a model said. */
export type EgressProfileFacts = {
  id: string;
  version: number;
  active: boolean;
  destination: EgressDestination;
  destinationHost: string;
  billingOwner: BillingOwner;
  region: string | null;
  allowedClasses: readonly AiClassification[];
  allowedPurposes: readonly ModelPurpose[];
  retentionBasis: RetentionBasis;
  contractRef: string | null;
};

/** Tightening only (FD-8, S1). `decideEgress` ignores anything here that would loosen the default. */
export type TenantPolicyBundle = {
  version: string;
  /** Classes this tenant refuses to send to each destination, on top of the default matrix. */
  denyClasses?: Partial<Record<EgressDestination, readonly AiClassification[]>>;
  /** If set, only these regions. */
  allowedRegions?: readonly string[];
};

export type EgressInput = {
  dataClass: AiClassification;
  purpose: ModelPurpose;
  /** A region this data must stay in, or null when none is required. */
  requiredRegion: string | null;
  profile: EgressProfileFacts;
  bundle: TenantPolicyBundle | null;
  now: Date;
};

export type EgressObligation = 'scan_before_send';

export type EgressDecision = {
  decision: 'allow' | 'deny';
  reasonCode: AiReasonCode;
  policyVersion: string;
  expiresAt: Date | null;
  obligations: readonly EgressObligation[];
};

export type ActionInput = {
  toolId: string;
  toolClass: ToolClass | null;
  /** The manifest's `allow` and `deny`, and the run's delegated scopes. */
  allow: readonly string[];
  deny: readonly string[];
  delegated: readonly string[];
  dataClass: AiClassification;
  /** The destructive and financial flags a future tool could carry. Denied by default. */
  destructive: boolean;
  requiresApproval: boolean;
};

export type ActionDecision = {
  decision: 'allow' | 'deny' | 'require_approval';
  reasonCode: AiReasonCode;
};

export type ContentPart = { id: string; text: string };

export const SECRET_CODES = [
  'PEM_BLOCK',
  'API_KEY_SHAPE',
  'BEARER_TOKEN_SHAPE',
  'CLOUD_KEY_SHAPE',
  'TENANT_CANARY',
] as const;
export type SecretCode = (typeof SECRET_CODES)[number];

/** Part IDs and codes. Never the matched text: a scan result is safe to log and to store. */
export type ScanResult = {
  hits: readonly { partId: string; code: SecretCode }[];
};
