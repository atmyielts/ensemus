// Owned by the pack-finance slice (EXP-01). See docs/06-delivery/m11a-slices.md. Reporting and approval preparation.
// Never autonomous transfers: no tool in this pack moves money. Empty until it lands, so nothing is offered.
import type { DepartmentPackManifest } from '@ensemus/domain/department-pack';

/** Every shipped version, oldest first. */
export const financeOperationsPack: readonly DepartmentPackManifest[] = [];
