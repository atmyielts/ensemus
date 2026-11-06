// Owned by the halt slice (SEC-06). See docs/06-delivery/m4-slices.md and ADR-028 FD-15. Needs `ai.halt`.
// Migration 0101's trigger on M3's attempt table also reads these switches. Every stub refuses.
import type { EngageKillSwitch } from '@ensemus/contracts/ai';
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type { HaltCheck } from './ports';

export function createHaltCheck(): HaltCheck {
  throw new Error('NOT_IMPLEMENTED');
}

export function engageKillSwitch(
  _database: AppDatabase,
  _context: TenantContext,
  _input: EngageKillSwitch,
): Promise<{ switchId: string }> {
  throw new Error('NOT_IMPLEMENTED');
}

export function releaseKillSwitch(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { switchId: string },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}

export type KillSwitchView = {
  id: string;
  scope: string;
  targetRef: string | null;
  reasonCode: string;
  engagedAt: Date;
  /** An operator's switch: this tenant can see it, and cannot release it. */
  operator: boolean;
};

export function listKillSwitches(
  _database: AppDatabase,
  _context: TenantContext,
): Promise<readonly KillSwitchView[]> {
  throw new Error('NOT_IMPLEMENTED');
}
