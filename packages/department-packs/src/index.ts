// The remaining department packs (EXP-01, ADR-033 D1), in AGENT-14's pack format. Plain data for an administrator to
// review: M7's installer installs them, and installing grants nothing. Each pack has its own folder and its own
// builder, and exports every shipped version, oldest first. One that has not landed yet is empty, and is simply
// not offered. The final merge adds this list to PACK_CATALOG in @ensemus/packs, which holds Sales operations.
import type { DepartmentPackManifest } from '@ensemus/domain/department-pack';
import { financeOperationsPack } from './finance';
import { hrOperationsPack } from './hr';
import { learningProgramsPack } from './learning';
import { marketingOperationsPack } from './marketing';

export const DEPARTMENT_PACKS: readonly DepartmentPackManifest[] = [
  ...marketingOperationsPack,
  ...hrOperationsPack,
  ...financeOperationsPack,
  ...learningProgramsPack,
];

export const findDepartmentPack = (
  key: string,
  version: string,
): DepartmentPackManifest | undefined =>
  DEPARTMENT_PACKS.find((pack) => pack.key === key && pack.version === version);

export { financeOperationsPack, hrOperationsPack, learningProgramsPack, marketingOperationsPack };
