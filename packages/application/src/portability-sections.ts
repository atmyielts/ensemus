// Owned by the export slice, which fills `exportPage`, and the import slice, which fills `importPage` (COMM-05).
// See docs/06-delivery/m6-slices.md. One object per section, each with two methods, so the two slices can work
// at once: export edits only `portability-sections-export.ts` and import only `portability-sections-import.ts`.
import type { CoreExportSection } from '@ensemus/domain/portability';
import { CORE_SECTION_IMPORTERS } from './portability-sections-import';
import { CORE_SECTION_EXPORTERS } from './portability-sections-export';
import type { PortabilitySection } from './sovereign-ports';

const section = (name: CoreExportSection): PortabilitySection => ({
  section: name,
  exportPage: CORE_SECTION_EXPORTERS[name],
  importPage: CORE_SECTION_IMPORTERS[name],
});

export const CORE_PORTABILITY_SECTIONS: readonly PortabilitySection[] = [
  section('organizations'),
  section('people'),
  section('clients'),
  section('projects'),
  section('work'),
  section('relations'),
  section('artifacts'),
  section('history'),
  section('connections'),
  section('tombstones'),
  section('audit-redacted'),
];
