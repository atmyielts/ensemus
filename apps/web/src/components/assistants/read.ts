// What a page or an action gets from the port, reduced to the states a person can be told about. No request
// and no redirect in here, so each fault can be tested with a fake (tests/unit/assistants-wording.test.ts).
// Only the pages and the action import this: it pulls in the application layer, and it never reaches a browser.
import { AppError } from '@ensemus/application';
import {
  getDelegatedRun,
  listMyDelegatedRuns,
  stopDelegatedRun,
} from '@ensemus/application/assistants';
import type { ProductPorts } from '@ensemus/application/product-ports';
import type { TenantContext } from '@ensemus/database';
import { presentRun, type PresentedRun, type StopAttempt } from './present';

type Ports = Pick<ProductPorts, 'agentRuns'>;

const isUnavailable = (error: unknown) =>
  error instanceof AppError && error.code === 'CAPABILITY_UNAVAILABLE';
const isBrokenCursor = (error: unknown) =>
  error instanceof AppError && error.code === 'INVALID_INPUT';

export type AssistantsPageState =
  | { kind: 'unavailable' }
  | {
      kind: 'ready';
      running: readonly PresentedRun[];
      finished: readonly PresentedRun[];
      next: string | null;
      /** A page reached through a broken link starts again from the top, and says so. */
      brokenLink: boolean;
    };

/**
 * "Not available" is its own state, and is never an empty list: an empty list would tell someone that nothing
 * is running on their behalf, which nobody here knows. Anything else that goes wrong is a real fault, and goes
 * on to the error page.
 */
export async function readAssistantsPage(
  context: TenantContext,
  ports: Ports,
  input: { after?: string } = {},
): Promise<AssistantsPageState> {
  try {
    let brokenLink = false;
    const view = await listMyDelegatedRuns(context, ports, input).catch((failure: unknown) => {
      if (!input.after || !isBrokenCursor(failure)) throw failure;
      brokenLink = true;
      return listMyDelegatedRuns(context, ports);
    });
    return {
      kind: 'ready',
      running: view.running.map(presentRun),
      finished: view.finished.map(presentRun),
      next: view.next,
      brokenLink,
    };
  } catch (error) {
    if (isUnavailable(error)) return { kind: 'unavailable' };
    throw error;
  }
}

export type RunPageState = { kind: 'unavailable' } | { kind: 'ready'; run: PresentedRun };

/** NOT_FOUND comes straight out, for the page's `orNotFound` to turn into the usual 404. */
export async function readRunPage(
  context: TenantContext,
  ports: Ports,
  runId: string,
): Promise<RunPageState> {
  try {
    return { kind: 'ready', run: presentRun(await getDelegatedRun(context, ports, runId)) };
  } catch (error) {
    if (isUnavailable(error)) return { kind: 'unavailable' };
    throw error;
  }
}

/**
 * Asks once, and reports how that went without saying what happened to the run: the page reads that from the
 * run. Browsers check the box, and so does this. The failure stays on the server, for the record and the log.
 */
export async function attemptStop(
  context: TenantContext,
  ports: Ports,
  runId: string,
  confirmed: boolean,
): Promise<StopAttempt> {
  if (!confirmed) return { ok: false, code: 'INVALID_INPUT' };
  try {
    await stopDelegatedRun(context, ports, runId);
    return { ok: true };
  } catch (failure) {
    return {
      ok: false,
      code: failure instanceof AppError ? failure.code : 'UNEXPECTED',
      failure,
    };
  }
}
