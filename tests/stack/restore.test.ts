// LIFE-01, ADR-026: restoring a backup cannot bring a deleted file back. The steps here are the ones in
// the runbook's backup and restore section: a real pg_dump and pg_restore into the running database,
// the real object store, the images' own commands, and the product through its pages.
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { objectKey, readArtifact, type ReapplyResult } from '@ensemus/application';
import { openAppDatabase, resolveTenantContext } from '@ensemus/database';
import {
  ledgerKeyFor,
  LEDGER_PREFIX,
  LEDGER_QUARANTINE_PREFIX,
  ledgerRef,
  quarantineKeyFor,
  serializeLedgerEntry,
  TOMBSTONE_RECORDED,
} from '@ensemus/domain/tombstone-ledger';
import { S3ObjectStore } from '@ensemus/storage';
import {
  createOrganization,
  formOn,
  onReplica,
  post,
  type Person,
  read,
  signUp,
  submit,
  tokenIn,
  visit,
} from '../helpers/forms';
import { createWork, locationOf, mainOf, workPage } from '../helpers/flows';
import { compose, secret, urls } from '../helpers/stack';
import { eventsPath, openStreams } from '../helpers/streams';

const LONG = 300_000;
const WAIT = { timeout: 30_000, interval: 250 };
/**
 * A ledger write normally takes under a second. A store that was slow or down delays it by up to two
 * 30-second waits: the one after the failure, and the event's own retry.
 */
const LEDGER_WAIT = { timeout: 90_000, interval: 250 };
/** The gate rechecks a tenant it last found clear every 30 seconds. */
const GATE_INTERVAL = { timeout: 45_000, interval: 500 };

const STORE = 'http://127.0.0.1:58333';
const BUCKET = 'ensemus';
const REGION = 'us-east-1';

const storeFor = (access: string, key: string) =>
  new S3ObjectStore({
    endpoint: STORE,
    bucket: BUCKET,
    accessKey: secret(access),
    secretKey: secret(key),
  });

/**
 * A DELETE signed with a credential (AWS Signature Version 4) and sent straight to the store, as anyone
 * holding that credential could send it. S3ObjectStore.delete first reads the bucket's versioning
 * (d66618c, the purge proof), which the ledger credential may not, so it never sends the DELETE, and it
 * reports any failure as OBJECT_PHYSICAL_ABSENCE_UNPROVEN. The store's own answer to the DELETE itself
 * is only reachable like this. Returns the status and the S3 error code, if there was one.
 */
async function signedDelete(access: string, key: string, objectKey: string) {
  const sha256 = (data: string) => createHash('sha256').update(data).digest('hex');
  const hmac = (secretKey: string | Buffer, data: string) =>
    createHmac('sha256', secretKey).update(data).digest();
  const host = new URL(STORE).host;
  const path = `/${BUCKET}/${objectKey.split('/').map(encodeURIComponent).join('/')}`;
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  const day = stamp.slice(0, 8);
  const scope = `${day}/${REGION}/s3/aws4_request`;
  const payload = sha256('');
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonical = [
    'DELETE',
    path,
    '',
    `host:${host}`,
    `x-amz-content-sha256:${payload}`,
    `x-amz-date:${stamp}`,
    '',
    signedHeaders,
    payload,
  ].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256(canonical)].join('\n');
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${secret(key)}`, day), REGION), 's3'),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(toSign).digest('hex');
  const response = await fetch(`${STORE}${path}`, {
    method: 'DELETE',
    headers: {
      'x-amz-content-sha256': payload,
      'x-amz-date': stamp,
      authorization:
        `AWS4-HMAC-SHA256 Credential=${secret(access)}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  });
  const text = await response.text();
  return { status: response.status, code: /<Code>([^<]+)<\/Code>/.exec(text)?.[1] };
}

/** The fields a command logged, from the last line of its output that carries this event. */
function logged(output: string, event: string) {
  const line = output
    .split('\n')
    .reverse()
    .find((text) => text.includes(`"${event}"`));
  if (!line) throw new Error(`The command did not log ${event}: ${output}`);
  return JSON.parse(line) as Record<string, unknown>;
}

const dump = (name: string) =>
  compose(
    'exec',
    '-T',
    'postgres',
    'pg_dump',
    '-U',
    'postgres',
    '-d',
    'ensemus',
    '-Fc',
    '-f',
    `/tmp/${name}.dump`,
  );

const restore = (name: string) =>
  compose(
    'exec',
    '-T',
    'postgres',
    'pg_restore',
    '-U',
    'postgres',
    '-d',
    'ensemus',
    '--clean',
    '--if-exists',
    '--single-transaction',
    '--exit-on-error',
    `/tmp/${name}.dump`,
  );

/**
 * Runs the operator's command, from the image. A failure to run it at all has no status of its own to
 * report, so this hands back the exit status as well as the output, and each test says what it expects.
 */
function runReapply(mounts: string[], args: string[]) {
  try {
    const output = compose(
      'run',
      '--rm',
      '--no-deps',
      ...mounts.flatMap((mount) => ['-v', mount]),
      'worker',
      'node',
      'dist/reapply-ledger.js',
      ...args,
    );
    return { status: 0, output };
  } catch (error) {
    const failure = error as { status?: unknown; stdout?: unknown };
    if (typeof failure.status !== 'number') throw error;
    return { status: failure.status, output: String(failure.stdout ?? '') };
  }
}

/** What the command reported, and the exit status the runbook tells an operator to go by. */
function reapply(...args: string[]) {
  const { status, output } = runReapply([], args);
  return {
    ...(logged(output, 'tombstone_ledger.reapplied') as unknown as ReapplyResult),
    status,
  };
}

/** The runbook's way of giving the command a list: the file is mounted, and read from there. */
function reapplyWithList(...lines: string[]) {
  const folder = mkdtempSync(join(tmpdir(), 'reapply-list-'));
  const path = join(folder, 'confirm.txt');
  writeFileSync(path, `${lines.join('\n')}\n`, { mode: 0o644 });
  try {
    return runReapply([`${path}:/tmp/confirm.txt:ro`], ['--confirm-file', '/tmp/confirm.txt']);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

const backlog = () =>
  logged(
    compose('run', '--rm', '--no-deps', 'dispatcher', 'node', 'dist/ledger-backlog.js'),
    'tombstone_ledger.backlog',
  ) as unknown as { queued: number; dead: number; oldestSeconds: number };

describe('restoring a database backup', () => {
  let su: pg.Client;
  let app: ReturnType<typeof openAppDatabase>;
  const admin = () => storeFor('objects_access_key', 'objects_secret_key');
  const ledgerOnly = () => storeFor('objects_ledger_access_key', 'objects_ledger_secret_key');

  let owner: Person;
  let org: string;
  let rival: Person;
  let rivalOrg: string;

  const answering = () =>
    expect
      .poll(
        async () =>
          (await onReplica('web-2', () => visit('/api/health/ready')).catch(() => null))?.status,
        { timeout: 90_000, interval: 500 },
      )
      .toBe(200);

  const filesPath = (organization: string, work: string, file: string) =>
    `${workPage(organization, work)}/files/${file}`;

  async function upload(person: Person, organization: string, work: string, file: File) {
    const page = workPage(organization, work);
    const response = await submit(page, person.jar, /name="file"/, { file });
    expect(response.status).toBe(303);
    const { html } = await read(page, person.jar);
    const escaped = file.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const id = new RegExp(`/files/([0-9a-f-]{36})">${escaped}<`).exec(html)?.[1];
    if (!id) throw new Error(`No link to ${file.name}`);
    return id;
  }

  async function remove(person: Person, organization: string, work: string, file: string) {
    const page = workPage(organization, work);
    const form = await formOn(page, person.jar, (f) => f.hidden.get('artifactId') === file);
    const response = await post(page, person.jar, form, { confirm: 'yes' });
    expect(response.status).toBe(303);
  }

  const keyFor = (organization: string, file: string) =>
    ledgerKeyFor({ organizationId: organization, targetType: 'artifact', targetId: file });

  async function ledgerKeys() {
    const keys: string[] = [];
    for await (const page of admin().listPages(LEDGER_PREFIX)) keys.push(...page);
    return keys;
  }

  const contextOf = async (person: Person, organization: string) => {
    const { rows } = await su.query('select id from identity.users where email = $1', [
      person.email,
    ]);
    return resolveTenantContext(app.db, rows[0].id as string, organization);
  };

  /** Everything a re-apply could change, so a second run can be shown to change none of it. */
  const stateOf = async (organization: string, work: string) => ({
    tombstones: (
      await su.query(
        'select target_id, created_at from platform.tombstones where organization_id = $1 order by 1',
        [organization],
      )
    ).rows,
    artifacts: (
      await su.query('select id from work.artifacts where organization_id = $1 order by 1', [
        organization,
      ])
    ).rows,
    links: (
      await su.query(
        'select artifact_id from work.work_artifacts where organization_id = $1 order by 1',
        [organization],
      )
    ).rows,
    blobs: (
      await su.query(
        `select artifact_id, state, purged_at, attempts from platform.blob_lifecycle
         where organization_id = $1 order by 1`,
        [organization],
      )
    ).rows,
    audit: (
      await su.query(
        'select count(*)::int as n from governance.audit_events where organization_id = $1',
        [organization],
      )
    ).rows,
    events: (
      await su.query(
        'select count(*)::int as n from platform.domain_events where organization_id = $1',
        [organization],
      )
    ).rows,
    version: (await su.query('select version::int as v from work.work_units where id = $1', [work]))
      .rows,
    ledger: (await ledgerKeys()).sort(),
  });

  beforeAll(async () => {
    su = new pg.Client({ connectionString: urls.superuser() });
    await su.connect();
    app = openAppDatabase(urls.app());
    owner = await signUp('Olive Restore');
    org = await createOrganization(owner, `Restore ${randomUUID()}`);
    rival = await signUp('Rory Rival');
    rivalOrg = await createOrganization(rival, `Rival ${randomUUID()}`);
  });

  afterAll(async () => {
    // Whatever happened here, the files after this one need these running.
    compose('start', 'dispatcher', 'worker', 'web', 'web-2', 'objects');
    await app?.close();
    await su?.end();
  });

  it(
    'closes a tenant on every way in, without a real restore to wait for',
    async () => {
      const person = await signUp('Paula Paths');
      const tenant = await createOrganization(person, `Paths ${randomUUID()}`);
      const work = await createWork(person, tenant, { title: `Paths ${randomUUID()}` });
      const invited = await signUp('Ivy Invited');
      const made = await submit(`/o/${tenant}/people`, person.jar, /name="email"/, {
        email: invited.email,
        role: 'member',
      });
      const token = tokenIn(await made.text());
      if (!token) throw new Error('No invitation link');
      const streams = openStreams();
      const stream = await streams.follow(person.jar, eventsPath(tenant, work));
      expect(stream.status).toBe(200);

      // What a restore leaves behind: a deletion the ledger knows about and the database does not.
      const entry = {
        organizationId: tenant,
        targetType: 'artifact',
        targetId: randomUUID(),
        deletedAt: new Date(),
      };
      const key = ledgerKeyFor(entry);
      await admin().put(key, serializeLedgerEntry(entry), 'application/json');
      try {
        const api = `/api/v1/organizations/${tenant}/work-units/${work}`;
        await expect
          .poll(async () => (await visit(api, person.jar)).status, GATE_INTERVAL)
          .toBe(503);

        // A stream opened before it closed does not stay open past that.
        await expect.poll(() => stream.ended(), WAIT).toBe(true);

        // The same tenant in capitals is still the same tenant.
        const shouted = tenant.toUpperCase();
        const shoutedPage = await visit(workPage(shouted, work), person.jar);
        expect(shoutedPage.status).toBe(307);
        expect(locationOf(shoutedPage)).toBe('/restoring');
        const shoutedApi = await visit(
          `/api/v1/organizations/${shouted}/work-units/${work}`,
          person.jar,
        );
        expect(shoutedApi.status).toBe(503);
        expect(await shoutedApi.json()).toMatchObject({ code: 'RESTORE_PENDING' });

        // Someone joining gets no membership, no claim and no notification out of this.
        const accepted = await submit(`/invite/${token}`, invited.jar, /Accept invitation/);
        expect(locationOf(accepted)).toBe('/restoring');
        const invitation = await su.query(
          'select accepted_at, claimed_at from org.invitations where organization_id = $1',
          [tenant],
        );
        expect(invitation.rows).toEqual([{ accepted_at: null, claimed_at: null }]);
        expect((await read(`/o/${tenant}`, invited.jar)).status).toBe(404);
      } finally {
        streams.closeAll();
        await admin().delete(key);
      }
    },
    LONG,
  );

  it(
    'cannot bring a deleted file back once the ledger is re-applied, and refuses to serve until then',
    async () => {
      const title = `Secret project ${randomUUID()}`;
      const work = await createWork(owner, org, { title });
      const doomedName = `doomed-${randomUUID()}.txt`;
      const keptName = `kept-${randomUUID()}.txt`;
      const content = `The doomed content ${randomUUID()}`;
      const doomed = await upload(
        owner,
        org,
        work,
        new File([content], doomedName, { type: 'text/plain' }),
      );
      const kept = await upload(
        owner,
        org,
        work,
        new File(['kept'], keptName, { type: 'text/plain' }),
      );
      const rivalWork = await createWork(rival, rivalOrg, { title: 'Theirs' });
      const rivalFile = await upload(
        rival,
        rivalOrg,
        rivalWork,
        new File(['theirs'], 'theirs.txt', { type: 'text/plain' }),
      );
      const page = workPage(org, work);
      const doomedPath = filesPath(org, work, doomed);
      const keptPath = filesPath(org, work, kept);
      const doomedBytes = objectKey(org, doomed);
      // For checking later that the refused action does nothing.
      const uploadForm = await formOn(page, owner.jar, /name="file"/);
      // The running replica has now found this tenant clear, and remembers that.
      expect((await read(page, owner.jar)).status).toBe(200);
      expect((await visit(doomedPath, owner.jar)).status).toBe(200);

      // A real backup, taken while the file exists.
      dump('life01');

      // Deleted through the page. Access stops at once, and the entry reaches the ledger.
      await remove(owner, org, work, doomed);
      expect((await visit(doomedPath, owner.jar)).status).toBe(404);
      expect(await admin().exists(doomedBytes)).toBe(false);
      const entryKey = keyFor(org, doomed);
      await expect.poll(() => admin().exists(entryKey), LEDGER_WAIT).toBe(true);
      expect(backlog().queued).toBe(0);

      // The ledger holds IDs, a type and a time. No name, title, address or content anywhere in it.
      const entry = JSON.parse((await admin().get(entryKey)).toString()) as Record<string, unknown>;
      expect(entry).toEqual({
        v: 1,
        organization_id: org,
        target_type: 'artifact',
        target_id: doomed,
        deleted_at: expect.any(String),
      });
      for (const key of await ledgerKeys()) {
        const text = `${key}\n${(await admin().get(key)).toString()}`;
        for (const secretText of [doomedName, keptName, title, content, owner.name, owner.email]) {
          expect(text).not.toContain(secretText);
        }
      }

      // The first steps of the runbook. One replica is deliberately left running, as if forgotten.
      compose('stop', 'dispatcher', 'worker', 'web-2');
      restore('life01');
      // A dump older than this release would need this. Here there is nothing to do, and it must cope.
      compose('run', '--rm', '--no-deps', 'migrate');

      // What the restore did: the row and its link are back, and the tombstone is gone.
      const restored = await su.query(
        `select a.name from work.artifacts a
         join work.work_artifacts l on l.artifact_id = a.id and l.organization_id = a.organization_id
         where a.id = $1`,
        [doomed],
      );
      expect(restored.rows).toEqual([{ name: doomedName }]);
      const lost = await su.query('select 1 from platform.tombstones where target_id = $1', [
        doomed,
      ]);
      expect(lost.rows).toEqual([]);

      // The negative control. Bytes survive when an object store is rolled back too, or a purge had
      // not finished. Without the re-apply, the data layer now hands over the deleted file, so
      // everything checked below is able to fail.
      await admin().put(doomedBytes, Buffer.from(content), 'text/plain');
      const returned = await readArtifact(app.db, admin(), await contextOf(owner, org), {
        workUnitId: work,
        artifactId: doomed,
      });
      expect(returned.name).toBe(doomedName);
      expect(returned.body.toString()).toBe(content);

      // The gate. A replica that starts now refuses from its first request, on every surface.
      compose('start', 'web-2');
      await answering();
      await onReplica('web-2', async () => {
        const pageNow = await visit(page, owner.jar);
        expect(pageNow.status).toBe(307);
        expect(locationOf(pageNow)).toBe('/restoring');
        const fileNow = await visit(doomedPath, owner.jar);
        expect(fileNow.status).toBe(307);
        expect(locationOf(fileNow)).toBe('/restoring');
        expect((await visit(keptPath, owner.jar)).status).toBe(307);
        // A page with a loading state of its own, which could have started answering by now.
        const streamed = await visit(`/o/${org}/inbox`, owner.jar);
        expect(streamed.status).toBe(307);
        expect(locationOf(streamed)).toBe('/restoring');

        const told = await visit('/restoring', owner.jar);
        expect(told.status).toBe(503);
        const words = await told.text();
        expect(words).toContain('This organization is being restored');
        expect(words).not.toContain(org);

        const api = await visit(`/api/v1/organizations/${org}/work-units/${work}`, owner.jar);
        expect(api.status).toBe(503);
        expect(await api.json()).toMatchObject({ code: 'RESTORE_PENDING', retryable: true });

        // An action cannot change anything meanwhile either.
        const action = await post(page, owner.jar, uploadForm, {
          file: new File(['late'], 'late.txt', { type: 'text/plain' }),
        });
        expect(locationOf(action)).toBe('/restoring');
        const files = await su.query(
          'select count(*)::int as n from work.work_artifacts where work_unit_id = $1',
          [work],
        );
        expect(files.rows).toEqual([{ n: 2 }]);

        // Someone outside the tenant cannot tell it is being restored: for them it just is not there.
        expect((await visit(page, rival.jar)).status).toBe(404);
        const outsider = await visit(`/api/v1/organizations/${org}/work-units/${work}`, rival.jar);
        expect(outsider.status).toBe(404);

        // The other tenant lost nothing, so it carries on.
        expect((await visit(filesPath(rivalOrg, rivalWork, rivalFile), rival.jar)).status).toBe(
          200,
        );
        expect((await read(workPage(rivalOrg, rivalWork), rival.jar)).status).toBe(200);
      });
      // The replica left running closes too, within its interval.
      await expect
        .poll(async () => (await visit(doomedPath, owner.jar)).status, GATE_INTERVAL)
        .toBe(307);

      // The operator's command will not destroy a file that is still whole on the ledger's word alone,
      // because whoever holds the dispatcher's credential can write an entry. Nothing changes yet.
      const asked = reapply();
      expect(asked).toMatchObject({
        status: 1,
        unconfirmed: 1,
        tombstonesAdded: 0,
        artifactsRemoved: 0,
        bytesRemoved: 0,
        failed: 0,
      });
      expect(await admin().exists(doomedBytes)).toBe(true);
      expect((await visit(doomedPath, owner.jar)).status).toBe(307);

      // This operator knows the restore happened and that the store went back with it, so says so.
      const first = reapply(
        '--confirm',
        ledgerRef({ organizationId: org, targetType: 'artifact', targetId: doomed }),
      );
      expect(first).toMatchObject({
        status: 0,
        unconfirmed: 0,
        tombstonesAdded: 1,
        artifactsRemoved: 1,
        bytesRemoved: 1,
        invalid: 0,
        failed: 0,
      });

      // The artifact row is blocked and gone, its link is gone, and so are the bytes.
      const tombstone = await su.query(
        'select created_at from platform.tombstones where target_id = $1',
        [doomed],
      );
      expect(tombstone.rows).toEqual([{ created_at: new Date(entry.deleted_at as string) }]);
      const after = await su.query(
        `select (select count(*)::int from work.artifacts where id = $1) as artifacts,
                (select count(*)::int from work.work_artifacts where artifact_id = $1) as links,
                (select state from platform.blob_lifecycle where artifact_id = $1) as blob`,
        [doomed],
      );
      expect(after.rows).toEqual([{ artifacts: 0, links: 0, blob: 'purged' }]);
      expect(await admin().exists(doomedBytes)).toBe(false);

      // The gate opens by itself, on both replicas, and the deleted file is simply not found.
      for (const replica of ['web', 'web-2'] as const) {
        await onReplica(replica, async () => {
          await expect
            .poll(async () => (await visit(doomedPath, owner.jar)).status, WAIT)
            .toBe(404);
          const shown = await read(page, owner.jar);
          expect(shown.status).toBe(200);
          expect(mainOf(shown.html)).not.toContain(doomedName);
          expect(mainOf(shown.html)).toContain(keptName);
          const keptNow = await visit(keptPath, owner.jar);
          expect(keptNow.status).toBe(200);
          expect(await keptNow.text()).toBe('kept');
        });
      }

      // Running it again changes nothing.
      const before = await stateOf(org, work);
      const second = reapply();
      expect(second).toMatchObject({
        status: 0,
        tombstonesAdded: 0,
        artifactsRemoved: 0,
        bytesRemoved: 0,
        invalid: 0,
        failed: 0,
      });
      expect(await stateOf(org, work)).toEqual(before);

      // The product goes on from here: the next deletion reaches the ledger as usual.
      compose('start', 'dispatcher', 'worker');
      await remove(owner, org, work, kept);
      await expect.poll(() => admin().exists(keyFor(org, kept)), LEDGER_WAIT).toBe(true);
      expect((await read(page, owner.jar)).status).toBe(200);
    },
    LONG,
  );

  it('gives the dispatcher a credential that reaches the ledger and no customer file', async () => {
    const work = await createWork(owner, org, { title: `Scoped ${randomUUID()}` });
    const file = await upload(
      owner,
      org,
      work,
      new File(['customer bytes'], 'customer.txt', { type: 'text/plain' }),
    );
    const bytes = objectKey(org, file);
    const narrow = ledgerOnly();
    const status = (error: unknown) =>
      (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    const refused = async (attempt: Promise<unknown>) =>
      expect(status(await attempt.catch((error: unknown) => error))).toBe(403);

    await refused(narrow.get(bytes));
    await refused(narrow.exists(bytes));
    await refused(narrow.put(`${org}/artifacts/planted`, Buffer.from('x'), 'text/plain'));
    // The product's own delete stops before it sends anything, since this credential cannot read the
    // bucket's versioning. The store has to refuse the DELETE itself as well, for someone who sends it.
    await expect(narrow.delete(bytes)).rejects.toThrow('OBJECT_PHYSICAL_ABSENCE_UNPROVEN');
    expect(
      await signedDelete('objects_ledger_access_key', 'objects_ledger_secret_key', bytes),
    ).toEqual({ status: 403, code: 'AccessDenied' });
    // The control for that request: signed the same way with the full credential, it does delete, so
    // the refusal above is the credential's scope and not a request the store could not read.
    const control = `${org}/artifacts/control-${randomUUID()}`;
    await admin().put(control, Buffer.from('x'), 'text/plain');
    expect(await signedDelete('objects_access_key', 'objects_secret_key', control)).toEqual({
      status: 204,
      code: undefined,
    });
    expect(await admin().exists(control)).toBe(false);
    await refused(
      (async () => {
        for await (const page of narrow.listPages('')) return page;
      })(),
    );
    expect(await admin().exists(bytes)).toBe(true);

    // Nor what an operator has moved aside, so it cannot put a quarantined entry back or remove it.
    const aside = `${LEDGER_QUARANTINE_PREFIX}${org}/artifact/${randomUUID()}.json`;
    await refused(narrow.put(aside, Buffer.from('x'), 'application/json'));
    await refused(narrow.exists(aside));

    // The control: the same credential does reach the ledger, so those refusals are about scope.
    const [entry] = await ledgerKeys();
    expect(entry).toBeDefined();
    expect(await narrow.exists(entry as string)).toBe(true);
  });

  it(
    'cannot use the ledger credential to destroy a live file, and an operator can clear the forgery',
    async () => {
      const person = await signUp('Fran Forged');
      const tenant = await createOrganization(person, `Forged ${randomUUID()}`);
      const work = await createWork(person, tenant, { title: `Forged ${randomUUID()}` });
      const file = await upload(
        person,
        tenant,
        work,
        new File(['still wanted'], 'wanted.txt', { type: 'text/plain' }),
      );
      const path = filesPath(tenant, work, file);
      const entry = {
        organizationId: tenant,
        targetType: 'artifact',
        targetId: file,
        deletedAt: new Date(),
      };
      // Written with nothing but the dispatcher's credential, naming a real file.
      await ledgerOnly().put(ledgerKeyFor(entry), serializeLedgerEntry(entry), 'application/json');
      await expect
        .poll(async () => (await visit(path, person.jar)).status, GATE_INTERVAL)
        .toBe(307);

      const result = reapply();
      expect(result.unconfirmed).toBe(1);
      expect(result.status).toBe(1);
      expect(await admin().exists(objectKey(tenant, file))).toBe(true);
      const rows = await su.query('select 1 from work.artifacts where id = $1', [file]);
      expect(rows.rows).toHaveLength(1);

      // A list only speaks for what it names. This one names another entry, and the file is safe.
      const listed = reapplyWithList(
        ledgerRef({ organizationId: tenant, targetType: 'artifact', targetId: randomUUID() }),
      );
      expect(listed.status).toBe(1);
      expect(logged(listed.output, 'tombstone_ledger.reapplied').unconfirmed).toBe(1);
      expect(await admin().exists(objectKey(tenant, file))).toBe(true);
      // Nor can it speak for a whole tenant, and a list that tries stops the command before it starts.
      const everything = reapplyWithList(`${tenant}:artifact:*`);
      expect(everything.status).toBe(2);
      expect(everything.output).not.toContain('tombstone_ledger.reapplied');
      expect(await admin().exists(objectKey(tenant, file))).toBe(true);

      // The operator did not restore anything, so this entry is not a deletion.
      const cleared = reapply('--quarantine', ledgerRef(entry));
      expect(cleared.unconfirmed).toBe(0);
      expect(cleared.status).toBe(0);
      expect(await admin().exists(ledgerKeyFor(entry))).toBe(false);
      expect(await admin().exists(quarantineKeyFor(ledgerKeyFor(entry)))).toBe(true);
      await expect.poll(async () => (await visit(path, person.jar)).status, WAIT).toBe(200);
      expect(await (await visit(path, person.jar)).text()).toBe('still wanted');
    },
    LONG,
  );

  it(
    'writes a deletion to the ledger through a Temporal outage, and a dispatcher restart during it',
    async () => {
      const work = await createWork(owner, org, { title: `No Temporal ${randomUUID()}` });
      const file = await upload(
        owner,
        org,
        work,
        new File(['gone'], 'gone.txt', { type: 'text/plain' }),
      );
      const healthOf = (service: string) =>
        compose('ps', '--format', '{{.Health}}', service).trim();
      compose('stop', 'temporal');
      try {
        // A process that had to reach Temporal to start would crash here, and go on crashing.
        compose('restart', 'dispatcher');
        await remove(owner, org, work, file);
        await expect.poll(() => admin().exists(keyFor(org, file)), LEDGER_WAIT).toBe(true);
        expect(backlog()).toMatchObject({ queued: 0, dead: 0 });
      } finally {
        compose('start', 'temporal');
      }
      // Later tests need these, and the worker cannot run without Temporal.
      const BACK = { timeout: 180_000, interval: 1_000 };
      await expect.poll(() => healthOf('temporal'), BACK).toBe('healthy');
      await expect.poll(() => healthOf('worker'), BACK).toBe('healthy');
      await expect.poll(() => healthOf('dispatcher'), BACK).toBe('healthy');
    },
    LONG,
  );

  it(
    'holds a deletion while the object store is down, costs it no attempts, and writes it afterwards',
    async () => {
      const work = await createWork(owner, org, { title: `Outage ${randomUUID()}` });
      const file = await upload(
        owner,
        org,
        work,
        new File(['held'], 'held.txt', { type: 'text/plain' }),
      );
      const page = workPage(org, work);
      compose('stop', 'objects');
      try {
        await remove(owner, org, work, file);
        // Blocked at once even so, and an outage of the store does not stop the product.
        expect((await visit(filesPath(org, work, file), owner.jar)).status).toBe(404);
        // Tried and put off, which is why it waits at least the retry delay, with no attempt counted.
        await expect
          .poll(
            async () =>
              (
                await su.query(
                  `select o.state, o.attempts from platform.outbox_events o
                   join platform.domain_events e
                     on e.id = o.event_id and e.organization_id = o.organization_id
                   where e.aggregate_id = $1 and e.event_type = $2
                     and o.next_attempt_at > e.occurred_at + interval '10 seconds'`,
                  [file, TOMBSTONE_RECORDED],
                )
              ).rows,
            WAIT,
          )
          .toEqual([{ state: 'queued', attempts: 0 }]);
        expect(backlog().queued).toBeGreaterThanOrEqual(1);
        expect((await read(page, owner.jar)).status).toBe(200);
      } finally {
        compose('start', 'objects');
      }
      await expect.poll(() => admin().exists(keyFor(org, file)), LEDGER_WAIT).toBe(true);
      await expect.poll(() => backlog().queued, LEDGER_WAIT).toBe(0);
    },
    LONG,
  );

  it(
    'shows what it does not cover: a deletion that never reached the ledger comes back, and was visible as backlog',
    async () => {
      const work = await createWork(owner, org, { title: `Window ${randomUUID()}` });
      const name = `window-${randomUUID()}.txt`;
      const file = await upload(owner, org, work, new File(['x'], name, { type: 'text/plain' }));
      const drained = await upload(
        owner,
        org,
        work,
        new File(['y'], 'drained.txt', { type: 'text/plain' }),
      );
      dump('life01-window');

      // With the dispatcher down, a deletion is blocked and its bytes go, but it waits for the
      // ledger, and the backlog says so.
      compose('stop', 'dispatcher');
      try {
        await remove(owner, org, work, drained);
        expect(await admin().exists(keyFor(org, drained))).toBe(false);
        const waiting = backlog();
        expect(waiting).toMatchObject({ queued: 1, dead: 0 });
      } finally {
        compose('start', 'dispatcher');
      }
      await expect.poll(() => admin().exists(keyFor(org, drained)), LEDGER_WAIT).toBe(true);
      expect(backlog()).toMatchObject({ queued: 0, dead: 0 });

      compose('stop', 'dispatcher');
      try {
        await remove(owner, org, work, file);
        expect(await admin().exists(keyFor(org, file))).toBe(false);
        expect(backlog().queued).toBe(1);
        expect(await admin().exists(objectKey(org, file))).toBe(false);

        // The database is lost now, with that entry unwritten. Nothing outside it knows.
        compose('stop', 'worker');
        restore('life01-window');
        const result = reapply();
        expect(result.failed).toBe(0);
        const back = await su.query('select name from work.artifacts where id = $1', [file]);
        expect(back.rows).toEqual([{ name }]);
        const none = await su.query('select 1 from platform.tombstones where target_id = $1', [
          file,
        ]);
        expect(none.rows).toEqual([]);

        // The name is back, which is the documented gap. The bytes are not, so it cannot be read.
        expect(await admin().exists(objectKey(org, file))).toBe(false);
        const path = filesPath(org, work, file);
        await expect.poll(async () => (await visit(path, owner.jar)).status, WAIT).not.toBe(307);
        expect((await visit(path, owner.jar)).status).not.toBe(200);
      } finally {
        compose('start', 'dispatcher', 'worker');
      }
    },
    LONG,
  );
});
