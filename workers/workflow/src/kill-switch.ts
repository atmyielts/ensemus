// Owned by the halt slice (SEC-06). See docs/06-delivery/m4-slices.md and ADR-028 FD-15. agent-worker polls
// the switches and aborts in-flight calls through this. Unreadable state counts as halted.

/** Registers an in-flight call so a switch can abort it, and tells the caller when one does. */
export interface HaltWatcher {
  start(): void;
  stop(): Promise<void>;
  /** Aborted when a switch covering this run engages. */
  signalFor(run: {
    organizationId: string;
    agentVersionId: string;
    providerKind: string;
  }): AbortSignal;
}

export function createHaltWatcher(_deps: { pollMs: number }): HaltWatcher {
  throw new Error('NOT_IMPLEMENTED');
}
