// COMM-06: what the parity suite needs from work other milestones own, and nothing more. Scenarios are
// written against these now, while M4 to M8 are still being built. tests/parity/wiring.ts plugs in the
// real thing once those branches are merged (slice parity-wiring).
//
// An unplugged seam makes its scenario "blocked", which the gate reports as not proven. It can never
// make one pass, so nothing here is a stand-in for the product. Whatever a seam talks to on the far side
// (a provider, a mail server) is a local fake that lives with the tests and uses generated values only.
import type { Person } from '../helpers/forms';

export interface ParityTenant {
  readonly organization: string;
  readonly owner: Person;
}

export type ModelBehaviour = 'answers' | 'refuses' | 'unreachable';
export type DataClass = 'internal' | 'restricted';

export type ModelCallResult =
  | { readonly result: 'answered' }
  /** The same reason code in every mode. No provider or body text belongs here. */
  | { readonly result: 'denied'; readonly code: string };

/** Owned by M4: `MODEL-01`, `MODEL-02`, `MODEL-03`, `COMM-02`, `SEC-01`. */
export interface ModelSupplySeam {
  /**
   * Sets this tenant up the way its mode does, through the product's own path, pointed at a local fake
   * that behaves as asked. Cloud uses an Ensemus-managed profile. BYOM and Sovereign use a customer
   * provider, with a generated key.
   */
  arrange(tenant: ParityTenant, behaviour: ModelBehaviour): Promise<void>;
  /** One model call through the real gateway, for work of this data class. */
  invoke(
    tenant: ParityTenant,
    call: { readonly dataClass: DataClass; readonly purpose: 'chat' | 'embedding' },
  ): Promise<ModelCallResult>;
  /** How many calls reached the local fake. A denied call must leave this unchanged. */
  callsReceived(): Promise<number>;
  /** Which supplier the router really chose, as named in MODE_CONTRACT.model_supply. */
  supplierUsed(tenant: ParityTenant): Promise<'ensemus_providers' | 'customer_providers'>;
  /** Changes the customer's key mid-run. Throws for Cloud, which has no customer key. */
  rotateCustomerKey(tenant: ParityTenant): Promise<void>;
  /** Whether a generated key shows up anywhere a member of the organization can read. */
  customerKeyVisibleToMembers(tenant: ParityTenant): Promise<boolean>;
}

export type RunEnd = 'completed' | 'stopped' | 'budget_exceeded' | 'denied';

/** Owned by M4: `AGENT-01`, `AGENT-02`, `AGENT-05`, `SEC-06`. */
export interface AgentRunSeam {
  /** Publishes a manifest. Returns the code it was refused with, or null when it was accepted. */
  publishManifest(tenant: ParityTenant, manifest: unknown): Promise<string | null>;
  runOverBudget(tenant: ParityTenant): Promise<{ readonly end: RunEnd; readonly code: string }>;
  delegateBeyondParent(
    tenant: ParityTenant,
  ): Promise<{ readonly end: RunEnd; readonly code: string }>;
  emergencyStop(
    tenant: ParityTenant,
  ): Promise<{ readonly queued: RunEnd; readonly running: RunEnd }>;
}

/** Owned by M5: `KNOW-01`, `KNOW-02`, `KNOW-04`, `KNOW-05`. */
export interface KnowledgeSeam {
  ingest(tenant: ParityTenant, text: string): Promise<{ readonly source: string }>;
  /** Whether a search by this person finds that source right now. */
  serves(tenant: ParityTenant, person: Person, source: string): Promise<boolean>;
  revoke(tenant: ParityTenant, person: Person, source: string): Promise<void>;
  /** The trust state of a fact that conflicts with an authoritative record. */
  conflictingFactState(tenant: ParityTenant): Promise<string>;
}

/** Owned by M6: `COMM-05`. */
export interface PortabilitySeam {
  /** A path to the archive, and counts by record type. */
  exportOrganization(
    tenant: ParityTenant,
  ): Promise<{ readonly archive: string; readonly counts: Readonly<Record<string, number>> }>;
  /** Imports into a new organization, and the same counts as read back from there. */
  importOrganization(archive: string): Promise<Readonly<Record<string, number>>>;
  /** Whether the archive holds this exact value anywhere. */
  archiveContains(archive: string, value: string): Promise<boolean>;
}

/** Owned by M6: `COMM-03`, `COMM-04`, `SOV-03`, `OPS-11`, and by M8: `COMM-01`, `BILL-05`. */
export interface EntitlementSeam {
  /** Sovereign: installs a license signed with a key generated for the test. */
  installLicense(): Promise<void>;
  /** Sovereign: moves the maintenance end into the past, as the isolated acceptance test does. */
  lapseMaintenance(): Promise<void>;
  /** Sovereign: what the license check reported, and whether it needed anything outside the network. */
  licenseCheck(): Promise<{ readonly valid: boolean; readonly outsideContact: boolean }>;
  /** Sovereign: verifies a bundle offline. `tampered` changes one byte first, `unsigned` drops its signature. */
  verifyBundle(variant: 'intact' | 'tampered' | 'unsigned'): Promise<'accepted' | 'refused'>;
  /** Cloud: uses up this tenant's included model capacity. */
  exhaustAllowance(tenant: ParityTenant): Promise<void>;
  /** Cloud: what a model call does then, and whether anything was charged without asking. */
  afterExhaustion(
    tenant: ParityTenant,
  ): Promise<{ readonly run: 'paused' | 'continued'; readonly chargedWithoutAsking: boolean }>;
  /** Who was charged for inference in this tenant, as named in MODE_CONTRACT.inference_billing. */
  inferenceBilledTo(tenant: ParityTenant): Promise<'ensemus' | 'customer_direct'>;
}

/** Owned by M3: `WORK-08`, `CONNECT-01`, `CONNECT-02`, with a local fake mail server. */
export interface ExternalActionSeam {
  /** Takes an email to approved and sends it, with the fake server behaving as asked. */
  sendApproved(
    tenant: ParityTenant,
    behaviour: 'accepts' | 'accepts_then_times_out',
  ): Promise<{ readonly status: string; readonly effects: number }>;
  /** Changes the recipients after approval, and returns the approval's state and what was sent. */
  changeRecipientAfterApproval(
    tenant: ParityTenant,
  ): Promise<{ readonly approval: string; readonly effects: number }>;
  /** Delivers one signed webhook twice. Returns how many effects came of it. */
  replayWebhook(
    tenant: ParityTenant,
  ): Promise<{ readonly accepted: number; readonly effects: number }>;
}

/** Owned by M6 `SEC-05`, with the air-gap gate's rules: what left the deployment during the round. */
export interface OutboundSeam {
  attemptsDuringRound(): Promise<number>;
}

export interface ParitySeams {
  readonly modelSupply: ModelSupplySeam;
  readonly agentRuns: AgentRunSeam;
  readonly knowledge: KnowledgeSeam;
  readonly portability: PortabilitySeam;
  readonly entitlement: EntitlementSeam;
  readonly externalActions: ExternalActionSeam;
  readonly outbound: OutboundSeam;
}

export const SEAM_OWNERS: Readonly<Record<keyof ParitySeams, string>> = {
  modelSupply: 'M4: MODEL-01, MODEL-02, MODEL-03, COMM-02, SEC-01',
  agentRuns: 'M4: AGENT-01, AGENT-02, AGENT-05, SEC-06',
  knowledge: 'M5: KNOW-01, KNOW-02, KNOW-04, KNOW-05',
  portability: 'M6: COMM-05',
  entitlement: 'M6: COMM-03, COMM-04, SOV-03, OPS-11; M8: COMM-01, BILL-05',
  externalActions: 'M3: WORK-08, CONNECT-01, CONNECT-02',
  outbound: 'M6: SEC-05',
};

/** A scenario needs a seam nobody has plugged in yet. The harness records this as blocked. */
export class SeamNotWired extends Error {
  override name = 'SeamNotWired';
  readonly seam: keyof ParitySeams;

  constructor(seam: keyof ParitySeams) {
    super(`The ${seam} seam is not wired yet (${SEAM_OWNERS[seam]}).`);
    this.seam = seam;
  }
}

export function seamFrom<K extends keyof ParitySeams>(
  wiring: Partial<ParitySeams>,
  name: K,
): ParitySeams[K] {
  const seam = wiring[name];
  if (!seam) throw new SeamNotWired(name);
  return seam as ParitySeams[K];
}
