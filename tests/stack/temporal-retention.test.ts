// ADR-037 D6: what the setup job actually left on a real server, read through the same test-only sidecar the
// other stack tests reach Temporal by. tests/unit/temporal-retention.test.ts covers the script's choices.
import { Connection } from '@temporalio/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ADDRESS = '127.0.0.1:57233';
const DEFAULT_RETENTION_SECONDS = 72 * 60 * 60;

describe('Temporal retention', () => {
  let connection: Connection;

  beforeAll(async () => {
    connection = await Connection.connect({ address: ADDRESS });
  });

  afterAll(async () => {
    await connection?.close();
  });

  it('is the default on a fresh stack', async () => {
    const described = await connection.workflowService.describeNamespace({ namespace: 'default' });
    const seconds = described.config?.workflowExecutionRetentionTtl?.seconds;
    expect(Number(seconds?.toString())).toBe(DEFAULT_RETENTION_SECONDS);
  });
});
