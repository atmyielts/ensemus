// The pack catalog (AGENT-14, ADR-031 D10). Owned by the packs slice. A pack is data shipped with the release:
// nothing is downloaded, so this works the same with no network.
import { DEPARTMENT_PACKS } from '@ensemus/department-packs';
import type { PackManifest } from '@ensemus/domain/pack';
import { salesOperationsPack } from './sales-operations';

/** Every version of every pack this release can install. Older versions stay, so a rollback can find them. */
export const PACK_CATALOG: readonly PackManifest[] = [...salesOperationsPack, ...DEPARTMENT_PACKS];

export function findPack(key: string, version: string): PackManifest | null {
  return PACK_CATALOG.find((pack) => pack.key === key && pack.version === version) ?? null;
}
