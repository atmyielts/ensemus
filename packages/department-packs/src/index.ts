// The remaining department packs (EXP-01, ADR-033 D1). Plain data for an administrator to review: AGENT-14 in M7
// installs them, and installing grants nothing. Each pack has its own folder and its own builder. One that has
// not landed yet is null here and is simply not offered, and a test added by the stack slice requires them all.
import type { DepartmentPack } from '@ensemus/domain/department-pack';
import { FINANCE_OPERATIONS_PACK } from './finance';
import { HR_OPERATIONS_PACK } from './hr';
import { LEARNING_PROGRAMS_PACK } from './learning';
import { MARKETING_OPERATIONS_PACK } from './marketing';

export const DEPARTMENT_PACKS: readonly DepartmentPack[] = [
  MARKETING_OPERATIONS_PACK,
  HR_OPERATIONS_PACK,
  FINANCE_OPERATIONS_PACK,
  LEARNING_PROGRAMS_PACK,
].filter((pack): pack is DepartmentPack => pack !== null);

export const departmentPackById = (id: string): DepartmentPack | undefined =>
  DEPARTMENT_PACKS.find((pack) => pack.id === id);

export {
  FINANCE_OPERATIONS_PACK,
  HR_OPERATIONS_PACK,
  LEARNING_PROGRAMS_PACK,
  MARKETING_OPERATIONS_PACK,
};
