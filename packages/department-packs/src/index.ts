// Department packs are release data in the actual installer format. Installing adds no permissions.
// An empty collection is not offered; every shipped version remains available for review and rollback.
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
