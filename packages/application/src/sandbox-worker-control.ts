// Runtime composition for the two native worker entry points. Callers receive sandbox operations
// only. The web login cannot construct this capability or satisfy the sandbox row policies.
import type { AppDatabase } from '@ensemus/database';
import { assertLoginRole, createServiceContext } from '@ensemus/database/service';
import {
  abandonSandboxAttempt,
  beginSandboxAttempt,
  failSandboxAttemptBeforeExecution,
  finishSandboxAttempt,
  getSandboxRun,
  sandboxAttemptCanExecute,
} from './sandbox-runs';
import type { SkillFeatureGate } from './skill-ports';

export async function createSandboxWorkerControl(database: AppDatabase) {
  await assertLoginRole(database, 'ensemus_worker');
  return {
    begin: (organization: string, input: Parameters<typeof beginSandboxAttempt>[2]) =>
      beginSandboxAttempt(database, createServiceContext(organization), input),
    finish: (organization: string, input: Parameters<typeof finishSandboxAttempt>[2]) =>
      finishSandboxAttempt(database, createServiceContext(organization), input),
    decline: (
      organization: string,
      input: Parameters<typeof failSandboxAttemptBeforeExecution>[2],
    ) => failSandboxAttemptBeforeExecution(database, createServiceContext(organization), input),
    abandon: (organization: string, input: Parameters<typeof abandonSandboxAttempt>[2]) =>
      abandonSandboxAttempt(database, createServiceContext(organization), input),
    canExecute: (organization: string, input: Parameters<typeof sandboxAttemptCanExecute>[2]) =>
      sandboxAttemptCanExecute(database, createServiceContext(organization), input),
    read: (organization: string, id: string) =>
      getSandboxRun(database, createServiceContext(organization), id),
    allows: (organization: string, gate: SkillFeatureGate) =>
      gate.isEnabled(createServiceContext(organization), 'sandbox'),
  };
}
