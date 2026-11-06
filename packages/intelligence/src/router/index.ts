// The policy-first router (MODEL-03, COMM-02, threat SEC-004, ADR-028 FD-8, FD-9, FD-13). It chooses from what
// the tenant approved, by policy, and takes nothing a model said: `InferenceTask` has no field for that.
//
// Order: actor and class, candidates, capability, egress decision. One row per decision, written before the
// answer is returned, and a failed write throws, so nothing can leave unrecorded. These rows carry no step
// or request hash, because `select` is not told them. The gateway's own rows do.
import type {
  AgentContext,
  EgressLog,
  ProfileStore,
  RateCardRef,
  RoutableProfile,
} from '@ensemus/application/ai-ports';
import {
  CLASSIFICATIONS,
  MODEL_PURPOSES,
  type AiClassification,
  type AiReasonCode,
  type ModelPurpose,
} from '@ensemus/domain/ai';
import { decideEgress, type TenantPolicyBundle } from '@ensemus/policy';
import type { InferenceTask, ModelRouter, RouteDecision } from '../types';
import { egressFacts, hostOf } from './facts';

/** The version on a refusal the router made itself, before the matrix had anything to say. */
const ROUTER_POLICY_VERSION = 'router-1';

type Judged =
  | { ok: true; profile: RoutableProfile; rateCard: RateCardRef; policyVersion: string }
  | { ok: false; reasonCode: AiReasonCode; policyVersion: string };

const hasEvery = (profile: RoutableProfile, required: InferenceTask['required']) =>
  required.every((capability) => profile.capabilities.includes(capability));

/** For comparing two profiles only. No rate card sorts last, and the egress step then refuses it anyway. */
const rateSum = (card: RateCardRef | null) =>
  card === null ? Number.POSITIVE_INFINITY : card.inputMicrosPerMtok + card.outputMicrosPerMtok;

const byAlias = (a: RoutableProfile, b: RoutableProfile) =>
  a.alias.localeCompare(b.alias) || a.id.localeCompare(b.id);

export function createModelRouter(deps: {
  profiles: ProfileStore;
  egress: EgressLog;
  now?: () => Date;
  /**
   * The tenant's active tightening, from `loadTenantPolicyBundle`. Optional only so the matrix can be tried
   * alone: agent-worker must pass it, or a tenant's bundle is not applied.
   */
  bundle?: (context: AgentContext) => Promise<TenantPolicyBundle | null>;
}): ModelRouter {
  const now = deps.now ?? (() => new Date());

  return {
    async select(task, context): Promise<RouteDecision> {
      const known =
        CLASSIFICATIONS.includes(task.classification) && MODEL_PURPOSES.includes(task.purpose);
      // An unknown class is recorded as the strongest, since the table will not take a word it does not know.
      const dataClass: AiClassification = known ? task.classification : 'restricted';
      const purpose: ModelPurpose = known ? task.purpose : 'reason';

      const record = (
        profile: RoutableProfile | null,
        decision: 'allow' | 'deny',
        reasonCode: AiReasonCode,
        policyVersion: string,
      ) =>
        deps.egress.record(context, {
          runId: context.agentRunId,
          stepId: null,
          profileId: profile?.id ?? null,
          dataClass,
          purpose,
          destinationHost: profile ? hostOf(profile.endpointUrl) : null,
          decision,
          reasonCode,
          policyVersion,
          requestHash: null,
          expiresAt: null,
        });

      const refuse = async (
        profile: RoutableProfile | null,
        reasonCode: AiReasonCode,
        policyVersion = ROUTER_POLICY_VERSION,
      ): Promise<RouteDecision> => {
        await record(profile, 'deny', reasonCode, policyVersion);
        return { kind: 'denied', reasonCode, policyVersion };
      };

      // Class and actor. A run may only route for itself.
      if (!known || context.actorType !== 'agent' || context.agentRunId !== task.runId) {
        return refuse(null, 'UNKNOWN_INPUT');
      }

      let bundle: TenantPolicyBundle | null;
      try {
        bundle = deps.bundle ? await deps.bundle(context) : null;
      } catch {
        return refuse(null, 'POLICY_UNREADABLE');
      }

      /** The egress decision for one profile, and then its rate card: no price, no call. One row. */
      const judge = async (profile: RoutableProfile): Promise<Judged> => {
        const decision = decideEgress({
          dataClass,
          purpose,
          requiredRegion: task.requiredRegion,
          profile: egressFacts(profile),
          bundle,
          now: now(),
        });
        const { policyVersion } = decision;
        if (decision.decision === 'deny') {
          await record(profile, 'deny', decision.reasonCode, policyVersion);
          return { ok: false, reasonCode: decision.reasonCode, policyVersion };
        }
        const rateCard = await deps.profiles.latestRateCard(context, profile.id);
        if (rateCard === null) {
          await record(profile, 'deny', 'RATE_CARD_MISSING', policyVersion);
          return { ok: false, reasonCode: 'RATE_CARD_MISSING', policyVersion };
        }
        await record(profile, 'allow', 'ALLOWED', policyVersion);
        return { ok: true, profile, rateCard, policyVersion };
      };

      // A pinned run keeps its profile or stops. It never moves to another (FD-13), so no fallback either.
      if (task.pinned) {
        const profile = await deps.profiles.getProfile(context, task.pinned.profileId);
        // Not found here means gone, or another tenant's, which RLS shows the same way. No row can name it.
        if (!profile) return refuse(null, 'PROFILE_CHANGED');
        if (profile.version !== task.pinned.profileVersion) {
          return refuse(profile, 'PROFILE_CHANGED');
        }
        if (!hasEvery(profile, task.required)) return refuse(profile, 'CAPABILITY_MISSING');
        const judged = await judge(profile);
        if (!judged.ok) {
          return {
            kind: 'denied',
            reasonCode: judged.reasonCode,
            policyVersion: judged.policyVersion,
          };
        }
        return {
          kind: 'selected',
          profile: judged.profile,
          rateCard: judged.rateCard,
          fallbacks: [],
          policyVersion: judged.policyVersion,
        };
      }

      // Candidates. A customer who brought their own model is not moved onto Ensemus's bill by a cost
      // comparison or a policy refusal: that move needs a stored approval, on the explicit list below.
      const active = (await deps.profiles.listCandidates(context)).filter(
        (profile) => profile.status === 'active',
      );
      if (active.length === 0) return refuse(null, 'NO_CANDIDATE');
      const customerOwned = active.filter((profile) => profile.billingOwner === 'customer');
      const sameBill = customerOwned.length > 0 ? customerOwned : active;

      // Capability. A required capability is never dropped to make a profile fit.
      const capable = sameBill.filter((profile) => hasEvery(profile, task.required));
      if (capable.length === 0) return refuse(null, 'CAPABILITY_MISSING');

      // Profiles carry no quality rating in M4, so only `economy` changes the order. It compares only what
      // already got this far: cost picks among approved profiles and can never admit one.
      let ordered = [...capable].sort(byAlias);
      if (task.quality === 'economy') {
        const rates = new Map<string, number>();
        for (const profile of ordered) {
          rates.set(profile.id, rateSum(await deps.profiles.latestRateCard(context, profile.id)));
        }
        ordered = ordered.sort(
          (a, b) => (rates.get(a.id) ?? 0) - (rates.get(b.id) ?? 0) || byAlias(a, b),
        );
      }

      // Egress, in order, until one is allowed. Nothing has been sent yet, so this is no fallback.
      let primary: Extract<Judged, { ok: true }> | null = null;
      let firstRefusal: Extract<Judged, { ok: false }> | null = null;
      for (const profile of ordered) {
        const judged = await judge(profile);
        if (judged.ok) {
          primary = judged;
          break;
        }
        firstRefusal ??= judged;
      }
      if (!primary) {
        return {
          kind: 'denied',
          reasonCode: firstRefusal?.reasonCode ?? 'NO_CANDIDATE',
          policyVersion: firstRefusal?.policyVersion ?? ROUTER_POLICY_VERSION,
        };
      }

      // Fallback (FD-9): the explicit list, in order, each entry through the whole check again. The first
      // entry that fails ends the list, so a later one cannot be reached by going around a refusal.
      const fallbacks: { profile: RoutableProfile; rateCard: RateCardRef }[] = [];
      if (task.allowFallback) {
        const seen = new Set<string>([primary.profile.id]);
        for (const id of primary.profile.fallbackProfileIds) {
          const entry = seen.has(id) ? null : await deps.profiles.getProfile(context, id);
          seen.add(id);
          if (!entry) {
            await refuse(null, 'FALLBACK_NOT_ALLOWED');
            break;
          }
          const crossesBill = entry.billingOwner !== primary.profile.billingOwner;
          if (crossesBill && !primary.profile.crossBillingApproved) {
            await refuse(entry, 'BILLING_OWNER_CROSSED');
            break;
          }
          if (!hasEvery(entry, task.required)) {
            await refuse(entry, 'CAPABILITY_MISSING');
            break;
          }
          const judged = await judge(entry);
          if (!judged.ok) break;
          fallbacks.push({ profile: judged.profile, rateCard: judged.rateCard });
        }
      }

      return {
        kind: 'selected',
        profile: primary.profile,
        rateCard: primary.rateCard,
        fallbacks,
        policyVersion: primary.policyVersion,
      };
    },
  };
}
