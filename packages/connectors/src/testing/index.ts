// Owned by the sdk slice. See docs/06-delivery/m3-slices.md. Test doubles, which lint keeps out of every
// worker and web entry point, so none of this can reach a shipped image.
import type { SyncPage } from '@ensemus/domain/connector';
import type { Connector } from '../index';

export type FakeConnectorScript = {
  /** What each stream's pages are, in order. The cursor it hands back is the next page's number. */
  pages?: Readonly<Record<string, readonly SyncPage[]>>;
};

export type FakeConnectorConfig = Record<string, never>;

/** Serves scripted pages, so sync can be tested with no provider. */
export function createFakeConnector(_script: FakeConnectorScript): Connector<FakeConnectorConfig> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * Registers the suite every connector has to pass, in the caller's test file: manifest shape, errors
 * that carry no text, and for each capability it declares, the rules in ADR-027 D3.
 */
export function describeConnectorConformance(
  _name: string,
  _make: () => Connector,
  _fixtures: { config: unknown },
): void {
  throw new Error('NOT_IMPLEMENTED');
}
