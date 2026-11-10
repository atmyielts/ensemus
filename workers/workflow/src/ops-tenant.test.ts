import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { AppError } from '@ensemus/application';
import { readSecret } from '@ensemus/config';
import { openAppDatabase, withTenantTx } from '@ensemus/database';
import * as standing from '@ensemus/application/saas/standing';
import { beforeEach, afterAll, describe, it, expect, vi } from 'vitest';
import { tenantCommand } from './ops-tenant';

vi.mock('@ensemus/config', () => ({ readSecret: vi.fn() }));
vi.mock('@ensemus/database', async (original) => ({
  ...(await original<typeof import('@ensemus/database')>()),
  openAppDatabase: vi.fn(),
  withTenantTx: vi.fn(),
}));
vi.mock('@ensemus/application/saas/standing', async (original) => ({
  ...(await original<typeof standing>()),
  provisionTenant: vi.fn(),
  setTenantStandingInTx: vi.fn(),
}));
const folder = resolve(mkdtempSync(join(tmpdir(), 'tenant-command-')));
afterAll(() => {
  if (!folder.startsWith(resolve(tmpdir()) + sep)) throw new Error('TEST_PATH_ESCAPED');
  rmSync(folder, { recursive: true, force: true });
});
const fileWith = (value: unknown) => {
  const path = join(folder, `${randomUUID()}.json`);
  writeFileSync(path, JSON.stringify(value));
  return path;
};
const agents = { haltTenantAgents: vi.fn(), releaseTenantAgents: vi.fn() };
const provisioner = { prepare: vi.fn(), issueOwnerInvitationInTx: vi.fn() };
const close = vi.fn(async () => undefined);
const provision = {
  organizationName: 'Generated organization',
  commercialMode: 'byom',
  ownerEmail: 'owner@example.invalid',
  planVersionId: randomUUID(),
  operatorRef: 'test-operator',
  requestKey: randomUUID(),
};
const move = {
  organizationId: randomUUID(),
  operatorRef: 'test-operator',
  reasonCode: 'TEST_TERMS',
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readSecret).mockReturnValue('generated-test-url');
  vi.mocked(openAppDatabase).mockReturnValue({
    db: {} as ReturnType<typeof openAppDatabase>['db'],
    close,
  });
  vi.mocked(withTenantTx).mockImplementation(async (_db, _ctx, fn) =>
    fn({} as Parameters<Parameters<typeof withTenantTx>[2]>[0]),
  );
  vi.mocked(standing.setTenantStandingInTx).mockResolvedValue('changed');
});

describe('trusted tenant commands', () => {
  it.each([[], ['unknown'], ['suspend'], ['resume', '--unknown', 'x']])(
    'invalid arguments touch no secret or database: %s',
    async (...args) => {
      expect(await tenantCommand(args as string[], { agents, provisioner })).toBe(2);
      expect(readSecret).not.toHaveBeenCalled();
      expect(openAppDatabase).not.toHaveBeenCalled();
    },
  );
  it('missing provisioning capability and malformed input refuse before reading credentials', async () => {
    expect(
      await tenantCommand(['suspend', '--file', fileWith({ ...move, reasonCode: 'free text' })], {
        agents,
      }),
    ).toBe(2);
    expect(await tenantCommand(['provision', '--file', fileWith(provision)], { provisioner })).toBe(
      2,
    );
    expect(readSecret).not.toHaveBeenCalled();
  });
  it('binds the actual standing SQL adapter when no test override is supplied', async () => {
    expect(await tenantCommand(['suspend', '--file', fileWith(move)])).toBe(0);
    const actual = vi.mocked(standing.setTenantStandingInTx).mock.calls[0]![3];
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    await expect(
      actual.haltTenantAgents(
        { execute } as never,
        {
          organizationId: move.organizationId,
          actorType: 'service',
        } as never,
        move.reasonCode,
      ),
    ).rejects.toMatchObject({ code: 'PREREQUISITES_INCOMPLETE' });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('missing secret refuses before database access', async () => {
    vi.mocked(readSecret).mockImplementation(() => {
      throw new Error('TEST_MISSING');
    });
    expect(await tenantCommand(['resume', '--file', fileWith(move)], { agents })).toBe(2);
    expect(openAppDatabase).not.toHaveBeenCalled();
  });
  it.each(['suspend', 'resume'])(
    '%s uses a service context, given reason and real injected port',
    async (command) => {
      expect(await tenantCommand([command, '--file', fileWith(move)], { agents })).toBe(0);
      expect(standing.setTenantStandingInTx).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ organizationId: move.organizationId, actorType: 'service' }),
        {
          to: command === 'suspend' ? 'suspended' : 'active',
          reasonCode: move.reasonCode,
          actor: { type: 'operator', ref: move.operatorRef },
        },
        agents,
      );
      expect(close).toHaveBeenCalledOnce();
    },
  );
  it('business refusals close the pool without echoing operator text', async () => {
    vi.mocked(standing.setTenantStandingInTx).mockRejectedValue(new AppError('INVALID_TRANSITION'));
    expect(await tenantCommand(['resume', '--file', fileWith(move)], { agents })).toBe(2);
    expect(close).toHaveBeenCalledOnce();
  });
  it('provision writes the one-time token only to an exclusive private file before commit', async () => {
    const invitationFile = join(folder, randomUUID());
    const invitationToken = randomUUID();
    vi.mocked(standing.provisionTenant).mockImplementation(async (_db, _input, _port, deliver) => {
      const result = { organizationId: randomUUID(), invitationToken };
      await deliver?.(result);
      return result;
    });
    expect(
      await tenantCommand(
        ['provision', '--file', fileWith(provision), '--invitation-file', invitationFile],
        { provisioner },
      ),
    ).toBe(0);
    expect(JSON.parse(readFileSync(invitationFile, 'utf8'))).toMatchObject({ invitationToken });
    expect(close).toHaveBeenCalledOnce();
  });
  it('an existing invitation destination is never overwritten or provisioned', async () => {
    const invitationFile = fileWith({ original: true });
    expect(
      await tenantCommand(
        ['provision', '--file', fileWith(provision), '--invitation-file', invitationFile],
        { provisioner },
      ),
    ).toBe(2);
    expect(standing.provisionTenant).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(invitationFile, 'utf8'))).toEqual({ original: true });
  });
  it('failed provisioning removes its empty private output and closes the database', async () => {
    const invitationFile = join(folder, randomUUID());
    vi.mocked(standing.provisionTenant).mockRejectedValue(new AppError('VERSION_CONFLICT'));
    expect(
      await tenantCommand(
        ['provision', '--file', fileWith(provision), '--invitation-file', invitationFile],
        { provisioner },
      ),
    ).toBe(2);
    expect(existsSync(invitationFile)).toBe(false);
    expect(close).toHaveBeenCalledOnce();
  });
});
