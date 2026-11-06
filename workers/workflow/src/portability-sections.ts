// The one list of what an archive carries. The export and import slices share the core, and each later
// milestone adds its own section here at the final merge (the PortabilitySection port, ADR-030 D7).
import { SOURCE_PORTABILITY_SECTIONS, type PortabilitySection } from '@ensemus/application';

export const PORTABILITY_SECTIONS: readonly PortabilitySection[] = SOURCE_PORTABILITY_SECTIONS;
