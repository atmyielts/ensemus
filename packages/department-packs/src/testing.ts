// The suite every pack has to pass, in its own test file. Lint keeps this out of everything shipped, and nothing
// here reaches past the pack's own data, so it runs with no database and no network.
import {
  checkDepartmentPack,
  checkPackUpgrade,
  type DepartmentPack,
} from '@ensemus/domain/department-pack';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import agentDefinition from '../../../docs/specifications/schemas/agent-definition.schema.json';

const validateAgent = (() => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats.default(ajv);
  return ajv.compile(agentDefinition);
})();

export type PackConformanceOptions = {
  /** The tools this department must never have, on top of what every pack is refused. */
  forbiddenTools?: readonly RegExp[];
  /** The next version of this pack, to run its upgrade and rollback rules. */
  next?: DepartmentPack;
};

/**
 * Registers the review rules for one pack. Passing means it is fit for a person to review, and nothing more,
 * so a pack's own test file adds the scenario for its guardrail.
 */
export function describePackConformance(
  pack: DepartmentPack,
  options: PackConformanceOptions = {},
): void {
  describe(`pack conformance: ${pack.id}`, () => {
    it('passes every review rule', () => {
      expect(checkDepartmentPack(pack)).toEqual([]);
    });

    it('asks for everything, and is granted nothing by installing', () => {
      const requests = [...pack.requests.capabilities, ...pack.requests.dataAccess];
      expect(requests.length).toBeGreaterThan(0);
      for (const request of requests) expect(request.grantedOnInstall).toBe(false);
    });

    it.each(pack.agents.map((agent) => [agent.id, agent] as const))(
      'has a valid agent definition: %s',
      (_id, agent) => {
        expect(validateAgent(agent), JSON.stringify(validateAgent.errors)).toBe(true);
      },
    );

    it('asks for no tool this department must never have', () => {
      for (const tool of pack.requests.tools) {
        for (const forbidden of options.forbiddenTools ?? []) {
          expect(tool).not.toMatch(forbidden);
        }
      }
    });

    it('has a denied scenario for each agent or says why its guardrail is proved elsewhere', () => {
      expect(pack.evaluation.some((scenario) => scenario.kind === 'denied')).toBe(true);
    });

    if (options.next) {
      const { next } = options;
      it('passes the upgrade and rollback rules', () => {
        expect(checkDepartmentPack(next)).toEqual([]);
        expect(checkPackUpgrade(pack, next)).toEqual([]);
      });
    }
  });
}
