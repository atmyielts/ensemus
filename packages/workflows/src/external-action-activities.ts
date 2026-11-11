// The Activities for one external action (ADR-027 D2). Only IDs, enums and counters go in or out: the payload
// stays in PostgreSQL and in this worker's memory. Provider text stops at the connector.
import {
  beginAttempt,
  beginReconcile,
  failUnsent,
  finishAttempt,
  finishReconcile,
  inspectInterrupted,
  readSettledOutcome,
  type ExternalActionGateway,
  type PreparedAttempt,
  type SecretLease,
} from '@ensemus/application';
import { NotSent, type ActionRequest, type Connector } from '@ensemus/connectors';
import { runReconcile, runSend } from '@ensemus/connectors/runtime';
import type { AppDatabase } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { toolManifest, type ToolConnectorType } from '@ensemus/domain/ai-tools';
import type { AttemptResult, ReconcileResult } from '@ensemus/domain/external-action';
import { createLogger, errorCode } from '@ensemus/telemetry';
import type { ConnectorActivityDeps } from './connector-deps';
import { retryDelayMs } from './external-action-step';
import type {
  ExternalActionInput,
  ExternalActionOutcome,
  InterruptedStep,
  ReconcileStepResult,
  SendStep,
} from './schemas';

const log = createLogger('external-action');

type ReconcileCode = 'WORKER_INTERRUPTED' | 'TIMEOUT_AFTER_COMMIT';

const context = (input: { organizationId: string }) => createServiceContext(input.organizationId);

/** Everything that only reads and writes PostgreSQL, whichever queue it runs on. */
function platformActivities(database: AppDatabase) {
  return {
    /** What to do after a send Activity failed or timed out. Safe to retry. */
    async inspectInterruptedAction(input: ExternalActionInput): Promise<InterruptedStep> {
      return inspectInterrupted(database, context(input), {
        externalActionId: input.externalActionId,
      });
    },
    /** Ends an intent that never got anywhere, with what was tried. Safe to retry. */
    async failUnsentAction(
      input: ExternalActionInput & { code: 'ATTEMPTS_EXHAUSTED' | 'CONNECTOR_UNAVAILABLE' },
    ): Promise<void> {
      await failUnsent(database, context(input), {
        externalActionId: input.externalActionId,
        code: input.code,
      });
    },
    /** What an intent ended as, for a workflow whose Activity did the work and lost the answer. */
    async settledActionOutcome(input: ExternalActionInput): Promise<ExternalActionOutcome> {
      return readSettledOutcome(database, context(input), {
        externalActionId: input.externalActionId,
      });
    },
    /**
     * For when reconciling never got to run, because no connector worker came back. The answer a provider
     * would have given is the one thing that is not known, so it ends where that leaves it: with a person.
     */
    async concludeWithoutAnswer(
      input: ExternalActionInput & { code: ReconcileCode },
    ): Promise<ReconcileStepResult> {
      return reconcile(database, input, async () => ({
        result: { answer: 'cannot_answer' },
        lookup: 'none',
      }));
    },
  };
}

/** Asks whatever `ask` asks, and stores what comes back. Each step on its own is safe to repeat. */
async function reconcile(
  database: AppDatabase,
  input: ExternalActionInput & { code: ReconcileCode },
  ask: (attempt: PreparedAttempt) => Promise<{
    result: ReconcileResult;
    lookup: 'none' | 'best_effort' | 'authoritative';
  }>,
): Promise<ReconcileStepResult> {
  const ctx = context(input);
  const prepared = await beginReconcile(database, ctx, {
    externalActionId: input.externalActionId,
    code: input.code,
  });
  if (prepared.kind === 'nothing_open') return 'retry';
  if (prepared.kind === 'settled') {
    // Nothing went out from a cancelled intent, which is all this answer says to the workflow.
    return prepared.status === 'cancelled' ? 'failed' : prepared.status;
  }
  const { result, lookup } = await ask(prepared.attempt);
  return finishReconcile(database, ctx, { attemptId: prepared.attempt.attemptId, result, lookup });
}

/** Reads PostgreSQL and contacts nobody, so it runs on the platform queue. */
export function createExternalActionPlatformActivities(deps: { database: AppDatabase }) {
  return platformActivities(deps.database);
}
export type ExternalActionPlatformActivities = ReturnType<
  typeof createExternalActionPlatformActivities
>;

/** The two that contact a provider, over whatever gateway they are given. */
function connectorActivities(database: AppDatabase, gateway: ExternalActionGateway) {
  return {
    /**
     * One recheck, one recorded attempt and one send. The workflow calls this with no retries: a lost
     * answer goes through inspectInterruptedAction, never through calling this again blind. If it is
     * called anyway, it finds the attempt and contacts nobody, and under that the trigger on the attempts
     * table refuses a second attempt that could send.
     */
    async sendExternalAction(input: ExternalActionInput & { runId: string }): Promise<SendStep> {
      const ctx = context(input);
      const begun = await beginAttempt(database, ctx, {
        externalActionId: input.externalActionId,
        runId: input.runId,
      });
      if (begun.kind === 'stop') return { step: begun.status };
      if (begun.kind === 'reconcile') return { step: 'reconcile' };

      let result: AttemptResult;
      try {
        result = await gateway.send(input.organizationId, begun.attempt);
      } catch (error) {
        // The attempt row is committed, so anything could have happened. ADR-027 D2: not thinking about
        // this has to come out as "may have sent", or a bug here could cause a second send.
        log.warn('external_action.send_threw', { errorCode: errorCode(error) });
        result = { outcome: 'indeterminate', code: 'CONNECTION_LOST_AFTER_COMMIT' };
      }

      const step = await finishAttempt(database, ctx, {
        attemptId: begun.attempt.attemptId,
        result,
      });
      switch (step) {
        case 'retry':
          return { step: 'retry', afterMs: retryDelayMs(begun.attempt.attemptNo) };
        case 'reconcile':
          return { step: 'reconcile' };
        default:
          return { step };
      }
    },
    /** Asks the provider. Read-only, retried freely, and sends nothing whatever it finds. */
    async reconcileExternalAction(
      input: ExternalActionInput & { code: ReconcileCode },
    ): Promise<ReconcileStepResult> {
      return reconcile(database, input, async (attempt) => {
        let result: ReconcileResult;
        try {
          result = await gateway.reconcile(input.organizationId, attempt);
        } catch (error) {
          log.warn('external_action.reconcile_threw', { errorCode: errorCode(error) });
          result = { answer: 'cannot_answer' };
        }
        return {
          result,
          lookup: gateway.lookupOf(attempt.connection.connectorType, attempt.toolName),
        };
      });
    },
  };
}

/**
 * A lease that can tell "the secret could not be opened", which means nothing was tried, from anything
 * after that, which proves nothing. Once the connector has held the secret, a failure here says nothing
 * about whether it sent, so it stays whatever it was and comes out as indeterminate.
 */
function leaseFor(
  secrets: SecretLease,
  organizationId: string,
  secretId: string | null,
  purpose: string,
) {
  return {
    async withCredential<T>(use: (secret: Buffer) => Promise<T>): Promise<T> {
      if (!secretId) throw new NotSent('CREDENTIAL_UNAVAILABLE', false);
      let used = false;
      try {
        return await secrets.withSecret({ organizationId, secretId, purpose }, (secret) => {
          used = true;
          return use(secret);
        });
      } catch (error) {
        if (used) throw error;
        log.warn('external_action.credential_unavailable', { errorCode: errorCode(error) });
        throw new NotSent('CREDENTIAL_UNAVAILABLE', false);
      }
    },
  };
}

const requestFor = (attempt: PreparedAttempt): ActionRequest => ({
  externalActionId: attempt.externalActionId,
  attemptId: attempt.attemptId,
  attemptNo: attempt.attemptNo,
  toolName: attempt.toolName,
  toolVersion: attempt.toolVersion,
  idempotencyKey: attempt.idempotencyKey,
  requestHash: attempt.requestHash,
  payload: attempt.payload,
});

/**
 * The real gateway: a connector from the explicit list, its settings checked, its credential only on
 * lease, and its way out only through the egress gateway. Anything stopping it before the connector runs
 * means nothing was contacted, so those are `not_sent`, and trying again would not help.
 */
export function createConnectorGateway(
  deps: ConnectorActivityDeps,
  /** Only a test changes this, so that a relay going quiet does not take the whole of runSend's minute. */
  options: { sendDeadlineMs?: number } = {},
): ExternalActionGateway {
  const unavailable: AttemptResult = {
    outcome: 'not_sent',
    code: 'CONNECTOR_UNAVAILABLE',
    retryable: false,
  };

  const callFor = (organizationId: string, attempt: PreparedAttempt) => {
    const connector = deps.registry.get(attempt.connection.connectorType);
    if (!connector?.actions) return null;
    // A connector performs only what its manifest says it can (ADR-038 D6). Anything else contacts nobody.
    if (!connector.manifest.capabilities.actions.includes(attempt.toolName)) return null;
    let config: unknown;
    try {
      config = connector.parseConfig(attempt.connection.config);
    } catch (error) {
      log.warn('external_action.config_refused', { errorCode: errorCode(error) });
      return null;
    }
    return {
      connector: connector as Connector,
      request: requestFor(attempt),
      context: {
        organizationId,
        connectionId: attempt.connection.id,
        config,
        credentials: leaseFor(
          deps.secrets,
          organizationId,
          attempt.connection.credentialSecretId,
          connector.manifest.credential.purpose,
        ),
        network: deps.network,
      },
    };
  };

  return {
    async send(organizationId, attempt) {
      const call = callFor(organizationId, attempt);
      if (!call) return unavailable;
      if (call.connector.manifest.credential.required && !attempt.connection.credentialSecretId) {
        return { outcome: 'not_sent', code: 'CREDENTIAL_UNAVAILABLE', retryable: false };
      }
      return runSend(
        options.sendDeadlineMs === undefined
          ? call
          : { ...call, deadlineMs: options.sendDeadlineMs },
      );
    },
    async reconcile(organizationId, attempt) {
      const call = callFor(organizationId, attempt);
      return call ? runReconcile(call) : { answer: 'cannot_answer' };
    },
    lookupOf(connectorType, toolName) {
      const manifest = deps.registry.get(connectorType)?.manifest;
      if (!manifest) return 'none';
      // The tool's own kind, for a tool this connector declares; the connector's otherwise, as before.
      const binding =
        toolName && manifest.capabilities.actions.includes(toolName)
          ? toolManifest(toolName)?.connection?.bindings[connectorType as ToolConnectorType]
          : undefined;
      return binding?.reconcile ?? manifest.capabilities.reconcile;
    },
  };
}

/** All of them over one gateway. Tests use this with a scripted provider. */
export function createExternalActionActivities(
  database: AppDatabase,
  gateway: ExternalActionGateway,
) {
  return { ...platformActivities(database), ...connectorActivities(database, gateway) };
}

/** These hold a credential, so they run on the connector queue. */
export function createExternalActionConnectorActivities(deps: ConnectorActivityDeps) {
  return connectorActivities(deps.database, createConnectorGateway(deps));
}
export type ExternalActionConnectorActivities = ReturnType<
  typeof createExternalActionConnectorActivities
>;
