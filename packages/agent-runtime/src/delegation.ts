// Owned by the delegation slice (AGENT-05). Pure rules for what a child may have (ADR-028 FD-16). The stubs
// grant nothing.

/** An intersection, never a union. Anything asked for and not held is reported as refused. */
export function intersectScopes(
  _parent: readonly string[],
  _asked: readonly string[],
): { granted: readonly string[]; refused: readonly string[] } {
  return { granted: [], refused: [..._asked] };
}

/** The lower of the manifest's depth and the organization's policy. */
export function allowedDepth(_manifestDepth: number, _orgDepth: number): number {
  return 0;
}

/** What is left of the parent's limit once earlier children took theirs. Never below zero. */
export function carveChildBudget(
  _parentRemainingMicros: number,
  _askedMicros: number,
): { ok: true; micros: number } | { ok: false } {
  return { ok: false };
}
