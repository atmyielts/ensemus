// Runtime calls are on the dedicated queue. PostgreSQL and object storage never travel in workflow payloads.
import { createHash, randomUUID } from 'node:crypto';
import { createSandboxWorkerControl } from '@ensemus/application/sandbox-worker-control';
import { canonicalJson } from '@ensemus/domain/approval';
import {
  isSettledSandboxRun,
  SandboxRunnerUnavailable,
  type SandboxRunStatus,
} from '@ensemus/domain/sandbox';
import { SKILL_BUNDLE_MAX_BYTES } from '@ensemus/domain/skill';
import { matchesSkillSchema, parseSkillBundle } from '@ensemus/skills/bundle';
import { keyIdOf, verifySkillSignature } from '@ensemus/skills/signature';
import { Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import type { SandboxExecuteStep, SandboxRunInput, SandboxRunOutcome } from './schemas';
import { sandboxRunInputSchema } from './schemas';
import type { SandboxActivityDeps, SkillActivityDeps } from './skill-deps';

const waitForCapacity = { step: 'busy', afterMs: 1000 } as const;
const retryRunner = { step: 'retry', afterMs: 1000 } as const;
const decoder = new TextDecoder('utf-8', { fatal: true });
const safeFailure = () =>
  ApplicationFailure.retryable('Sandbox storage unavailable', 'SANDBOX_STORAGE_UNAVAILABLE');

function settled(status: SandboxRunStatus): SandboxRunOutcome {
  if (status === 'running' || status === 'queued') throw safeFailure();
  return status;
}

function stepFrom(status: SandboxRunStatus): SandboxExecuteStep {
  if (status === 'running') return waitForCapacity;
  if (status === 'queued') return retryRunner;
  return { step: 'settled', outcome: status };
}

/** One attempt, with a committed native lease, a fresh passing report and verified bytes. */
export function createSandboxRunActivities(deps: SandboxActivityDeps) {
  return {
    async executeSandboxRun(raw: SandboxRunInput): Promise<SandboxExecuteStep> {
      const input = sandboxRunInputSchema.parse(raw);
      const { organizationId, sandboxRunId } = input;
      const activity = Context.current();
      const heartbeat = setInterval(() => activity.heartbeat(), 1000);
      heartbeat.unref();
      try {
        const current = await deps.control.read(organizationId, sandboxRunId);
        if (isSettledSandboxRun(current.status)) return stepFrom(current.status);
        const enabled = await deps.control.allows(organizationId, deps.gate);
        let report = null;
        if (enabled) {
          try {
            report = await deps.runner.probe(activity.cancellationSignal);
          } catch (error) {
            if (!(error instanceof SandboxRunnerUnavailable)) throw error;
            return stepFrom(
              await deps.control.abandon(organizationId, {
                sandboxRunId,
                code: error.code,
              }),
            );
          }
        }
        const begin = await deps.control.begin(organizationId, {
          sandboxRunId,
          enabled,
          ceilings: deps.ceilings,
          maxConcurrentPerTenant: deps.maxConcurrentPerTenant,
          probeMaxAgeMs: deps.probeMaxAgeMs,
          probe: report,
          runtime: report ? { name: report.runtime, version: report.runtimeVersion } : null,
        });
        if (begin.step === 'settled') return stepFrom(begin.status);
        if (begin.step === 'busy') return waitForCapacity;
        const job = begin.job;
        const decline = (code: 'SKILL_BYTES_CHANGED' | 'SKILL_NOT_USABLE') =>
          deps.control.decline(organizationId, { sandboxRunId, attempt: job.attempt, code });
        let bytes: Buffer;
        try {
          bytes = await deps.store.get(job.bundleObjectKey, SKILL_BUNDLE_MAX_BYTES);
        } catch {
          return stepFrom(await decline('SKILL_BYTES_CHANGED'));
        }
        const parsed = parseSkillBundle(bytes);
        if (
          !parsed.ok ||
          !job.signerKey ||
          !job.signature ||
          createHash('sha256').update(bytes).digest('hex') !== job.bundleSha256 ||
          parsed.parsed.digest !== job.digest ||
          parsed.parsed.bundle.signature.key_id !== job.signerKeyId ||
          Buffer.from(parsed.parsed.bundle.signature.value_base64, 'base64').compare(
            job.signature,
          ) !== 0 ||
          keyIdOf(job.signerKey) !== job.signerKeyId ||
          !verifySkillSignature({
            digest: job.digest,
            signature: job.signature,
            publicKey: job.signerKey,
          })
        )
          return stepFrom(await decline('SKILL_BYTES_CHANGED'));

        if (!matchesSkillSchema(parsed.parsed.manifest.input_schema, job.input))
          return stepFrom(await decline('SKILL_NOT_USABLE'));
        if (
          activity.cancellationSignal.aborted ||
          !(await deps.control.canExecute(organizationId, { sandboxRunId, attempt: job.attempt }))
        )
          return stepFrom(await decline('SKILL_NOT_USABLE'));

        let result;
        try {
          result = await deps.runner.execute(
            {
              jobId: randomUUID(),
              policy: job.policy,
              policyHash: job.policyHash,
              files: Array.from(parsed.parsed.files, ([path, content]) => ({ path, content })),
              stdin: Buffer.from(canonicalJson(job.input), 'utf8'),
            },
            activity.cancellationSignal,
          );
        } catch (error) {
          if (!(error instanceof SandboxRunnerUnavailable)) throw error;
          return stepFrom(
            await deps.control.abandon(organizationId, {
              sandboxRunId,
              attempt: job.attempt,
              code: error.code,
            }),
          );
        }
        let output:
          | { ok: true; value: unknown }
          | { ok: false; code: 'OUTPUT_NOT_JSON' | 'OUTPUT_FAILED_SCHEMA' } = {
          ok: false,
          code: 'OUTPUT_NOT_JSON',
        };
        if (result.ending === 'exited' && result.exitCode === 0) {
          try {
            const value: unknown = JSON.parse(decoder.decode(result.stdout));
            output = matchesSkillSchema(job.outputSchema, value)
              ? { ok: true, value }
              : { ok: false, code: 'OUTPUT_FAILED_SCHEMA' };
          } catch {
            // Runner output is untrusted. Never report it or the parser's text.
          }
        }
        return stepFrom(
          await deps.control.finish(organizationId, {
            sandboxRunId,
            attempt: job.attempt,
            result,
            output,
          }),
        );
      } catch {
        throw safeFailure();
      } finally {
        clearInterval(heartbeat);
      }
    },
  };
}

export type SandboxRunActivities = ReturnType<typeof createSandboxRunActivities>;

/** Runs even when the dedicated queue has no poller, and rechecks settlement before answering. */
export function createSandboxRunPlatformActivities(deps: SkillActivityDeps) {
  return {
    async abandonSandboxRun(raw: SandboxRunInput): Promise<SandboxRunOutcome> {
      try {
        const { organizationId, sandboxRunId } = sandboxRunInputSchema.parse(raw);
        const control = await createSandboxWorkerControl(deps.database);
        return settled(
          await control.abandon(organizationId, {
            sandboxRunId,
            code: 'RUNNER_NOT_CONFIGURED',
          }),
        );
      } catch {
        throw safeFailure();
      }
    },
    async readSandboxRunOutcome(raw: SandboxRunInput): Promise<SandboxRunOutcome> {
      try {
        const { organizationId, sandboxRunId } = sandboxRunInputSchema.parse(raw);
        const control = await createSandboxWorkerControl(deps.database);
        return settled((await control.read(organizationId, sandboxRunId)).status);
      } catch {
        throw safeFailure();
      }
    },
  };
}
export type SandboxRunPlatformActivities = ReturnType<typeof createSandboxRunPlatformActivities>;
