import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  openIncident,
  assignIncidentRoles,
  recordDrill,
  recordVulnerabilityReport,
  moveVulnerabilityReport,
  type OperatorDb,
} from './operator-incidents';

const transaction = vi.fn(),
  db = { transaction } as unknown as OperatorDb;
describe('incident commands require a supplied acting reference before database access', () => {
  it.each([undefined, '', '   ', 'test\nactor'])(
    'refuses missing or malformed actor %s',
    async (operatorRef) => {
      const actor = operatorRef === undefined ? {} : { operatorRef };
      await expect(
        openIncident(db, {
          ...actor,
          severity: 'medium',
          origin: 'unknown',
          providerKind: null,
          publicTitle: 'Test',
          commanderRef: 'test-commander',
          isDrill: false,
          startedAt: new Date(),
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(
        assignIncidentRoles(db, { ...actor, incidentId: randomUUID(), legalRef: 'test-legal' }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(
        recordDrill(db, {
          ...actor,
          kind: 'incident',
          scenarioRef: 'test-scenario',
          roles: {},
          startedAt: new Date(),
          finishedAt: null,
          outcome: null,
          evidenceRef: null,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(
        recordVulnerabilityReport(db, {
          ...actor,
          channelRef: 'test-channel',
          detailsRef: 'test-reference',
          receivedAt: new Date(),
          isExercise: true,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(
        moveVulnerabilityReport(db, {
          ...actor,
          reportId: randomUUID(),
          state: 'triaged',
          expectedVersion: 1,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(transaction).not.toHaveBeenCalled();
    },
  );
});
