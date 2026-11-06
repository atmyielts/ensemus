// Ports for skills, sandbox runs and the marketplace (ADR-034 D8). Application services name what they need,
// and something else supplies it. Three of these belong to milestones being built alongside this one, and
// their code implements them at the final merge. Until then, each one's absence refuses rather than allows.
import type { TenantContext, Tx } from '@ensemus/database';

export type SkillFeature = 'skill_catalog' | 'sandbox' | 'marketplace';

/**
 * Whether a tenant may use a feature. M8 owns entitlements, and at the final merge wires its own check in
 * alongside the deployment's switches below. Both have to say yes: an entitlement cannot turn on a sandbox
 * an operator has not provisioned.
 */
export interface SkillFeatureGate {
  isEnabled(context: TenantContext, feature: SkillFeature): Promise<boolean>;
}

/** What a deployment's operator switched on. Off by default, and the honest answer until M8 lands. */
export function deploymentFeatureGate(switches: Readonly<Record<SkillFeature, boolean>>) {
  return {
    isEnabled: async (_context: TenantContext, feature: SkillFeature) => switches[feature],
  } satisfies SkillFeatureGate;
}

/**
 * Whether the agent run asking for a sandbox run may still act. M4 owns agent runs (AGENT-02, AGENT-03),
 * and its stop check implements this at the final merge. A request that names an agent run while nothing
 * implements this is refused with AGENT_LINK_UNAVAILABLE, so nothing runs for an agent nobody can stop.
 */
export interface AgentRunGuard {
  sandboxRunAllowed(
    tx: Tx,
    context: TenantContext,
    link: { agentRunId: string; executionStepId: string },
  ): Promise<'allowed' | 'stopped'>;
}

/**
 * The public keys whose signatures can make a listing installable on this deployment. An operator's
 * configuration, read at start. None by default, which means nothing can be installed. Never in the
 * database, so writing a row cannot add a key (ADR-034 D5).
 */
export type MarketplaceReviewKeys = ReadonlyMap<string, Buffer>;

/** Reasons a package's content cannot be read right now. The bytes are never quoted. */
export type BundleReadFailure = 'BUNDLE_UNAVAILABLE' | 'BUNDLE_HASH_MISMATCH';

/** What SQL raises, so a service can turn a refused write into the right AppError. See migration 0651. */
export const SKILL_SQLSTATE = {
  INVALID_TRANSITION: 'ES001',
  IMMUTABLE: 'ES002',
  NOT_USABLE: 'ES003',
  COPY_MISMATCH: 'ES004',
  REVIEW_GATE: 'ES005',
} as const;
