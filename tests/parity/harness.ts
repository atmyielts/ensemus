// COMM-06: runs scenarios against the stack the gate started, and records what they saw. Nothing here
// runs a mode: the gate starts the same images with a different ENSEMUS_MODE, and this file checks that
// the deployment really says it is that mode before believing anything it does.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { createOrganization, read, signUp } from '../helpers/forms';
import { repoRoot, urls } from '../helpers/stack';
import { PARITY_CATALOG } from './catalog';
import { type ContractDimensionName, expectedFor } from './contract';
import {
  COMMERCIAL_MODES,
  type CommercialMode,
  identifiersIn,
  type Observation,
  type ParityScenarioSpec,
  type ScenarioResult,
} from './rules';
import { type ParitySeams, type ParityTenant, seamFrom, SeamNotWired } from './seams';
import { wiring } from './wiring';

export const parityResultsDir = (mode: CommercialMode) =>
  joinPath(repoRoot, '.local', 'parity', mode);

export function modeUnderTest(env: NodeJS.ProcessEnv = process.env): CommercialMode {
  const named = env.ENSEMUS_PARITY_MODE;
  const mode = COMMERCIAL_MODES.find((candidate) => candidate === named);
  if (!mode) {
    throw new Error(
      'Set ENSEMUS_PARITY_MODE to cloud, byom or sovereign. infrastructure/scripts/parity-gate.mjs does this.',
    );
  }
  return mode;
}

/** What the setup page names each mode. It is the deployment's own statement to the person using it. */
const DEPLOYMENT_NAMES: Readonly<Record<CommercialMode, string>> = {
  cloud: 'Ensemus Cloud',
  byom: 'Ensemus with your own models',
  sovereign: 'Ensemus Sovereign',
};

export const statedDeployment = (html: string) =>
  /<p\b[^>]*>(?:This deployment is|You are using) ([^<.]+)\.<\/p>/.exec(
    html.replaceAll('<!-- -->', ''),
  )?.[1];

export interface ParityContext {
  readonly mode: CommercialMode;
  /** The superuser connection, for the setup and checks stack tests already use it for. */
  readonly su: pg.Client;
  /** A new organization and owner, through the real forms, named so nothing collides. */
  tenant(label?: string): Promise<ParityTenant>;
  /** A seam from another milestone. An unplugged one marks this scenario blocked. */
  seam<K extends keyof ParitySeams>(name: K): ParitySeams[K];
  /** What the commercial contract says this mode must observe on one dimension. */
  expected(dimension: ContractDimensionName): string;
}

/**
 * Returns what the scenario saw: statuses, codes, counts and sequences that describe the behaviour, and
 * no IDs, names, addresses or times. For a shared scenario this is what gets compared across modes.
 */
export type ParityScenario = (context: ParityContext) => Promise<Observation>;

const specOf = (id: string): ParityScenarioSpec => {
  const spec = PARITY_CATALOG.find((candidate) => candidate.id === id);
  if (!spec) throw new Error(`${id} is not in tests/parity/catalog.ts`);
  return spec;
};

/**
 * Declares one scenario file. A scenario for another file, or one the catalog does not list, stops the
 * file. A scenario that does not apply to this mode is not run and not reported.
 */
export function describeParity(file: string, scenarios: Readonly<Record<string, ParityScenario>>) {
  const mode = modeUnderTest();
  const results: ScenarioResult[] = [];
  for (const id of Object.keys(scenarios)) {
    if (specOf(id).file !== file) {
      throw new Error(`${id} belongs to ${specOf(id).file}, not ${file}`);
    }
  }

  describe(`${file} in ${mode}`, () => {
    let su: pg.Client;

    beforeAll(async () => {
      su = new pg.Client({ connectionString: urls.superuser() });
      await su.connect();
      await confirmDeployedMode(mode);
    });

    afterAll(async () => {
      await su?.end();
      const dir = parityResultsDir(mode);
      mkdirSync(dir, { recursive: true });
      writeFileSync(joinPath(dir, `${file}.json`), `${JSON.stringify(results, null, 2)}\n`);
    });

    for (const [id, scenario] of Object.entries(scenarios)) {
      const spec = specOf(id);
      if (!spec.modes.includes(mode)) continue;
      it(`${id}: ${spec.title}`, async ({ skip }) => {
        const context: ParityContext = {
          mode,
          su,
          tenant: async (label = 'Parity') => {
            const owner = await signUp(`${label} Owner`);
            const organization = await createOrganization(owner, `${label} ${randomUUID()}`);
            return { organization, owner };
          },
          seam: (name) => seamFrom(wiring, name),
          expected: (dimension) => expectedFor(dimension, mode),
        };
        try {
          const observed = await scenario(context);
          const identifiers = identifiersIn(observed);
          if (identifiers.length > 0) {
            throw new Error(`An observation must not hold ${identifiers.join('; ')}`);
          }
          results.push({ id, outcome: 'pass', observed });
        } catch (error) {
          if (error instanceof SeamNotWired) {
            results.push({ id, outcome: 'blocked', blockedBy: error.message });
            skip(error.message);
            return;
          }
          const failure = error instanceof Error ? error.message : String(error);
          results.push({ id, outcome: 'fail', failure });
          throw error;
        }
      });
    }
  });
}

/** Signs a new person up and reads what the deployment says it is. A mismatch stops the whole file. */
async function confirmDeployedMode(mode: CommercialMode) {
  const person = await signUp('Parity Mode Check');
  const { html } = await read('/', person.jar);
  const stated = statedDeployment(html);
  if (stated !== DEPLOYMENT_NAMES[mode]) {
    throw new Error(
      `Told to test ${mode}, but the deployment says it is ${stated ?? 'nothing readable'}.`,
    );
  }
}
