// LIFE-01, ADR-026: restoring a backup cannot bring a deleted file back. The steps here are the ones in
// the runbook's backup and restore section: a real pg_dump and pg_restore into the running database,
// the real object store, the images' own commands, and the product through its pages.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { objectKey, readArtifact, type ReapplyResult } from '@ensemus/application';
import { openAppDatabase, resolveTenantContext } from '@ensemus/database';
import {
  ledgerKeyFor,
  LEDGER_PREFIX,
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

const storeFor = (access: string, key: string) =>
  new S3ObjectStore({
    endpoint: 'http://127.0.0.1:58333',
    bucket: 'ensemus',
    accessKey: secret(access),
    secretKey: secret(key),
  });

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

const reapply = () =>
  logged(
    compose('run', '--rm', '--no-deps', 'worker', 'node', 'dist/reapply-ledger.js'),
    'tombstone_ledger.reapplied',
  ) as unknown as ReapplyResult;

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

      // Re-applied by the operator's command.
      const first = reapply();
      expect(first).toMatchObject({
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
    await refused(narrow.delete(bytes));
    await refused(
      (async () => {
        for await (const page of narrow.listPages('')) return page;
      })(),
    );
    expect(await admin().exists(bytes)).toBe(true);

    // The control: the same credential does reach the ledger, so those refusals are about scope.
    const [entry] = await ledgerKeys();
    expect(entry).toBeDefined();
    expect(await narrow.exists(entry as string)).toBe(true);
  });

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
