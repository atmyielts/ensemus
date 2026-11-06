import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  inventoryFromObservations,
  isRunInputFence,
  workInputHash,
  type ObservedInput,
} from './input-ledger';
const workId = randomUUID(),
  artifactId = randomUUID(),
  hash = 'a'.repeat(64);
const work: ObservedInput = {
  kind: 'work_unit',
  id: workId,
  sha256: hash,
  classification: 'internal',
};
describe('durable exhaustive input inventory', () => {
  it.each([
    { complete: false, fenced: false },
    { complete: true, fenced: true },
  ])('never turns incomplete/fenced history into a known inventory', (flags) => {
    expect(
      inventoryFromObservations({ ...flags, workUnitId: workId, observations: [work] }),
    ).toBeNull();
  });
  it('requires an explicit target Work observation even with other inputs', () => {
    expect(
      inventoryFromObservations({
        complete: true,
        fenced: false,
        workUnitId: workId,
        observations: [{ ...work, id: randomUUID() }],
      }),
    ).toBeNull();
  });
  it('preserves actual mutable rereads and all uncited artifact observations', () => {
    const proof = inventoryFromObservations({
      complete: true,
      fenced: false,
      workUnitId: workId,
      observations: [
        work,
        { ...work, sha256: 'b'.repeat(64) },
        { kind: 'artifact', id: artifactId, sha256: hash, classification: 'restricted' },
      ],
    });
    expect(proof?.recordInputs).toHaveLength(2);
    expect(proof?.artifactInputs).toEqual([{ artifactId, sha256: hash }]);
  });
  it('refuses conflicting immutable file hashes, malformed observations and an unbounded run', () => {
    for (const observations of [
      [
        work,
        { kind: 'artifact', id: artifactId, sha256: hash, classification: 'internal' },
        { kind: 'artifact', id: artifactId, sha256: 'b'.repeat(64), classification: 'internal' },
      ],
      [{ ...work, sha256: 'invalid' }],
      Array.from({ length: 1001 }, () => work),
    ])
      expect(
        inventoryFromObservations({
          complete: true,
          fenced: false,
          workUnitId: workId,
          observations: observations as readonly ObservedInput[],
        }),
      ).toBeNull();
  });
  it('hashes exactly the returned Work task fields, without a live-body equality assumption', () => {
    expect(workInputHash({ title: 'A', objective: null })).toBe(
      workInputHash({ objective: null, title: 'A' }),
    );
    expect(workInputHash({ title: 'A', objective: null })).not.toBe(
      workInputHash({ title: 'B', objective: null }),
    );
  });
  it('recognizes only the explicit sanitized SQL content-fence code', () => {
    expect(isRunInputFence({ code: 'EN119' })).toBe(true);
    expect(isRunInputFence({ cause: { code: 'EN119' } })).toBe(true);
    expect(isRunInputFence({ code: '42501' })).toBe(false);
    expect(isRunInputFence(new Error('RUN_INPUT_FENCED company text'))).toBe(false);
  });
});
