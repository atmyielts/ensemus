// LIFE-04: the offboarding step's M3 and M7 ports, against the SQL they send. The database half, the
// connection guard admitting this revoke only for a tenant at that step, is in
// tests/integration/offboarding-connections.test.ts.
import { randomUUID } from 'node:crypto';
import { federationWindDown } from '@ensemus/application';
import {
  createOffboardingConnectionsPort,
  createProcessRunWindDown,
} from '@ensemus/application/saas/offboarding-connections';
import type { TenantContext, Tx } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { drizzle } from 'drizzle-orm/node-postgres';
import { describe, expect, it } from 'vitest';
import { createSaasPorts } from '../../workers/workflow/src/saas-ports';

type Sent = { text: string; params: unknown[] };
type Answer = (text: string, params: unknown[]) => unknown[][] | Record<string, unknown>[] | null;

/** A drizzle transaction over a recording client: each statement is kept, and `answer` gives its rows. */
function recordingTx(answer: Answer) {
  const sent: Sent[] = [];
  const client = {
    query: async (config: string | { text: string }, params: unknown[] = []) => {
      const text = typeof config === 'string' ? config : config.text;
      sent.push({ text, params });
      return { rows: answer(text, params) ?? [], rowCount: 0, fields: [], command: '' };
    },
  };
  return { tx: drizzle({ client: client as never, casing: 'snake_case' }) as unknown as Tx, sent };
}

const userContext = { organizationId: randomUUID(), actorType: 'user' } as TenantContext;

describe('offboarding connections port (LIFE-04)', () => {
  it('is wired into the worker, with the federation and automation wind-downs', () => {
    const ports = createSaasPorts({}).offboarding;
    expect(typeof ports.connections?.revokeAllInTx).toBe('function');
    expect(ports.windDowns).toEqual([federationWindDown, expect.any(Function)]);
  });

  it('refuses anything but a service context before it sends anything', async () => {
    const { tx, sent } = recordingTx(() => null);
    await expect(
      createOffboardingConnectionsPort().revokeAllInTx(tx, userContext),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(createProcessRunWindDown()(tx, userContext)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(sent).toHaveLength(0);
  });

  it('revokes every live connection as a revoke does: row, callbacks, event, audit', async () => {
    const context = createServiceContext(randomUUID());
    const [first, second] = [randomUUID(), randomUUID()].sort();
    const { tx, sent } = recordingTx((text) => {
      if (/^select .* from "integrations"\."connections"/i.test(text))
        return [
          [first, 3],
          [second, 1],
        ];
      if (/^update "integrations"\."connections"/i.test(text) && /returning/i.test(text))
        return [[sent.at(-1)!.params.find((value) => value === first || value === second)]];
      return null;
    });
    await createOffboardingConnectionsPort().revokeAllInTx(tx, context);
    const updates = sent.filter(({ text }) => /^update "integrations"\."connections"/i.test(text));
    expect(updates).toHaveLength(2);
    // Each moves its own version on by one, and only from the version it locked.
    expect(updates[0]!.params).toEqual(expect.arrayContaining(['revoked', 4, first, 3]));
    expect(updates[1]!.params).toEqual(expect.arrayContaining(['revoked', 2, second, 1]));
    const lockedRead = sent.find(({ text }) => /from "integrations"\."connections"/i.test(text));
    expect(lockedRead!.text).toMatch(/for update/i);
    expect(lockedRead!.params).toContain(context.organizationId);
    expect(
      sent.filter(({ text }) => /^update "integrations"\."webhook_endpoints"/i.test(text)),
    ).toHaveLength(2);
    const events = sent.filter(({ text }) => /insert into "platform"\."domain_events"/i.test(text));
    expect(events).toHaveLength(2);
    expect(events.every(({ params }) => params.includes('connection.revoked'))).toBe(true);
    const audits = sent.filter(({ text }) =>
      /insert into "governance"\."audit_events"/i.test(text),
    );
    expect(audits).toHaveLength(2);
    expect(audits[0]!.params).toEqual(expect.arrayContaining(['service', 'TENANT_OFFBOARDING']));
    // Nothing reads or touches a sealed credential: the connector worker's revoke run does that.
    expect(sent.some(({ text }) => /secrets\./i.test(text))).toBe(false);
  });

  it('stops when a connection moved on under it, so the step does not advance', async () => {
    const id = randomUUID();
    const { tx } = recordingTx((text) =>
      /^select .* from "integrations"\."connections"/i.test(text) ? [[id, 1]] : null,
    );
    await expect(
      createOffboardingConnectionsPort().revokeAllInTx(tx, createServiceContext(randomUUID())),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('asks each live automation to stop without moving its status or version', async () => {
    const context = createServiceContext(randomUUID());
    const run = randomUUID();
    const { tx, sent } = recordingTx((text) =>
      /^select .* from "studio"\."process_runs"/i.test(text) ? [[run, 7, 'confidential']] : null,
    );
    await createProcessRunWindDown()(tx, context);
    const read = sent[0]!;
    expect(read.text).toMatch(/for update of "process_runs"\s*$/i);
    expect(read.params).toEqual(expect.arrayContaining(['running', 'waiting']));
    const update = sent.find(({ text }) => /^update "studio"\."process_runs"/i.test(text))!;
    expect(update.text).not.toMatch(/"status"|"version"/);
    expect(update.params).toContain('STOP_REQUESTED');
    const event = sent.find(({ text }) => /insert into "platform"\."domain_events"/i.test(text))!;
    expect(event.params).toEqual(
      expect.arrayContaining(['process_run.stop_requested', run, 7, 'confidential']),
    );
  });
});
