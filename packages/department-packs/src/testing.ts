// The suite every pack has to pass, in its own test file. Lint keeps this out of everything shipped, and nothing
// here reaches past the pack's own data, so it runs with no database and no network. The final merge adds M7's
// `validatePackManifest` and `planPackUpgrade` here, since a pack has to pass those as well.
import {
  checkDepartmentPack,
  checkPackUpgrade,
  newCapabilitiesIn,
  type DepartmentPackManifest,
} from '@ensemus/domain/department-pack';
import { describe, expect, it } from 'vitest';
import { validatePackManifest, planPackUpgrade } from '@ensemus/domain/pack';

export type PackConformanceOptions = {
  /** The tools this department must never have, on top of what every pack is refused. */
  forbiddenTools?: readonly RegExp[];
  /** Capabilities each later version adds, by key, so nothing new goes unnoticed. */
  expectedNewCapabilities?: Readonly<Record<string, readonly string[]>>;
};

/**
 * Registers the review and rollback rules for every shipped version of one pack, oldest first. Passing means
 * it is fit for a person to review and nothing more, so a pack's own test file adds its guardrail.
 */
export function describePackConformance(
  versions: readonly DepartmentPackManifest[],
  options: PackConformanceOptions = {},
): void {
  describe(`pack conformance: ${versions[0]?.key ?? 'empty'}`, () => {
    it('ships at least two versions, so upgrade and rollback are real', () => {
      expect(versions.length).toBeGreaterThanOrEqual(2);
    });

    it.each(versions.map((pack) => [pack.version, pack] as const))(
      'passes every review rule at %s',
      (_version, pack) => {
        expect(checkDepartmentPack(pack)).toEqual([]);
        expect(validatePackManifest(pack)).toEqual([]);
      },
    );

    it.each(versions.map((pack) => [pack.version, pack] as const))(
      'asks for no tool this department must never have at %s',
      (_version, pack) => {
        const tools = [
          ...pack.capabilities.map((capability) => capability.subject),
          ...pack.agentDrafts.flatMap((agent) => agent.answers.toolIds),
          ...pack.processes.flatMap((process) =>
            process.graph.nodes.flatMap((node) => (node.toolId ? [node.toolId] : [])),
          ),
        ];
        for (const tool of tools) {
          for (const forbidden of options.forbiddenTools ?? []) expect(tool).not.toMatch(forbidden);
        }
      },
    );

    it('passes the rollback rules between each version and the next', () => {
      for (let index = 1; index < versions.length; index += 1) {
        const from = versions[index - 1] as DepartmentPackManifest;
        const to = versions[index] as DepartmentPackManifest;
        expect(checkPackUpgrade(from, to)).toEqual([]);
        expect(planPackUpgrade(from, to).refused).toBe(false);
        expect(newCapabilitiesIn(from, to)).toEqual(
          options.expectedNewCapabilities?.[to.version] ?? [],
        );
      }
    });

    it('is one pack, with one key, at distinct versions', () => {
      expect(new Set(versions.map((pack) => pack.key)).size).toBe(1);
      expect(new Set(versions.map((pack) => pack.version)).size).toBe(versions.length);
    });
  });
}
