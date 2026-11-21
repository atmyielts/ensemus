// COMM-06: what the modes scenarios share. It reads what the product said and derives a contract value from
// it, so a mode_contract scenario compares two independent things: what the deployment did, and what
// tests/parity/contract.ts says it must do. Nothing here decides an answer from the mode under test, except
// the words each mode is held to on its own statement.
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type pg from 'pg';
import { expect } from 'vitest';
import { createWork, locationOf, move, statusOn, workPage } from '../../helpers/flows';
import { join, PASSWORD, read, submit, tokenIn } from '../../helpers/forms';
import { repoRoot } from '../../helpers/stack';
import {
  ACCEPTED_MANIFESTS,
  type ManifestCase,
  MANIFESTS_REFUSED_BY_FORMAT,
  MANIFESTS_REFUSED_BY_RULES,
  NEXT_VERSION,
  SAME_VERSION_WIDENED,
} from '../fixtures/agent-manifests';
import type { CommercialMode } from '../rules';
import type { AgentRunSeam, ModelCallResult, ModelSupplySeam, ParityTenant } from '../seams';

/** One work item of an ordinary class, for the call that is meant to reach a provider. */
export const INTERNAL_CHAT = { dataClass: 'internal', purpose: 'chat' } as const;
export const INTERNAL_EMBEDDING = { dataClass: 'internal', purpose: 'embedding' } as const;

const REFUSAL_CODE = /^[A-Z][A-Z0-9_]+$/;

/** A code a client could act on. A provider's words or a sentence would fail this, and must. */
export function expectRefusalCode(code: unknown): asserts code is string {
  expect(code).toEqual(expect.stringMatching(REFUSAL_CODE));
}

// --- The responsibility statement (ID-01).

/** The words that mean each value of `responsibility_statement`. A value's meaning is here, not its name. */
const HOLDER_WORDS = {
  ensemus_hosted: [
    'Ensemus hosts this service',
    'stores your organization',
    'The data stays yours',
  ],
  customer_controlled: [
    'on infrastructure it controls',
    'It does not rely on services hosted by Ensemus',
    'responsible for operating, securing and backing up',
  ],
} as const;

export type StatedHolder = keyof typeof HOLDER_WORDS | 'contradictory' | 'unstated';

/** Who the statement says holds the data. Saying both, or only part of either, is not an answer. */
export function holderStatedIn(statement: string): StatedHolder {
  const says = (words: readonly string[]) => words.filter((word) => statement.includes(word));
  const hosted = says(HOLDER_WORDS.ensemus_hosted).length;
  const controlled = says(HOLDER_WORDS.customer_controlled).length;
  if (hosted > 0 && controlled > 0) return 'contradictory';
  if (hosted === HOLDER_WORDS.ensemus_hosted.length) return 'ensemus_hosted';
  if (controlled === HOLDER_WORDS.customer_controlled.length) return 'customer_controlled';
  return 'unstated';
}

/**
 * What each mode must add in its own words. Cloud and BYOM hold data the same way, and differ on models,
 * and BYOM's caveat is the one a customer is most likely to assume away (05-commercial-modes.md).
 */
export const MODE_WORDS: Readonly<
  Record<
    CommercialMode,
    {
      readonly deployment: string;
      readonly says: readonly string[];
      readonly neverSays: readonly string[];
    }
  >
> = {
  cloud: {
    deployment: 'Ensemus Cloud',
    says: ['Ensemus supplies the approved AI model providers'],
    neverSays: ['with your own keys', 'This is not zero-knowledge'],
  },
  byom: {
    deployment: 'Ensemus with your own models',
    says: [
      'with your own keys',
      'you pay those providers directly',
      'This is not zero-knowledge',
      'does not keep your data from Ensemus',
    ],
    neverSays: ['Ensemus supplies the approved'],
  },
  sovereign: {
    deployment: 'Ensemus Sovereign',
    says: ['Diagnostics leave only if you choose to send them', 'what its models cost'],
    neverSays: ['Ensemus supplies the approved', 'This is not zero-knowledge'],
  },
};

// --- Agent manifests.

/**
 * Holds the fixtures to the format's own schema, so each one is refused for the reason its list claims. A
 * case on the wrong list would otherwise still get a code, and read as parity. The schema is read when this
 * runs, so the check follows the file rather than a copy of it.
 */
export function manifestsThatDriftedFromTheSchema(): readonly string[] {
  const schema = readFileSync(
    joinPath(repoRoot, 'docs/specifications/schemas/agent-definition.schema.json'),
    'utf8',
  );
  const validate = new Ajv2020({ strict: false, allErrors: true }).compile(
    JSON.parse(schema) as object,
  );
  const wellFormed = [
    ...ACCEPTED_MANIFESTS,
    ...MANIFESTS_REFUSED_BY_RULES,
    NEXT_VERSION,
    SAME_VERSION_WIDENED,
  ];
  return [
    ...wellFormed.filter(({ manifest }) => !validate(manifest)),
    ...MANIFESTS_REFUSED_BY_FORMAT.filter(({ manifest }) => validate(manifest)),
  ].map(({ name }) => name);
}

/** Publishes each case in order. A null is accepted, and anything else is the code it was refused with. */
export async function publishEach(
  agents: AgentRunSeam,
  tenant: ParityTenant,
  cases: readonly ManifestCase[],
): Promise<Readonly<Record<string, string | null>>> {
  const answers: Record<string, string | null> = {};
  for (const { name, manifest } of cases) {
    answers[name] = await agents.publishManifest(tenant, manifest);
  }
  return answers;
}

/** How many versions the organization really holds, so a refusal is shown to have written nothing. */
export async function agentVersionsStored(su: pg.Client, organization: string): Promise<number> {
  const { rows } = await su.query<{ versions: number }>(
    'select count(*)::int as versions from ai.agent_versions where organization_id = $1',
    [organization],
  );
  return rows[0]?.versions ?? 0;
}

// --- Model calls.

/** What a call did, and how many calls reached the provider's side while it ran. */
export async function counted(
  supply: ModelSupplySeam,
  call: () => Promise<ModelCallResult>,
): Promise<{ readonly answer: ModelCallResult; readonly calls: number }> {
  const before = await supply.callsReceived();
  const answer = await call();
  return { answer, calls: (await supply.callsReceived()) - before };
}

/** A denied call, with its code for the observation. Anything else fails where it happened. */
export function deniedCode(answer: ModelCallResult): string {
  if (answer.result !== 'denied') throw new Error('The call was answered, and should be denied.');
  expectRefusalCode(answer.code);
  return answer.code;
}

// --- Charges (QA-026, QA-027). A row count says who was charged and how often, and holds no amount.

export interface LedgerGroup {
  readonly meter: string;
  readonly billable: boolean;
  readonly commercial_mode: string;
  readonly entries: number;
}

/** Corrections are left out: they correct an entry, and are not a second charge. */
export async function ledgerOf(su: pg.Client, organization: string): Promise<readonly LedgerGroup[]> {
  const { rows } = await su.query<LedgerGroup>(
    `select meter, billable, commercial_mode, count(*)::int as entries
       from platform.usage_ledger
      where organization_id = $1 and status <> 'correction'
      group by meter, billable, commercial_mode
      order by meter, billable, commercial_mode`,
    [organization],
  );
  return rows;
}

export interface Charges {
  readonly billed: number;
  readonly unbilled: number;
  /** Meters with more than one billable entry. After exactly one model call this is a double charge. */
  readonly chargedTwice: number;
  /** The contract's word for whoever the ledger shows paying, in `inference_billing` terms. */
  readonly payer: 'ensemus' | 'customer_direct' | 'both' | 'nothing_recorded';
}

export function chargesIn(ledger: readonly LedgerGroup[]): Charges {
  const total = (billable: boolean) =>
    ledger
      .filter((group) => group.billable === billable)
      .reduce((sum, group) => sum + group.entries, 0);
  const billed = total(true);
  const unbilled = total(false);
  const perMeter = new Map<string, number>();
  for (const group of ledger.filter((candidate) => candidate.billable)) {
    perMeter.set(group.meter, (perMeter.get(group.meter) ?? 0) + group.entries);
  }
  const payer =
    billed > 0 && unbilled > 0
      ? 'both'
      : billed > 0
        ? 'ensemus'
        : unbilled > 0
          ? 'customer_direct'
          : 'nothing_recorded';
  return {
    billed,
    unbilled,
    chargedTwice: [...perMeter.values()].filter((entries) => entries > 1).length,
    payer,
  };
}

// --- Core work, through the product's own forms.

const STATUSES_TO_DONE = [
  ['ready', 'Ready'],
  ['running', 'In progress'],
  ['verifying', 'Checking'],
  ['completed', 'Done'],
] as const;

const statusSeen = async ({ organization, owner }: ParityTenant, id: string): Promise<string> => {
  const { status, html } = await read(workPage(organization, id), owner.jar);
  expect(status).toBe(200);
  const stated = statusOn(html);
  if (!stated) throw new Error('The work page states no status');
  return stated;
};

/** New work, as far as `In progress`. What is left is what `finishWork` does. */
export async function startWork(tenant: ParityTenant) {
  const { organization, owner } = tenant;
  const id = await createWork(owner, organization, {
    title: `Parity work ${randomUUID()}`,
    objective: 'Move through each status.',
  });
  const seen = [await statusSeen(tenant, id)];
  for (const [to, label] of STATUSES_TO_DONE.slice(0, 2)) {
    await move(owner, organization, id, to);
    seen.push(await statusSeen(tenant, id));
    expect(seen.at(-1)).toBe(label);
  }
  return { id, seen };
}

export async function finishWork(tenant: ParityTenant, id: string): Promise<readonly string[]> {
  const seen: string[] = [];
  for (const [to, label] of STATUSES_TO_DONE.slice(2)) {
    await move(tenant.owner, tenant.organization, id, to);
    seen.push(await statusSeen(tenant, id));
    expect(seen.at(-1)).toBe(label);
  }
  return seen;
}

export async function walkWorkToDone(tenant: ParityTenant): Promise<readonly string[]> {
  const { id, seen } = await startWork(tenant);
  return [...seen, ...(await finishWork(tenant, id))];
}

/** An answer that went through: a redirect that names no error. A refusal looks like one with `?error=`. */
const expectSaved = (response: Response) => {
  expect(response.status).toBe(303);
  expect(locationOf(response)).not.toContain('error=');
};

export interface SeededRecords {
  /** Generated text that belongs to this organization, so a search can be shown to find what is there. */
  readonly workTitle: string;
  /** Records of business data this made, so a count can be shown to include them. */
  readonly records: number;
}

/**
 * Business records with a relationship between them: a person, a client, a project, and two pieces of work
 * where one waits on the other. Generated names only.
 */
export async function seedBusinessRecords(tenant: ParityTenant): Promise<SeededRecords> {
  const { organization, owner } = tenant;
  const clients = `/o/${organization}/clients`;
  const workTitle = `Parity record ${randomUUID()}`;
  const clientName = `Parity client ${randomUUID()}`;
  const projectName = `Parity project ${randomUUID()}`;

  await join(owner, organization, 'Parity Member');
  expectSaved(await submit(clients, owner.jar, /name="displayName"/, { displayName: clientName }));
  expectSaved(await submit(clients, owner.jar, /Add project/, { name: projectName }));
  const listed = await read(clients, owner.jar);
  expect(listed.html).toContain(clientName);
  expect(listed.html).toContain(projectName);

  const prerequisite = await createWork(owner, organization, { title: workTitle });
  const waiting = await createWork(owner, organization, { title: `Parity next ${randomUUID()}` });
  const page = workPage(organization, waiting);
  const linked = await submit(page, owner.jar, /Add dependency/, { prerequisiteId: prerequisite });
  expect(locationOf(linked)).toBe(page);
  return { workTitle, records: 6 };
}

/** Read straight from the table, because an export writes audit entries, so exporting twice differs. */
export async function workUnitsStored(su: pg.Client, organization: string): Promise<number> {
  const { rows } = await su.query<{ units: number }>(
    'select count(*)::int as units from work.work_units where organization_id = $1',
    [organization],
  );
  return rows[0]?.units ?? 0;
}

/** Everything a person does on an ordinary day, as Sovereign has to do it with nothing outside. */
export async function exerciseCoreWork(tenant: ParityTenant) {
  const { organization, owner } = tenant;
  await seedBusinessRecords(tenant);
  const statuses = await walkWorkToDone(tenant);
  const home = `/o/${organization}`;
  const pages = [
    home,
    `${home}/work`,
    `${home}/work/new`,
    `${home}/approvals`,
    `${home}/people`,
    `${home}/clients`,
    `${home}/inbox`,
  ];
  for (const page of pages) expect((await read(page, owner.jar)).status, page).toBe(200);
  return { statuses, pagesRead: pages.length };
}

// --- Credentials an export must leave behind (QA-024).

/** A value nothing else holds, so finding it anywhere can only mean it was copied from where it was put. */
const generatedSecret = (kind: string) =>
  `PARITYSECRET${kind}${randomBytes(24).toString('base64url')}`;

export interface PlantedCredentials {
  /** Generated, and exported on purpose, so the search is shown to reach the connection it came with. */
  readonly connectionName: string;
  readonly secrets: Readonly<Record<string, string>>;
}

/**
 * Plants credentials where a real organization keeps them, with the superuser connection, as
 * tests/stack/canary.test.ts plants values: no product path lets anyone write one in clear, which is the
 * point. The rest are what the product itself issued to this owner.
 */
export async function plantCredentials(
  su: pg.Client,
  { organization, owner }: ParityTenant,
): Promise<PlantedCredentials> {
  const sealed = generatedSecret('SEALED');
  const inConfig = generatedSecret('CONFIG');
  const secretId = randomUUID();
  const connectionName = `Parity connection ${randomUUID()}`;
  const bytes = Buffer.from(sealed, 'utf8');
  await su.query(
    `insert into secrets.sealed_secrets
       (organization_id, id, purpose, key_id, wrapped_key, iv, ciphertext, auth_tag)
     values ($1, $2, 'parity-canary', 'parity-test-key', $3, $3, $3, $3)`,
    [organization, secretId, bytes],
  );
  await su.query(
    `insert into integrations.connections
       (organization_id, id, connector_type, display_name, credential_secret_id, config)
     values ($1, $2, 'email_smtp', $3, $4, $5)`,
    [organization, randomUUID(), connectionName, secretId, JSON.stringify({ api_key: inConfig })],
  );

  const invited = await submit(`/o/${organization}/people`, owner.jar, /name="email"/, {
    email: `parity-${randomUUID()}@example.invalid`,
    role: 'member',
  });
  const invitationToken = tokenIn(await invited.text());
  if (!invitationToken) throw new Error('No invitation link to look for');

  // The cookie is the token and a signature. The token is the part that would open a session.
  const sessionCookie = /(?:^|; )[^=]*session_token=([^;]+)/.exec(owner.jar.cookie)?.[1];
  const sessionToken = decodeURIComponent(sessionCookie ?? '').split('.')[0];
  if (!sessionToken) throw new Error('No session cookie to look for');

  const accounts = await su.query<{ password: string }>(
    `select a.password from identity.accounts a join identity.users u on u.id = a.user_id
      where u.email = $1 and a.password is not null`,
    [owner.email],
  );
  const passwordHash = accounts.rows[0]?.password;
  if (!passwordHash) throw new Error('No password hash to look for');

  return {
    connectionName,
    secrets: {
      sealedCredential: sealed,
      // The same bytes as an export would write them, if it wrote a sealed row as a field.
      sealedCredentialEncoded: bytes.toString('base64'),
      connectionConfig: inConfig,
      invitationToken,
      sessionToken,
      passwordHash,
      password: PASSWORD,
    },
  };
}

// --- A contract value, from what was seen. Each returns something else when the behaviour is not there.

export const offlineOperationFrom = (attempts: number) =>
  attempts === 0 ? 'supported_profile' : 'reached_outside';

export const vendorTelemetryFrom = (attempts: number) =>
  attempts === 0 ? 'off_by_default' : 'sent_without_being_told';

export const licenseValidationFrom = (check: {
  readonly valid: boolean;
  readonly outsideContact: boolean;
}) =>
  !check.valid ? 'invalid' : check.outsideContact ? 'needed_outside_contact' : 'offline_certificate';

export const maintenanceLapseFrom = (
  check: { readonly valid: boolean },
  afterTheLapse: readonly (readonly string[])[],
) =>
  check.valid && afterTheLapse.every((statuses) => statuses.at(-1) === 'Done')
    ? 'continues_operating'
    : 'stopped_operating';

export const updatesFrom = (answers: {
  readonly tampered: string;
  readonly unsigned: string;
  readonly intact: string;
}) =>
  answers.tampered === 'refused' && answers.unsigned === 'refused' && answers.intact === 'accepted'
    ? 'self_applied'
    : 'unverified_bundles_apply';
