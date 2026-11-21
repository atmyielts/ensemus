// A deterministic model for tests. It obeys its script exactly, so a red-team test that scripts it to obey
// an injection proves the controls, not a model's refusal. It counts every call, so "denied before egress"
// can be asserted as zero hits. It reaches no network.
import type {
  AdapterCall,
  AdapterResult,
  AdapterUsage,
  Malformation,
  ModelAdapter,
} from '../types';

export type ScriptStep =
  | { kind: 'final'; text: string; usage?: AdapterUsage }
  | { kind: 'tool_call'; toolId: string; args: unknown; usage?: AdapterUsage }
  | {
      kind: 'failure';
      failure: Extract<AdapterResult, { kind: 'failure' }>['failure'];
      mayHaveBilled?: boolean;
      /** A provider's Retry-After, as an adapter would hand it up. */
      retryAfterMs?: number | null;
      /** What was wrong with a whole answer, for a repair turn to correct. */
      malformation?: Malformation;
    }
  /** Waits until the signal aborts, for cancel tests. */
  | { kind: 'hang' }
  /** Throws, as a bug in an adapter would. */
  | { kind: 'throw' };

const DEFAULT_USAGE = { inputTokens: 10, outputTokens: 5 };

export class ScriptedModelAdapter implements ModelAdapter {
  readonly calls: AdapterCall[] = [];
  #next = 0;
  readonly #script: readonly ScriptStep[];

  constructor(script: readonly ScriptStep[]) {
    this.#script = script;
  }

  get hits() {
    return this.calls.length;
  }

  async generate(call: AdapterCall, signal: AbortSignal): Promise<AdapterResult> {
    this.calls.push(call);
    const step = this.#script[this.#next++];
    // Running off the end of a script is a mistake in the test, so it must not look like success.
    if (!step) throw new Error('ScriptedModelAdapter: script ran out');
    switch (step.kind) {
      case 'final':
        return { kind: 'final', text: step.text, usage: step.usage ?? DEFAULT_USAGE };
      case 'tool_call':
        return {
          kind: 'tool_call',
          toolId: step.toolId,
          args: step.args,
          usage: step.usage ?? DEFAULT_USAGE,
        };
      case 'failure':
        return {
          kind: 'failure',
          failure: step.failure,
          mayHaveBilled: step.mayHaveBilled ?? false,
          usage: null,
          ...(step.retryAfterMs !== undefined ? { retryAfterMs: step.retryAfterMs } : {}),
          ...(step.malformation ? { malformation: step.malformation } : {}),
        };
      case 'hang':
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return { kind: 'failure', failure: 'cancelled', mayHaveBilled: true, usage: null };
      case 'throw':
        throw new Error('ScriptedModelAdapter: scripted bug');
    }
  }
}
