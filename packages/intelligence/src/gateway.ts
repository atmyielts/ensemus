// The last check before company data leaves (MODEL-03, SEC-01, COMM-02). The order of FD-8 lives in `turn`, top
// to bottom, so it can be read in one place and a test can stop it at each stage: a wrong order sends data
// and logs a denial afterwards. A denial reserves nothing and opens no key. No transaction is open across the
// model call. Nothing here logs: a provider's or a model's words stop at this function, as codes.
//
// Up to the model call, anything that fails stops the turn as a refusal. After it, a ledger write that fails
// throws, on purpose: the Activity retries, and `TurnStore.beginTurn` finds this attempt still in flight and
// charges it as an estimate (FD-12). Returning an outcome instead would lose what the call cost.
import { randomUUID } from 'node:crypto';
import type {
  AgentContext,
  EgressLog,
  Entitlements,
  HaltCheck,
  LedgerEntry,
  RateCardRef,
  Reservation,
  RoutableProfile,
  TurnStore,
  Tx,
  UsageLedger,
} from '@ensemus/application/ai-ports';
import {
  modelLedgerKey,
  type AiReasonCode,
  type ModelOutcome,
  type StopCode,
} from '@ensemus/domain/ai';
import {
  decideEgress,
  scanForSecrets,
  strongest,
  type ScanResult,
  type TenantPolicyBundle,
} from '@ensemus/policy';
import { checkEndpoint } from '@ensemus/policy/endpoint';
import { ceilingFor, costOf } from './router/cost';
import { egressFacts, hostOf, protocolOf } from './router/facts';
import { checkOutput, compileOutputSchema } from './router/output';
import type {
  AdapterFailure,
  AdapterResult,
  AdapterUsage,
  CompiledTurn,
  ContextMessage,
  CredentialLender,
  EndpointGuard,
  InferenceGateway,
  InferenceTask,
  ModelAdapter,
  ModelRouter,
  RouteDecision,
  TurnOutcome,
} from './types';
import type { MainModelAdmission } from '@ensemus/application/ai-model-admission';
import { generationRequestHash } from './adapters';
import { mainResultHash } from './main-input-snapshot';

export type GatewayDeps = {
  entitlements: Entitlements;
  ledger: UsageLedger;
  /** Runs its own short transaction for each reservation and settlement. */
  withTx: <T>(context: AgentContext, fn: (tx: Tx) => Promise<T>) => Promise<T>;
  router: ModelRouter;
  egress: EgressLog;
  guard: EndpointGuard;
  credentials: CredentialLender;
  adapter: ModelAdapter;
  turns: TurnStore;
  halt: HaltCheck;
  /** Actual run counters, complete prior-input class and current profile envelope, in the reservation Tx. */
  admitInTx?: (
    tx: Tx,
    context: AgentContext,
    input: MainModelAdmission,
  ) => Promise<AiReasonCode | null>;
  /** Actual validated response receipt. This never accepts provider text or model-selected refs. */
  receiveInputSnapshotInTx?: (
    tx: Tx,
    context: AgentContext,
    input: {
      snapshotId: string;
      writerToken: string;
      kind: 'final' | 'tool_call';
      toolId: string | null;
      payloadHash: string;
    },
  ) => Promise<void>;
  /** The operator's list, read by the caller. */
  privateEndpoints: readonly string[];
  /** Strings no output or prompt may hold, for this tenant. Empty is fine. */
  canaries: () => Promise<readonly string[]>;
  now?: () => Date;
  /**
   * The tenant's active tightening, for the decision after a scan hit. Pass the router's own. Optional only so
   * the matrix can be tried alone: agent-worker must pass it, or that decision skips a tenant's bundle.
   */
  bundle?: (context: AgentContext) => Promise<TenantPolicyBundle | null>;
};

/**
 * A fallback inside one attempt is a call of its own, and may be charged. The schema keys both a reservation
 * and a ledger row by attempt, so each entry of the list takes its own number, far above any real attempt.
 */
export const FALLBACK_ATTEMPT_STRIDE = 1_000;

/** Failures that mean this provider cannot answer right now, which is what a fallback list is for. */
const OUTAGES: ReadonlySet<AdapterFailure> = new Set<AdapterFailure>([
  'timeout',
  'rate_limited',
  'server_error',
  'auth_failed',
  'connect_failed',
  'endpoint_refused',
]);

const REFUSED_AS: Partial<Record<AiReasonCode, { outcome: ModelOutcome; stopCode: StopCode }>> = {
  ENTITLEMENT_DENIED: { outcome: 'policy_denied', stopCode: 'ENTITLEMENT_DENIED' },
  BUDGET_EXHAUSTED: { outcome: 'budget_exhausted', stopCode: 'BUDGET_EXHAUSTED' },
  BUDGET_NOT_CONFIGURED: { outcome: 'budget_exhausted', stopCode: 'BUDGET_NOT_CONFIGURED' },
  RATE_CARD_MISSING: { outcome: 'budget_exhausted', stopCode: 'RATE_CARD_MISSING' },
  PROFILE_CHANGED: { outcome: 'policy_denied', stopCode: 'PROFILE_CHANGED' },
  NO_CANDIDATE: { outcome: 'model_unavailable', stopCode: 'MODEL_UNAVAILABLE' },
  CAPABILITY_MISSING: { outcome: 'model_unavailable', stopCode: 'MODEL_UNAVAILABLE' },
  HALTED: { outcome: 'stopped', stopCode: 'HALTED' },
};

function failureOutcome(failure: AdapterFailure): { outcome: ModelOutcome; stopCode: StopCode } {
  if (failure === 'auth_failed') {
    return { outcome: 'credential_unavailable', stopCode: 'CREDENTIAL_UNAVAILABLE' };
  }
  if (failure === 'malformed_response' || failure === 'partial_response') {
    return { outcome: 'invalid_output', stopCode: 'INVALID_OUTPUT' };
  }
  return { outcome: 'model_unavailable', stopCode: 'MODEL_UNAVAILABLE' };
}

/** The class of a turn is the strongest of everything in it, and what it asks for is all it needs. */
function effectiveTask(compiled: CompiledTurn): InferenceTask {
  const classification = compiled.messages.reduce(
    (strongestSoFar, message) => strongest(strongestSoFar, message.classification),
    compiled.task.classification,
  );
  const required = new Set(compiled.task.required);
  if (compiled.tools.length > 0) required.add('tools');
  if (compiled.responseSchema) required.add('structured_output');
  return { ...compiled.task, classification, required: [...required] };
}

/** A throw from an adapter is a bug in it, so the call fails closed, and it may have cost something. */
async function callAdapter(
  adapter: ModelAdapter,
  call: Parameters<ModelAdapter['generate']>[0],
  signal: AbortSignal,
): Promise<AdapterResult> {
  try {
    return await adapter.generate(call, signal);
  } catch {
    return { kind: 'failure', failure: 'unknown', mayHaveBilled: true, usage: null };
  }
}

/** Marks a failed halt check, so it can roll the transaction back and still be told from anything else. */
class Halted extends Error {}
class AdmissionRefused extends Error {
  constructor(readonly code: AiReasonCode) {
    super(code);
  }
}

export function createInferenceGateway(deps: GatewayDeps): InferenceGateway {
  const now = deps.now ?? (() => new Date());

  return {
    async turn(context, step, compiled, signal) {
      const spent = { inputTokens: 0, outputTokens: 0, costMicros: 0 };
      let servedBy: { id: string; version: number } | null = null;
      let inputSnapshotId: string | undefined;

      const finish = (
        outcome: ModelOutcome,
        stopCode: StopCode | null,
        decisionCode: AiReasonCode | null,
        answer: Pick<TurnOutcome, 'text' | 'toolCall'> = { text: null, toolCall: null },
      ): TurnOutcome => ({
        outcome,
        stopCode,
        decisionCode,
        usage: { ...spent },
        profile: servedBy,
        ...(inputSnapshotId ? { inputSnapshotId } : {}),
        ...answer,
      });
      const refuse = (code: AiReasonCode) => {
        const { outcome, stopCode } = REFUSED_AS[code] ?? {
          outcome: 'policy_denied' as const,
          stopCode: 'POLICY_DENIED' as const,
        };
        return finish(outcome, stopCode, code);
      };
      // Whoever asked for the stop knows why, and the run's own directive says who that was.
      const stopped = () => finish('stopped', null, null);

      // Take the actual trusted request values before any asynchronous provider/credential work.
      // A caller retaining a messages/schema reference cannot change material after it was hashed.
      try {
        compiled = structuredClone(compiled);
      } catch {
        return refuse('POLICY_UNREADABLE');
      }

      if (signal.aborted) return stopped();

      // 1. Entitlement. A feature check only: everything below can still say no.
      let commercialMode: 'cloud' | 'byom' | 'sovereign';
      try {
        const entitlement = await deps.entitlements.check(context, 'model.call');
        if (!entitlement.ok) return refuse(entitlement.code);
        commercialMode = entitlement.commercialMode;
      } catch {
        return refuse('POLICY_UNREADABLE');
      }

      // 2. Headroom, read without holding anything. No budget means no run, and there is no default.
      try {
        const { availableMicros } = await deps.ledger.headroom(context, {
          runId: step.runId,
          agentVersionId: step.agentVersionId,
        });
        if (availableMicros === null) return refuse('BUDGET_NOT_CONFIGURED');
        if (availableMicros <= 0) return refuse('BUDGET_EXHAUSTED');
      } catch {
        return refuse('POLICY_UNREADABLE');
      }

      // 3 to 6. Actor and class, candidates, capability, egress decision. One recorded row per decision, and
      // a row that cannot be written stops the call here.
      const task = effectiveTask(compiled);
      let route: RouteDecision;
      try {
        route = await deps.router.select(task, context);
      } catch {
        return refuse('POLICY_UNREADABLE');
      }
      if (route.kind === 'denied') return refuse(route.reasonCode);

      const record = (
        profile: RoutableProfile,
        dataClass: InferenceTask['classification'],
        decision: 'allow' | 'deny',
        reasonCode: AiReasonCode,
        policyVersion: string,
      ) =>
        deps.egress.record(context, {
          runId: step.runId,
          stepId: step.stepId,
          profileId: profile.id,
          dataClass,
          purpose: task.purpose,
          destinationHost: hostOf(profile.endpointUrl),
          decision,
          reasonCode,
          policyVersion,
          requestHash: compiled.requestHash,
          expiresAt: null,
        });

      // A customer on their own model is not put on Ensemus's bill without a stored approval, even when
      // that is the only profile left active. This is the one check that needs the commercial mode.
      if (
        commercialMode !== 'cloud' &&
        route.profile.billingOwner === 'ensemus' &&
        !route.profile.crossBillingApproved
      ) {
        try {
          await record(
            route.profile,
            task.classification,
            'deny',
            'BILLING_OWNER_CROSSED',
            route.policyVersion,
          );
        } catch {
          return refuse('POLICY_UNREADABLE');
        }
        return refuse('BILLING_OWNER_CROSSED');
      }

      // A schema we cannot use stops the turn here, before anything is held or paid for.
      const schema = compileOutputSchema(compiled.responseSchema);
      if (!schema.ok) return finish('invalid_output', 'INVALID_OUTPUT', null);

      const chain: readonly { profile: RoutableProfile; rateCard: RateCardRef }[] = [
        { profile: route.profile, rateCard: route.rateCard },
        ...route.fallbacks,
      ];

      let scan: ScanResult | null = null;
      let canaries: readonly string[] = [];
      let messages: readonly ContextMessage[] = compiled.messages;
      let dataClass = task.classification;

      for (const [index, { profile, rateCard }] of chain.entries()) {
        if (signal.aborted) return stopped();
        const isLast = index === chain.length - 1;
        const callAttempt = step.attempt + index * FALLBACK_ATTEMPT_STRIDE;
        const maxOutputTokens = Math.min(compiled.maxOutputTokens, profile.limits.maxOutputTokens);
        const snapshot = {
          id: randomUUID(),
          writerToken: randomUUID(),
          requestHash: generationRequestHash({
            providerKind: profile.providerKind,
            modelId: profile.modelId,
            endpointUrl: profile.endpointUrl,
            messages,
            tools: compiled.tools,
            responseSchema: compiled.responseSchema,
            maxOutputTokens,
            timeoutMs: compiled.timeoutMs,
          }),
        };
        const ceiling = ceilingFor({
          messages,
          tools: compiled.tools,
          responseSchema: compiled.responseSchema,
          maxOutputTokens,
          modelId: profile.modelId,
        });
        const reservedMicros = costOf(ceiling, rateCard).totalMicros;
        if (ceiling.inputTokens > profile.limits.maxInputTokens) return refuse('BUDGET_EXHAUSTED');

        // 7. In one short transaction, halt check and reservation. A halt rolls the reservation back.
        let reservation: Reservation;
        try {
          reservation = await deps.withTx(context, async (tx) => {
            if (deps.admitInTx) {
              const denial = await deps.admitInTx(tx, context, {
                ...step,
                purpose: task.purpose,
                classification: dataClass,
                profileId: profile.id,
                profileVersion: profile.version,
                ceiling,
                costMicros: reservedMicros,
                priorUsage: { ...spent },
                reservationAttempt: callAttempt,
                snapshot: { ...snapshot, phase: 'prepare' },
              });
              if (denial) throw new AdmissionRefused(denial);
            }
            try {
              await deps.halt.assertRunning(tx, context, {
                agentVersionId: step.agentVersionId,
                providerKind: profile.providerKind,
              });
            } catch {
              throw new Halted();
            }
            return deps.ledger.reserve(tx, context, {
              runId: step.runId,
              stepId: step.stepId,
              attempt: callAttempt,
              agentVersionId: step.agentVersionId,
              amountMicros: reservedMicros,
            });
          });
        } catch (error) {
          return refuse(
            error instanceof AdmissionRefused
              ? error.code
              : error instanceof Halted
                ? 'HALTED'
                : 'POLICY_UNREADABLE',
          );
        }
        if (!reservation.ok) return refuse(reservation.code);
        const { reservationId } = reservation;

        // Nothing has been sent if we are here to release it. A release that fails leaves the hold in
        // place, which over-counts, so it must not hide the reason the turn stopped.
        const release = async () => {
          try {
            await deps.withTx(context, (tx) => deps.ledger.release(tx, context, reservationId));
          } catch {
            // See above.
          }
        };

        // 8. The pre-send scan. A hit raises that part to restricted, and the decision is made again on it.
        try {
          if (scan === null) {
            canaries = await deps.canaries();
            scan = scanForSecrets(
              messages.map((message) => ({ id: message.partId, text: message.text })),
              canaries,
            );
          }
          if (scan.hits.length > 0) {
            const decision = decideEgress({
              dataClass: 'restricted',
              purpose: task.purpose,
              requiredRegion: task.requiredRegion,
              profile: egressFacts(profile),
              bundle: deps.bundle ? await deps.bundle(context) : null,
              now: now(),
            });
            const allowed = decision.decision === 'allow';
            await record(
              profile,
              'restricted',
              decision.decision,
              allowed ? 'ALLOWED' : 'SECRET_FOUND_IN_PAYLOAD',
              decision.policyVersion,
            );
            if (!allowed) {
              await release();
              return refuse('SECRET_FOUND_IN_PAYLOAD');
            }
            dataClass = 'restricted';
            const hitParts = new Set(scan.hits.map((hit) => hit.partId));
            messages = messages.map((message) =>
              hitParts.has(message.partId)
                ? { ...message, classification: 'restricted' as const }
                : message,
            );
          }
        } catch {
          await release();
          return refuse('POLICY_UNREADABLE');
        }

        // 9. The endpoint, as it stands now. The profile row could have been changed since it was approved.
        const endpoint = checkEndpoint(profile.providerKind, profile.endpointUrl, {
          privateEndpoints: deps.privateEndpoints,
        });
        const protocol = protocolOf(profile.endpointUrl);
        let guardedFetch: typeof fetch | null = null;
        if (endpoint.ok && protocol !== null) {
          try {
            guardedFetch = deps.guard.fetchFor({
              host: endpoint.host,
              port: endpoint.port,
              protocol,
              viaPrivateAllowlist: endpoint.viaPrivateAllowlist,
            });
          } catch {
            // Refused below, the same as an address that failed the check.
          }
        }
        if (guardedFetch === null) {
          try {
            await record(profile, dataClass, 'deny', 'PROFILE_NOT_QUALIFIED', route.policyVersion);
          } catch {
            // Refused either way, and the refusal is what the outcome says.
          }
          await release();
          return refuse('PROFILE_NOT_QUALIFIED');
        }

        if (signal.aborted) {
          await release();
          return stopped();
        }

        // 10 and 11. The key, for this one call, and the call. No transaction is open here. Only a model the
        // customer runs may have no key: anywhere else, a missing key is no reason to send without one.
        const sent: { result: AdapterResult | null } = { result: null };
        const send = async (apiKey: Buffer | null) => {
          if (signal.aborted) throw new AdmissionRefused('HALTED');
          if (deps.admitInTx)
            await deps.withTx(context, async (tx) => {
              let denial: AiReasonCode | null;
              try {
                denial = await deps.admitInTx!(tx, context, {
                  ...step,
                  purpose: task.purpose,
                  classification: dataClass,
                  profileId: profile.id,
                  profileVersion: profile.version,
                  ceiling,
                  costMicros: reservedMicros,
                  priorUsage: { ...spent },
                  reservationAttempt: callAttempt,
                  snapshot: { ...snapshot, phase: 'dispatch' },
                });
              } catch {
                throw new AdmissionRefused('POLICY_UNREADABLE');
              }
              if (denial) throw new AdmissionRefused(denial);
              try {
                await deps.halt.assertRunning(tx, context, {
                  agentVersionId: step.agentVersionId,
                  providerKind: profile.providerKind,
                });
              } catch {
                throw new AdmissionRefused('HALTED');
              }
            });
          if (signal.aborted) throw new AdmissionRefused('HALTED');
          sent.result = await callAdapter(
            deps.adapter,
            {
              providerKind: profile.providerKind,
              modelId: profile.modelId,
              endpointUrl: profile.endpointUrl,
              messages,
              tools: compiled.tools,
              responseSchema: compiled.responseSchema,
              maxOutputTokens,
              timeoutMs: compiled.timeoutMs,
              fetch: guardedFetch,
              apiKey,
            },
            signal,
          );
        };
        let dispatchDenial: AiReasonCode | null = null;
        try {
          if (profile.secretRef !== null) {
            await deps.credentials.withKey(
              {
                organizationId: context.organizationId,
                profileId: profile.id,
                endpointUrl: profile.endpointUrl,
                secretRef: profile.secretRef,
                providerKind: profile.providerKind,
              },
              send,
            );
          } else if (profile.providerKind === 'local_openai_compatible') {
            await send(null);
          }
        } catch (error) {
          if (error instanceof AdmissionRefused) dispatchDenial = error.code;
          // Only the lender can land here, as `callAdapter` does not throw. If it threw after the call
          // came back, the answer stands, and the call is charged below.
        }

        const result = sent.result;
        if (result === null) {
          // Nothing was sent, so nothing is owed. No key text can reach this outcome.
          await release();
          if (dispatchDenial) return refuse(dispatchDenial);
          if (!isLast) continue;
          return finish('credential_unavailable', 'CREDENTIAL_UNAVAILABLE', null);
        }
        servedBy = { id: profile.id, version: profile.version };

        // What this call cost. Without a usage report it is charged at all it could have cost (FD-12).
        const charge = async (usage: AdapterUsage, estimatedWhenMissing: boolean) => {
          const measured = usage !== null;
          const tokens = usage ?? (estimatedWhenMissing ? ceiling : null);
          if (tokens === null) {
            await release();
            return;
          }
          // An estimate still retains BOTH admitted token ceilings and their pinned USD rates.
          // Putting all estimated USD on input used to hide the output meter from credit accounting.
          const cost = costOf(tokens, rateCard);
          const key = modelLedgerKey(step.runId, step.stepNumber, callAttempt);
          const row = {
            rateCardId: rateCard.id,
            rateCardVersion: rateCard.version,
            reservationId,
            workUnitId: step.workUnitId,
            runId: step.runId,
            stepId: step.stepId,
            profileId: profile.id,
            profileVersion: profile.version,
            providerKind: profile.providerKind,
            requestHash: compiled.requestHash,
            status: measured ? ('final' as const) : ('estimated' as const),
            unit: 'token' as const,
          } satisfies Partial<LedgerEntry>;
          await deps.withTx(context, async (tx) => {
            await deps.ledger.settle(tx, context, {
              reservationId,
              actualMicros: cost.totalMicros,
            });
            // The input row takes the plain key FD-12 names, so a retry's estimate for this same call
            // finds it and adds nothing. A later row in this transaction cannot exist without it.
            await deps.ledger.record(tx, context, {
              ...row,
              idempotencyKey: key,
              meter: 'model_input_tokens',
              quantity: tokens.inputTokens,
              costMicros: cost.inputMicros,
            });
            if (tokens.outputTokens > 0) {
              await deps.ledger.record(tx, context, {
                ...row,
                idempotencyKey: `${key}:output`,
                meter: 'model_output_tokens',
                quantity: tokens.outputTokens,
                costMicros: cost.outputMicros,
              });
            }
          });
          spent.inputTokens += tokens.inputTokens;
          spent.outputTokens += tokens.outputTokens;
          spent.costMicros += cost.totalMicros;
        };

        if (result.kind === 'failure') {
          await charge(result.usage, result.mayHaveBilled);
          if (result.failure === 'cancelled') return stopped();
          // 12. Fallback, FD-9: the next entry of the explicit list, already checked, and through every
          // stage above again. With no entry left this fails closed, on the customer's own terms.
          if (OUTAGES.has(result.failure)) {
            if (!isLast) continue;
            const { outcome, stopCode } = failureOutcome(result.failure);
            return finish(outcome, stopCode, 'FALLBACK_NOT_ALLOWED');
          }
          const { outcome, stopCode } = failureOutcome(result.failure);
          return finish(outcome, stopCode, null);
        }

        // 12. Validate what came back. An answer we cannot use was still paid for, so it is charged too.
        const check = checkOutput(result, compiled.tools, schema.schema, canaries);
        await charge(result.usage, true);
        // Reported provider overuse is charged in full, then refused. An admitted ceiling cannot be
        // expanded by a response, even if its text/schema is otherwise valid.
        if (
          result.usage &&
          (result.usage.inputTokens > ceiling.inputTokens ||
            result.usage.outputTokens > ceiling.outputTokens)
        )
          return refuse('BUDGET_EXHAUSTED');

        // The first answer pins the run to this profile and version (FD-13). If that is refused, another
        // turn got there first with a different profile, and this answer must not be acted on.
        if (compiled.task.pinned === null) {
          try {
            await deps.turns.bindProfile(context, {
              runId: step.runId,
              profileId: profile.id,
              profileVersion: profile.version,
            });
          } catch {
            return refuse('PROFILE_CHANGED');
          }
        }

        if (!check.ok) return finish('invalid_output', 'INVALID_OUTPUT', check.decisionCode);
        if (deps.receiveInputSnapshotInTx) {
          // Accounting has already committed. A receipt failure discards content, never releases a
          // paid hold or retries the provider. The original attempt remains unavailable to children.
          await deps.withTx(context, (tx) =>
            deps.receiveInputSnapshotInTx!(tx, context, {
              snapshotId: snapshot.id,
              writerToken: snapshot.writerToken,
              ...mainResultHash(result),
            }),
          );
          inputSnapshotId = snapshot.id;
        }
        if (result.kind === 'tool_call') {
          return finish('tool_proposed', null, 'ALLOWED', {
            text: null,
            toolCall: { toolId: result.toolId, args: result.args },
          });
        }
        return finish('final_output', null, 'ALLOWED', { text: result.text, toolCall: null });
      }

      // The chain always has one entry, and each pass through it returns or moves to the next.
      return refuse('NO_CANDIDATE');
    },
  };
}
