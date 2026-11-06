// Simulation (ADR-031 D5): a pure function from a spec and synthetic facts to a report. It has no way to
// reach anything, which is what makes "zero side effects" true by construction and not by promise.
// Owned by the studio slice.

/** A made-up situation. No tenant data, and it says what each step would be told. */
export type SimulationScenario = {
  key: string;
  /** What the agent's turns propose, as a script. The model is never called. */
  turns: readonly (
    | {
        kind: 'tool';
        toolId: string;
        dataClass: 'public' | 'internal' | 'confidential' | 'restricted';
      }
    | { kind: 'finish'; citesEvidence: boolean }
  )[];
  /** A catalog process's expected path through its own steps, for a process subject. */
  processPath?: readonly string[];
};

export type SimulatedStep = {
  index: number;
  subject: string;
  decision: 'allowed' | 'needs_approval' | 'denied' | 'would_write_outside';
  /** A fixed code. A report has no free text, so a report can go anywhere a code can. */
  reasonCode: string;
};

export type SimulationReport = {
  schemaVersion: 1;
  scenarioKey: string;
  subjectSha256: string;
  /** What would have happened. Each of these is a description: nothing was sent, written or called. */
  steps: readonly SimulatedStep[];
  wouldWriteOutside: readonly string[];
  approvalsNeeded: number;
  /** Turns, tool calls and cost against their limits. No price is invented: cost is limit only. */
  limits: {
    turnsUsed: number;
    turnsAllowed: number;
    toolCallsUsed: number;
    toolCallsAllowed: number;
  };
  outcome: 'passed' | 'failed';
  failureCodes: readonly string[];
};

/** Pure and deterministic. Implemented by the studio slice. Denied tools are recorded, never executed. */
export function simulateAgent(
  _spec: Record<string, unknown>,
  _specSha256: string,
  _scenario: SimulationScenario,
): SimulationReport {
  throw new Error('NOT_IMPLEMENTED');
}
