// Owned by the sdk slice. See docs/06-delivery/m3-slices.md.
import type { SourceGrant } from '@ensemus/domain/connector';
import type { PrincipalDirectory } from '../index';

export type MappedGrant = SourceGrant & { membershipId: string | null; teamId: string | null };

/** Maps each grant, in order. One nobody matches keeps its row with both targets empty. */
export function mapSourceGrants(
  _grants: readonly SourceGrant[],
  _directory: PrincipalDirectory,
): Promise<readonly MappedGrant[]> {
  throw new Error('NOT_IMPLEMENTED');
}
