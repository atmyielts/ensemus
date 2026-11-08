import { describe, expect, it } from 'vitest';
import { eraseCommandInputSchemas } from '@ensemus/application/saas/offboarding';
import { incidentCommandInputSchemas } from '@ensemus/application/saas/operator-incidents';
import { deskCommandInputSchemas } from '@ensemus/application/saas/support-desk';

const id = 'a1b2c3d4-1234-4234-8234-a1b2c3d4e5f6';
const wireId = id.toUpperCase();

describe('SaaS operator command IDs', () => {
  it('canonicalizes tenant and offboarding IDs without changing operator attribution', () => {
    expect(
      eraseCommandInputSchemas.run.parse({
        organizationId: wireId,
        offboardingId: wireId,
        operatorRef: 'Operator@Example.invalid',
      }),
    ).toEqual({ organizationId: id, offboardingId: id, operatorRef: 'Operator@Example.invalid' });
  });

  it('canonicalizes incident IDs without changing public text', () => {
    const result = incidentCommandInputSchemas.update.parse({
      incidentId: wireId,
      state: 'monitoring',
      publicMessage: 'BYOM Service Is Recovering',
      authorRef: 'Operator@Example.invalid',
      publish: true,
    });
    expect(result).toMatchObject({
      incidentId: id,
      publicMessage: 'BYOM Service Is Recovering',
      authorRef: 'Operator@Example.invalid',
    });
  });

  it('canonicalizes ticket scope IDs without changing the reason or operator reference', () => {
    expect(
      deskCommandInputSchemas.request.parse({
        organizationId: wireId,
        ticketId: wireId,
        scopeType: 'artifact',
        scopeId: wireId,
        requestedBy: 'Operator@Example.invalid',
        reasonCode: 'CUSTOMER_REQUEST',
        requestedMinutes: 10,
      }),
    ).toEqual({
      organizationId: id,
      ticketId: id,
      scopeType: 'artifact',
      scopeId: id,
      requestedBy: 'Operator@Example.invalid',
      reasonCode: 'CUSTOMER_REQUEST',
      requestedMinutes: 10,
    });
  });

  it.each(['not-an-id', ` ${wireId}`, `${wireId} `, ''])(
    'still refuses an invalid ID: %j',
    (bad) => {
      expect(
        eraseCommandInputSchemas.run.safeParse({
          organizationId: id,
          offboardingId: bad,
          operatorRef: 'operator@example.invalid',
        }).success,
      ).toBe(false);
      expect(
        deskCommandInputSchemas.show.safeParse({ organizationId: id, ticketId: bad }).success,
      ).toBe(false);
      expect(
        incidentCommandInputSchemas.resolve.safeParse({
          incidentId: bad,
          authorRef: 'operator@example.invalid',
          postmortemRef: null,
          message: 'Resolved',
        }).success,
      ).toBe(false);
    },
  );
});
