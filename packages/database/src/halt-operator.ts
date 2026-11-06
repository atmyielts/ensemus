// Owned by the halt slice (SEC-06). See docs/06-delivery/m4-slices.md and ADR-028 FD-15. For the operator's
// command only: it uses the migrator role, like the setup token, because a switch for every tenant has
// no tenant to bind and no role here has BYPASSRLS. Lint blocks it from everything but that command.

export type OperatorSwitch =
  | { scope: 'global'; reasonCode: string }
  | { scope: 'provider'; providerKind: string; reasonCode: string };

/** Writes a row with a null organization. Works with no network but the database's. */
export function engageOperatorSwitch(
  _migratorUrl: string,
  _input: OperatorSwitch,
): Promise<string> {
  throw new Error('NOT_IMPLEMENTED');
}

export function releaseOperatorSwitch(_migratorUrl: string, _switchId: string): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}

export function listOperatorSwitches(
  _migratorUrl: string,
): Promise<readonly { id: string; scope: string; targetRef: string | null; engagedAt: Date }[]> {
  throw new Error('NOT_IMPLEMENTED');
}
