// Owned by the export slice (COMM-05). See docs/06-delivery/m6-slices.md and ADR-030 D7 and D10.
import type { CoreExportSection } from '@ensemus/domain/portability';
import type { PortabilitySection } from './sovereign-ports';

const notBuilt: PortabilitySection['exportPage'] = async () => {
  throw new Error('NOT_IMPLEMENTED');
};

/** How each core section reads itself, a page at a time, through `coreRecordSchema` from the contracts. */
export const CORE_SECTION_EXPORTERS: Record<CoreExportSection, PortabilitySection['exportPage']> = {
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
