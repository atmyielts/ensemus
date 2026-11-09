// ADR-028 open question 12, part 1, for the integration suites only. Delegated child birth is open only
// while the latest counting ai.delegation_birth_capabilities row says 'qualified'. Migration 0590 writes no
// row, so every deployed database stays closed. A suite that needs a genuine child appends a
// 'qualification_fixture' row through the real migrator login (never a superuser SET ROLE, which the
// ledger refuses) and appends the prior state back afterwards. Rows are append-only, so restoring means
// appending, never deleting. Integration files run one at a time (fileParallelism: false).
//
// A fixture row is accepted, and counts, only in a cluster that holds the NOLOGIN marker role
// ensemus_delegation_qualification_ci, which tests/integration/global-setup.ts creates as the test
// superuser. In any other database the ledger refuses the append, and ignores a fixture row, so nothing
// here can open birth outside CI. This needs 0590 applied: it is not journaled on its branch, so these
// suites cannot run until the merge that journals it.
import pg from 'pg';
import { urls } from './stack';

/** The full tag set the ledger's CHECK requires on every 'qualified' row. */
export const DELEGATION_QUALIFICATION_TAGS = [
  'ADR028-Q12-L1',
  'ADR028-Q12-L2',
  'ADR028-Q12-L3',
  'ADR028-Q12-L4',
  'ADR028-Q12-L5',
  'ADR028-Q12-L6',
  'ADR028-Q12-L7',
  'ADR028-Q12-L8a',
  'ADR028-Q12-L8b',
  'ADR028-Q12-P2',
] as const;

export type DelegationCapabilityState = 'qualified' | 'revoked' | null;

const FIXTURE_LABEL = /^[A-Za-z0-9_.-]{1,64}$/;
/** The commit under test when CI names one, otherwise a fixed placeholder: a fixture row proves nothing. */
const sourceCommit = () => {
  const sha = process.env.GITHUB_SHA ?? '';
  return /^[0-9a-f]{40}$/.test(sha) ? sha : '0'.repeat(40);
};

async function asMigrator<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: urls.migrator() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** The latest recorded state, read as the migrator (no runtime role can read the ledger). */
export function delegationCapabilityState(): Promise<DelegationCapabilityState> {
  return asMigrator(async (client) => {
    const { rows } = await client.query<{ state: 'qualified' | 'revoked' }>(
      'select state from ai.delegation_birth_capabilities order by seq desc limit 1',
    );
    return rows[0]?.state ?? null;
  });
}

/** Appends one fixture row. A 'qualified' row carries the full tag set, as the CHECK requires. */
export function appendDelegationCapability(
  state: 'qualified' | 'revoked',
  label: string,
): Promise<void> {
  if (!FIXTURE_LABEL.test(label)) throw new Error('TEST_CAPABILITY_LABEL_INVALID');
  return asMigrator(async (client) => {
    await client.query(
      `insert into ai.delegation_birth_capabilities(state,evidence_kind,ci_run_id,source_commit,qualification_tests,review_ref)
       values($1,'qualification_fixture',$2,$3,$4::text[],$5)`,
      [
        state,
        `fixture:${label}`,
        sourceCommit(),
        state === 'qualified' ? [...DELEGATION_QUALIFICATION_TAGS] : [],
        'ADR-028 open question 12 qualification fixture (integration suite)',
      ],
    );
  });
}

/**
 * Opens delegated child birth for one suite. `restore` appends the state that was latest before, so a
 * database whose deployment row already says 'qualified' (0591, once written) stays qualified.
 */
export async function qualifyDelegationForSuite(label: string): Promise<{
  restore(): Promise<void>;
}> {
  const prior = await delegationCapabilityState();
  await appendDelegationCapability('qualified', label);
  return {
    async restore() {
      await appendDelegationCapability(prior === 'qualified' ? 'qualified' : 'revoked', label);
    },
  };
}
