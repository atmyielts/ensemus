// Owned by the import slice (COMM-05). See docs/06-delivery/m6-slices.md and ADR-030 D8 and D9.
import type { CoreExportSection } from '@ensemus/domain/portability';
import type { PortabilitySection } from './sovereign-ports';

const notBuilt: PortabilitySection['importPage'] = async () => {
  throw new Error('NOT_IMPLEMENTED');
};

/** How each core section writes itself back, validating every record against `coreRecordSchema`. */
export const CORE_SECTION_IMPORTERS: Record<CoreExportSection, PortabilitySection['importPage']> = {
  organizations: notBuilt,
  people: notBuilt,
  clients: notBuilt,
  projects: notBuilt,
  work: notBuilt,
  relations: notBuilt,
  artifacts: notBuilt,
  history: notBuilt,
  connections: notBuilt,
  tombstones: notBuilt,
  'audit-redacted': notBuilt,
};
