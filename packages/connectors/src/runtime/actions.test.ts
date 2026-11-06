// The commit-point rule at its source (ADR-027 D2): only NotSent can say nothing happened. Anything else
// a connector does wrong, including hanging, reads as "it may have gone", and no text gets out.
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { NotSent, type ActionRequest, type Connector, type ConnectorContext } from '../index';
import { createFakeConnector } from '../testing';
import { runReconcile, runSend } from './actions';

const CANARY = `CANARY-provider-text-${randomUUID()}`;

const request: ActionRequest = {
  externalActionId: randomUUID(),
  attemptId: randomUUID(),
  attemptNo: 1,
  toolName: 'fake.act',
  toolVersion: '1',
  idempotencyKey: `ensemus-${randomUUID()}`,
  requestHash: 'hash',
  payload: {},
};

const context: Omit<ConnectorContext, 'signal'> = {
  organizationId: randomUUID(),
  connectionId: randomUUID(),
  config: {},
  credentials: { withCredential: async (use) => use(Buffer.from('generated')) },
  network: {
    openRelay: async () => {
      throw new Error('not used');
    },
  },
};

function call(
  send: NonNullable<Connector['actions']>['send'],
  deadlineMs?: number,
  reconcile: NonNullable<Connector['actions']>['reconcile'] = async () => ({
    answer: 'cannot_answer',
  }),
) {
  return {
    connector: createFakeConnector({ actions: { send, reconcile } }),
    context,
    request,
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
  };
}

describe('runSend', () => {
  it('passes on an answer the connector was sure of', async () => {
    await expect(
      runSend(
        call(async () => ({
          outcome: 'accepted',
          code: 'ACCEPTED_BY_RELAY',
          providerStatus: 250,
          externalId: 'message-1',
        })),
      ),
    ).resolves.toEqual({
      outcome: 'accepted',
      code: 'ACCEPTED_BY_RELAY',
      providerStatus: 250,
      externalId: 'message-1',
    });
  });

  it('turns NotSent into not_sent with its code and whether to retry', async () => {
    await expect(
      runSend(
        call(async () => {
          throw new NotSent('RELAY_BUSY', true);
        }),
      ),
    ).resolves.toEqual({ outcome: 'not_sent', code: 'RELAY_BUSY', retryable: true });
    await expect(
      runSend(
        call(async () => {
          throw new NotSent('AUTH_FAILED', false);
        }),
      ),
    ).resolves.toEqual({ outcome: 'not_sent', code: 'AUTH_FAILED', retryable: false });
  });

  it('counts any other error as indeterminate, with no text', async () => {
    const result = await runSend(
      call(async () => {
        throw new Error(CANARY);
      }),
    );
    expect(result).toEqual({ outcome: 'indeterminate', code: 'CONNECTION_LOST_AFTER_COMMIT' });
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  it('counts something thrown that is not an error, and a synchronous throw', async () => {
    await expect(
      runSend(call(() => Promise.reject(CANARY as unknown as Error))),
    ).resolves.toMatchObject({ outcome: 'indeterminate' });
    await expect(
      runSend(
        call(() => {
          throw new Error(CANARY);
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'indeterminate' });
  });

  it('does not believe an error that only calls itself NotSent', async () => {
    const lookalike = Object.assign(new Error('NotSent'), {
      name: 'NotSent',
      code: 'RELAY_BUSY',
      retryable: true,
    });
    await expect(
      runSend(
        call(async () => {
          throw lookalike;
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'indeterminate' });
  });

  it('counts the deadline as indeterminate and aborts the connector', async () => {
    let signal: AbortSignal | undefined;
    const result = await runSend(
      call((ctx) => {
        signal = ctx.signal;
        return new Promise(() => undefined);
      }, 10),
    );
    expect(result).toEqual({ outcome: 'indeterminate', code: 'TIMEOUT_AFTER_COMMIT' });
    expect(signal?.aborted).toBe(true);
  });

  it('holds to indeterminate when a connector says NotSent only after its deadline', async () => {
    const result = await runSend(
      call(async (ctx) => {
        await new Promise((done) => ctx.signal.addEventListener('abort', done));
        await new Promise((done) => setTimeout(done, 5));
        throw new NotSent('CONNECT_FAILED', true);
      }, 5),
    );
    expect(result.outcome).toBe('indeterminate');
  });

  it('has no unhandled rejection when a connector fails after its deadline', async () => {
    const seen = vi.fn();
    process.on('unhandledRejection', seen);
    await runSend(
      call(async () => {
        await new Promise((done) => setTimeout(done, 20));
        throw new Error(CANARY);
      }, 1),
    );
    await new Promise((done) => setTimeout(done, 40));
    process.off('unhandledRejection', seen);
    expect(seen).not.toHaveBeenCalled();
  });

  it('counts an answer it cannot read as indeterminate', async () => {
    for (const garbage of [
      null,
      { outcome: 'delivered', code: 'ACCEPTED_BY_RELAY' },
      { outcome: 'accepted', code: CANARY },
    ]) {
      const result = await runSend(call(async () => garbage as never));
      expect(result.outcome).toBe('indeterminate');
      expect(JSON.stringify(result)).not.toContain(CANARY);
    }
  });

  it('never returns a provider ID or status that does not fit', async () => {
    const result = await runSend(
      call(async () => ({
        outcome: 'accepted',
        code: 'ACCEPTED_BY_RELAY',
        providerStatus: 1.5,
        externalId: 'x'.repeat(2000),
      })),
    );
    expect(result).toEqual({ outcome: 'accepted', code: 'ACCEPTED_BY_RELAY' });
  });

  it('never claims a retry except on not_sent', async () => {
    const result = await runSend(
      call(async () => ({
        outcome: 'indeterminate',
        code: 'TIMEOUT_AFTER_COMMIT',
        retryable: true,
      })),
    );
    expect(result).toEqual({ outcome: 'indeterminate', code: 'TIMEOUT_AFTER_COMMIT' });
  });

  it('says nothing was sent by a connector with no way to act', async () => {
    await expect(
      runSend({ connector: createFakeConnector({}), context, request }),
    ).resolves.toEqual({ outcome: 'not_sent', code: 'CONNECTOR_UNAVAILABLE', retryable: false });
  });

  it('says nothing was sent when the credential could not be opened and no connection was made', async () => {
    const result = await runSend({
      ...call(async (ctx) => ctx.credentials.withCredential(async () => never())),
      context: {
        ...context,
        credentials: {
          withCredential: async () => {
            throw new Error(CANARY);
          },
        },
      },
    });
    expect(result).toEqual({
      outcome: 'not_sent',
      code: 'CREDENTIAL_UNAVAILABLE',
      retryable: false,
    });
  });

  it('counts a credential failing after a connection was made as indeterminate', async () => {
    const result = await runSend({
      ...call(async (ctx) => {
        await ctx.network.openRelay({ timeoutMs: 1 });
        return ctx.credentials.withCredential(async () => never());
      }),
      context: {
        ...context,
        network: { openRelay: async () => ({}) as never },
        credentials: {
          withCredential: async () => {
            throw new Error(CANARY);
          },
        },
      },
    });
    expect(result.outcome).toBe('indeterminate');
  });

  it('counts a failure inside the credential callback as the connector failing', async () => {
    const result = await runSend(
      call(async (ctx) =>
        ctx.credentials.withCredential(async () => {
          throw new Error(CANARY);
        }),
      ),
    );
    expect(result.outcome).toBe('indeterminate');
  });
});

const never = (): never => {
  throw new Error('This must not be reached');
};

describe('runReconcile', () => {
  const reconcileCall = (reconcile: NonNullable<Connector['actions']>['reconcile'], ms?: number) =>
    call(async () => never(), ms, reconcile);

  it('passes on what the provider said', async () => {
    await expect(
      runReconcile(reconcileCall(async () => ({ answer: 'found', externalId: 'one' }))),
    ).resolves.toEqual({ answer: 'found', externalId: 'one' });
    await expect(
      runReconcile(reconcileCall(async () => ({ answer: 'not_found' }))),
    ).resolves.toEqual({ answer: 'not_found' });
    await expect(
      runReconcile(reconcileCall(async () => ({ answer: 'refused', providerStatus: 550 }))),
    ).resolves.toEqual({ answer: 'refused', providerStatus: 550 });
  });

  it('cannot answer when it throws, hangs or says something unreadable', async () => {
    await expect(
      runReconcile(
        reconcileCall(async () => {
          throw new Error(CANARY);
        }),
      ),
    ).resolves.toEqual({ answer: 'cannot_answer' });
    await expect(
      runReconcile(reconcileCall(() => new Promise(() => undefined), 5)),
    ).resolves.toEqual({ answer: 'cannot_answer' });
    await expect(
      runReconcile(reconcileCall(async () => ({ answer: CANARY }) as never)),
    ).resolves.toEqual({ answer: 'cannot_answer' });
  });

  it('cannot answer for a connector with no way to ask', async () => {
    await expect(
      runReconcile({ connector: createFakeConnector({}), context, request }),
    ).resolves.toEqual({ answer: 'cannot_answer' });
  });
});
