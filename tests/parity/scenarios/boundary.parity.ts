// COMM-06: what no plan or mode may weaken ("no plan-specific weakening of core security boundaries",
// docs/01-product/05-commercial-modes.md). Each scenario here is a denied case, so each one shows that
// the thing was refused, that nothing happened, and, with a control, that the same request from someone
// allowed really does work. Without the control a broken page would pass as "nothing leaked".
//
// Written against the base tree, and not run: the gate has never started a container (ADR-036).
import { randomUUID } from 'node:crypto';
import type { ApprovalStatus } from '@ensemus/domain/approval';
import type { ExternalActionStatus } from '@ensemus/domain/external-action';
import { expect } from 'vitest';
import { pinsOf } from '../../helpers/compose-pins';
import {
  createWork,
  locationOf,
  mainOf,
  membershipOf,
  sectionOf,
  toStatus,
  workPage,
} from '../../helpers/flows';
import {
  bringIn,
  type Form,
  formOn,
  formsIn,
  join,
  post,
  read,
  signUp,
  submit,
  tokenIn,
  visit,
} from '../../helpers/forms';
import { eventsPath, lastIdOf, openStreams } from '../../helpers/streams';
import { describeParity } from '../harness';
import type { Observation } from '../rules';
import type { ModelCallResult } from '../seams';
import {
  accountOf,
  addClient,
  addProject,
  addressesOf,
  allAuditText,
  api,
  apiReadsNamedUnder,
  apiReadsOf,
  apiRoot,
  AS_PAYLOAD,
  askForReview,
  attach,
  buildEstate,
  canary,
  clientIdOf,
  clientsPage,
  confirming,
  connectFrom,
  countRows,
  demotedWhileWarm,
  disabledWhileWarm,
  edit,
  errorIn,
  expectEachReplicaAnswers,
  foundIn,
  fresh,
  invite,
  leakable,
  logsOf,
  lookUpFrom,
  membershipsOf,
  named,
  networksOf,
  occurrences,
  organizationName,
  pagesNamedUnder,
  pagesOf,
  peoplePage,
  POLL,
  receive,
  refusalsOn,
  resolvedConfig,
  type Replica,
  scan,
  scannedPages,
  serverSecrets,
  settle,
  stackLogs,
  temporalPackagesIn,
  versionsOn,
  waitForVersion,
  workAt,
  workRow,
} from './boundary-support';

/** How M3 records a voided approval. The approval states have no other word for it. */
const VOIDED: ApprovalStatus = 'cancelled';
const SENT: ExternalActionStatus = 'sent';
const UNKNOWN: ExternalActionStatus = 'unknown';

const WEB_TIER: readonly Replica[] = ['web', 'web-2'];
const BOTH_WAYS: ReadonlyArray<readonly [Replica, Replica]> = [
  ['web', 'web-2'],
  ['web-2', 'web'],
];

/** A refusal has to carry a code, in the same form in every mode, and no provider or body text. */
function refusalOf(call: ModelCallResult) {
  expect(call.result).toBe('denied');
  if (call.result !== 'denied') throw new Error('Expected a refusal');
  expect(call.code).toMatch(/^[A-Z][A-Z0-9_]*$/);
  return call.code;
}

describeParity('boundary', {
  'PAR-TEN-01': async ({ su, tenant }) => {
    const a = await tenant();
    const rival = await tenant('Rival');
    const estate = await buildEstate(su, a);
    const asRival = rival.owner.jar;

    // Control: every one of these is really there, for the person it belongs to.
    for (const [label, path] of Object.entries(pagesOf(estate))) {
      expect((await read(path, a.owner.jar)).status, label).toBe(200);
    }
    for (const [label, path] of Object.entries(apiReadsOf(estate))) {
      if (label === 'work events') continue; // Answers with a stream, which the stream scenario reads.
      expect((await api(a.owner.jar, 'GET', path)).status, label).toBe(200);
    }
    const detail = pagesOf(estate)['work detail'] as string;
    const download = pagesOf(estate).file as string;
    expect((await read(detail, a.owner.jar)).html).toContain(estate.title);
    expect((await read(download, a.owner.jar)).html).toContain(estate.fileBody);

    const pages: Record<string, number> = {};
    for (const [label, path] of Object.entries({
      ...pagesOf(estate),
      ...pagesNamedUnder(estate, rival.organization),
    })) {
      const { status, html } = await read(path, asRival);
      pages[label] = status;
      expect(status, label).toBe(404);
      expect(foundIn(html, leakable(estate, path)), label).toEqual([]);
      const payload = await receive(path, asRival, AS_PAYLOAD);
      expect(foundIn(payload.body, leakable(estate, path)), `${label} as a payload`).toEqual([]);
    }

    // The same answer as for something that does not exist, so an ID cannot be probed.
    const missing = await api(asRival, 'GET', `${apiRoot(randomUUID())}/work-units`);
    expect(missing.status).toBe(404);
    expect(missing.code).toBe('NOT_FOUND');
    expect((await read(`/o/${randomUUID()}`, asRival)).status).toBe(404);
    expect((await read(workPage(rival.organization, randomUUID()), asRival)).status).toBe(404);

    const reads: Record<string, { status: number; code: string | null }> = {};
    for (const [label, path] of Object.entries({
      ...apiReadsOf(estate),
      ...apiReadsNamedUnder(estate, rival.organization),
    })) {
      const answer = await api(asRival, 'GET', path);
      reads[label] = { status: answer.status, code: answer.code };
      expect({ status: answer.status, code: answer.code }, label).toEqual({
        status: 404,
        code: 'NOT_FOUND',
      });
      expect(answer.message, label).toBe(missing.message);
      expect(foundIn(answer.text, leakable(estate, path)), label).toEqual([]);
    }

    // Writing is refused the same way, and leaves everything as it stood.
    const before = await workRow(su, estate.work);
    const { json: approvalJson } = await api(
      a.owner.jar,
      'GET',
      `${apiRoot(a.organization)}/approvals/${estate.approval}`,
    );
    const actionHash = (approvalJson as { action_hash: string }).action_hash;
    expect(actionHash).toBeTruthy();
    const ifMatch = { 'if-match': `"${before.version}"` };
    const forgedTitle = fresh('Taken over');
    const writes: Array<readonly [string, string, string, Parameters<typeof api>[3]]> = [
      [
        'change their work',
        'PATCH',
        `${apiRoot(a.organization)}/work-units/${estate.work}`,
        { body: { title: forgedTitle }, headers: ifMatch },
      ],
      [
        'change their work, named under this organization',
        'PATCH',
        `${apiRoot(rival.organization)}/work-units/${estate.work}`,
        { body: { title: forgedTitle }, headers: ifMatch },
      ],
      [
        'add work to their organization',
        'POST',
        `${apiRoot(a.organization)}/work-units`,
        { body: { title: forgedTitle, objective: 'x' }, key: randomUUID() },
      ],
      [
        'decide their approval',
        'POST',
        `${apiRoot(a.organization)}/approvals/${estate.approval}/decisions`,
        { body: { decision: 'approve', action_hash: actionHash } },
      ],
      [
        'decide their approval, named under this organization',
        'POST',
        `${apiRoot(rival.organization)}/approvals/${estate.approval}/decisions`,
        { body: { decision: 'approve', action_hash: actionHash } },
      ],
    ];
    const refusedWrites: Record<string, { status: number; code: string | null }> = {};
    for (const [label, method, path, options] of writes) {
      const answer = await api(asRival, method, path, options);
      refusedWrites[label] = { status: answer.status, code: answer.code };
      expect({ status: answer.status, code: answer.code }, label).toEqual({
        status: 404,
        code: 'NOT_FOUND',
      });
      expect(foundIn(answer.text, leakable(estate, path)), label).toEqual([]);
    }
    const after = await workRow(su, estate.work);
    expect(after).toEqual(before);
    const workMade = await countRows(su, 'work.work_units', 'title', forgedTitle);
    expect(workMade).toBe(0);
    const { rows: approvals } = await su.query('select status from work.approvals where id = $1', [
      estate.approval,
    ]);
    expect(approvals[0].status).toBe('pending');

    // A filter is not a lookup: naming their project under this organization is an empty list, worded
    // exactly as it is for a project that never existed.
    const list = (project: string) => `/o/${rival.organization}/work?project=${project}`;
    const someone = await read(list(estate.project), asRival);
    const nobody = randomUUID();
    const nothing = await read(list(nobody), asRival);
    expect(someone.status).toBe(200);
    expect(foundIn(someone.html, named(estate.texts))).toEqual([]);
    const statement = mainOf(someone.html).includes('Showing work in this project.');
    expect(statement).toBe(true);
    const sameAsNoSuchProject =
      mainOf(someone.html).replaceAll(estate.project, 'x') ===
      mainOf(nothing.html).replaceAll(nobody, 'x');
    expect(sameAsNoSuchProject).toBe(true);

    return {
      pages,
      apiReads: reads,
      apiWrites: refusedWrites,
      workAfterWrites: { status: after.status, versionsMoved: after.version - before.version },
      workMade,
      approvalAfterWrites: approvals[0].status as string,
      projectFilter: { status: someone.status, statement, sameAsNoSuchProject },
    };
  },

  'PAR-TEN-02': async ({ su, tenant }) => {
    const a = await tenant();
    const rival = await tenant('Rival');
    const name = fresh('Same Name Limited');

    await addClient(a, name);
    await addClient(rival, name);
    const { rows } = await su.query(
      'select organization_id from work.clients where display_name = $1 order by organization_id',
      [name],
    );
    expect(rows.map((row) => row.organization_id as string)).toEqual(
      [a.organization, rival.organization].sort(),
    );

    /** What one tenant's page shows: one line under Clients, and one choice, which is its own row. */
    const seenBy = async (who: typeof a) => {
      const { status, html } = await read(clientsPage(who.organization), who.owner.jar);
      expect(status).toBe(200);
      const listed = occurrences(sectionOf(html, 'clients-heading'), `<li>${name}</li>`);
      const choices = [
        ...sectionOf(html, 'projects-heading').matchAll(
          new RegExp(`<option value="([0-9a-f-]{36})"[^>]*>${name}</option>`, 'g'),
        ),
      ].map((match) => match[1]);
      expect(listed).toBe(1);
      expect(choices).toEqual([await clientIdOf(su, who.organization, name)]);
      return { listed, choices: choices.length };
    };
    const inA = await seenBy(a);
    const inRival = await seenBy(rival);

    // Work hung on one tenant's client leaves the other's list as it was.
    const projectOfA = fresh('Project');
    await addProject(a, projectOfA, await clientIdOf(su, a.organization, name));
    const clientsOfRival = await read(clientsPage(rival.organization), rival.owner.jar);
    expect(clientsOfRival.html).not.toContain(projectOfA);

    // And the other tenant's row with the same name cannot be reached for by its ID. They hear what a
    // typing mistake would hear, and the record says what it was.
    const projectOfRival = fresh('Project');
    const page = clientsPage(rival.organization);
    const form = await formOn(page, rival.owner.jar, /Project name/);
    const refused = await post(page, rival.owner.jar, form, {
      name: projectOfRival,
      clientId: await clientIdOf(su, a.organization, name),
    });
    expect(locationOf(refused)).toBe(`${page}?error=INVALID_INPUT`);
    const projectsMade = await countRows(su, 'work.projects', 'name', projectOfRival);
    expect(projectsMade).toBe(0);
    const reasons = await refusalsOn(
      su,
      rival.organization,
      await membershipOf(su, rival.owner, rival.organization),
    );
    expect(reasons.map((row) => row.safe_reason)).toEqual(['FOREIGN_REFERENCE']);

    return {
      rowsStored: rows.length,
      seenByEach: [inA, inRival],
      foreignClientRefused: errorIn(refused),
      projectsMade,
      onTheRecord: reasons.map((row) => row.safe_reason),
    };
  },

  'PAR-TEN-03': async ({ tenant }) => {
    const a = await tenant();
    const rival = await tenant('Rival');
    const both = await join(a.owner, a.organization, fresh('Pat Twoplaces'));
    await bringIn(rival.owner, rival.organization, both);
    const streams = openStreams();
    try {
      const inTheirOwn = await createWork(a.owner, a.organization, { title: fresh('Visible') });
      const ofRival = await createWork(rival.owner, rival.organization, { title: fresh('Other') });

      // Control: really one person who can read both, so a refusal below is not simply no access.
      const pageOfA = await read(workPage(a.organization, inTheirOwn), both.jar);
      const pageOfRival = await read(workPage(rival.organization, ofRival), both.jar);
      expect(pageOfA.status).toBe(200);
      expect(pageOfRival.status).toBe(200);
      expect((await read(`/o/${a.organization}`, both.jar)).html).toContain('Switch organization');
      // Each page points at its own stream, and names nothing of the other.
      expect(pageOfA.html).toContain(eventsPath(a.organization, inTheirOwn));
      expect(pageOfA.html).not.toContain(rival.organization);
      expect(pageOfRival.html).toContain(eventsPath(rival.organization, ofRival));
      expect(pageOfRival.html).not.toContain(a.organization);

      // On a stream in the first tenant, then switching with the old stream's position in hand. A
      // browser would not carry it over to another URL, and a buggy or hand-made client could.
      const left = await workAt(a.owner, a.organization, 2);
      const entered = await workAt(rival.owner, rival.organization, 6);
      const before = await streams.follow(both.jar, eventsPath(a.organization, left));
      await waitForVersion(before, 2);
      before.close();
      const after = await streams.follow(both.jar, eventsPath(rival.organization, entered), {
        lastEventId: lastIdOf(before) as string,
      });
      expect(after.status).toBe(200);
      await waitForVersion(after, 6);

      // The tenant they left keeps changing, and the stream they are on stays silent.
      let version = 2;
      for (let i = 0; i < 6; i += 1) version = await edit(a.owner, a.organization, left, version);
      await settle();
      const heardWhileTheOtherChanged = versionsOn(after);
      expect(heardWhileTheOtherChanged).toEqual([6]);
      const heardBeforeSwitching = versionsOn(before);
      expect(heardBeforeSwitching).toEqual([2]);

      // It was not silent because it had stopped.
      await edit(rival.owner, rival.organization, entered, 6);
      await waitForVersion(after, 7);
      const heardOnItsOwnChange = versionsOn(after);
      expect(heardOnItsOwnChange).toEqual([6, 7]);

      // Resuming in the new tenant at the same number stays silent, and shows nothing of the old one.
      const sameInA = await workAt(a.owner, a.organization, 3);
      const sameInRival = await workAt(rival.owner, rival.organization, 3);
      const resumed = await streams.follow(both.jar, eventsPath(rival.organization, sameInRival), {
        lastEventId: '3',
      });
      await edit(a.owner, a.organization, sameInA, 3);
      await settle();
      const heardOnResume = versionsOn(resumed);
      expect(heardOnResume).toEqual([]);

      // Two open at once: one tenant's change reaches only that tenant's stream.
      const openInA = await streams.follow(both.jar, eventsPath(a.organization, sameInA));
      const openInRival = await streams.follow(
        both.jar,
        eventsPath(rival.organization, sameInRival),
      );
      await waitForVersion(openInA, 4);
      await waitForVersion(openInRival, 3);
      await edit(rival.owner, rival.organization, sameInRival, 3);
      await waitForVersion(openInRival, 4);
      await settle();
      const quietTab = versionsOn(openInA);
      expect(quietTab).toEqual([4]);

      // And a stream never opens across tenants, for someone who can read both.
      const crossings: Array<{ status: number; frames: number; isStream: boolean }> = [];
      for (const path of [
        eventsPath(a.organization, ofRival),
        eventsPath(rival.organization, inTheirOwn),
      ]) {
        const crossing = await streams.follow(both.jar, path);
        expect(crossing.status).toBe(404);
        expect(crossing.contentType).not.toContain('text/event-stream');
        await expect.poll(() => crossing.ended(), POLL).toBe(true);
        expect(crossing.received).toEqual([]);
        crossings.push({
          status: crossing.status,
          frames: crossing.received.length,
          isStream: (crossing.contentType ?? '').includes('text/event-stream'),
        });
      }

      return {
        heardBeforeSwitching,
        heardWhileTheOtherChanged,
        heardOnItsOwnChange,
        heardOnResume,
        quietTab,
        crossings,
      };
    } finally {
      streams.closeAll();
    }
  },

  'PAR-TEN-04': async ({ su, tenant }) => {
    const a = await tenant();
    const rival = await tenant('Rival');
    const { organization: org, owner } = a;
    const rivalOrg = rival.organization;
    const rivalName = await organizationName(su, rivalOrg);
    const member = await join(owner, org, fresh('Member'));
    const ownWork = await createWork(owner, org, { title: fresh('Own') });
    const rivalWork = await createWork(rival.owner, rivalOrg, { title: fresh('Theirs') });
    const ownBefore = await workRow(su, ownWork);
    const rivalBefore = await workRow(su, rivalWork);

    const statuses: Record<string, number> = {};
    /** Refused as a 404, with none of the other tenant in the answer. */
    const refusedOutright = async (label: string, response: Response) => {
      statuses[label] = response.status;
      expect(response.status, label).toBe(404);
      expect((await response.text()).includes(rivalName), label).toBe(false);
    };

    const newWork = `/o/${org}/work/new`;
    const titleForged = fresh('Forged');
    const newWorkForm = await formOn(newWork, owner.jar, /name="title"/);
    await refusedOutright(
      'create work',
      await post(newWork, owner.jar, newWorkForm, {
        organizationId: rivalOrg,
        title: titleForged,
        classification: 'internal',
      }),
    );
    await refusedOutright(
      'create work, posted to their own page',
      await post(`/o/${rivalOrg}/work/new`, owner.jar, newWorkForm, {
        organizationId: rivalOrg,
        title: titleForged,
        classification: 'internal',
      }),
    );
    const workForged = await countRows(su, 'work.work_units', 'title', titleForged);
    expect(workForged).toBe(0);

    const emailForged = `forged-${randomUUID()}@example.invalid`;
    await refusedOutright(
      'invite',
      await post(
        peoplePage(org),
        owner.jar,
        await formOn(peoplePage(org), owner.jar, /name="email"/),
        { organizationId: rivalOrg, email: emailForged, role: 'admin' },
      ),
    );
    const invitationsForged = await countRows(su, 'org.invitations', 'email', emailForged);
    expect(invitationsForged).toBe(0);

    const ownPage = workPage(org, ownWork);
    const moveForm = await formOn(ownPage, owner.jar, toStatus('ready'));
    await refusedOutright(
      'change work',
      await post(ownPage, owner.jar, moveForm, {
        organizationId: rivalOrg,
        id: rivalWork,
        version: '1',
      }),
    );
    // Their work under this tenant's ID: row-level security finds nothing to change.
    const crossed = await post(ownPage, owner.jar, moveForm, { id: rivalWork, version: '1' });
    expect(locationOf(crossed)).toBe(`/o/${org}/work/${rivalWork}?error=NOT_FOUND`);
    expect(await workRow(su, rivalWork)).toEqual(rivalBefore);
    expect(await workRow(su, ownWork)).toEqual(ownBefore);

    const nameForged = `forged-${randomUUID()}.txt`;
    await refusedOutright(
      'upload a file',
      await post(ownPage, owner.jar, await formOn(ownPage, owner.jar, /name="file"/), {
        organizationId: rivalOrg,
        id: rivalWork,
        file: new File(['x'], nameForged, { type: 'text/plain' }),
      }),
    );
    const filesForged = await countRows(su, 'work.artifacts', 'name', nameForged);
    expect(filesForged).toBe(0);

    const memberId = await membershipOf(su, member, org);
    const victim = await membershipOf(su, rival.owner, rivalOrg);
    await refusedOutright(
      'disable a member',
      await post(
        peoplePage(org),
        owner.jar,
        await formOn(
          peoplePage(org),
          owner.jar,
          (form: Form) => form.hidden.get('membershipId') === memberId && />Disable</.test(form.html),
        ),
        { organizationId: rivalOrg, membershipId: victim },
      ),
    );
    const { rows: victimRows } = await su.query('select status from org.memberships where id = $1', [
      victim,
    ]);
    expect(victimRows[0].status).toBe('active');

    // A reference to their row, on a form for this tenant.
    await addClient(rival, fresh('Client'));
    const { rows: theirClients } = await su.query(
      'select id from work.clients where organization_id = $1',
      [rivalOrg],
    );
    const projectForged = fresh('Project');
    const clients = clientsPage(org);
    const projectForm = await formOn(clients, owner.jar, /Project name/);
    const foreign = await post(clients, owner.jar, projectForm, {
      name: projectForged,
      clientId: theirClients[0].id as string,
    });
    expect(locationOf(foreign)).toBe(`${clients}?error=INVALID_INPUT`);
    const projectsForged = await countRows(su, 'work.projects', 'name', projectForged);
    expect(projectsForged).toBe(0);

    // From another site, with a good form and a good session.
    const titleCrossSite = fresh('Cross-site');
    const crossSite = await post(
      newWork,
      owner.jar,
      newWorkForm,
      { title: titleCrossSite, classification: 'internal' },
      'https://evil.example',
    );
    expect(crossSite.status).not.toBe(303);
    const crossSiteWork = await countRows(su, 'work.work_units', 'title', titleCrossSite);
    expect(crossSiteWork).toBe(0);

    // Control: the same form, not forged, does what it says.
    const titleControl = fresh('Control');
    const control = await post(newWork, owner.jar, newWorkForm, {
      title: titleControl,
      classification: 'internal',
    });
    expect(control.status).toBe(303);
    expect(await countRows(su, 'work.work_units', 'title', titleControl)).toBe(1);

    // On the other tenant's record, because that is who was aimed at, and not in the forger's words.
    const account = await accountOf(su, owner);
    const aimedAt = await refusalsOn(su, rivalOrg, account);
    expect(aimedAt).toEqual([
      {
        action: 'access.refused.web',
        decision: 'deny',
        safe_reason: 'TENANT_ACCESS_DENIED',
        target_ref: `organization:${rivalOrg}`,
      },
    ]);
    const onOwn = await refusalsOn(su, org, await membershipOf(su, owner, org));
    expect(onOwn.map((row) => row.safe_reason)).toContain('FOREIGN_REFERENCE');
    const auditText = await allAuditText(su, [org, rivalOrg]);
    for (const sent of [titleForged, emailForged, nameForged, projectForged]) {
      expect(auditText.includes(sent)).toBe(false);
    }

    const what = ({ action, decision, safe_reason: reason }: (typeof aimedAt)[number]) => ({
      action,
      decision,
      reason,
    });
    return {
      refused: statuses,
      theirWorkNamedUnderThisTenant: errorIn(crossed),
      foreignReference: errorIn(foreign),
      rowsMade: { workForged, invitationsForged, filesForged, projectsForged, crossSiteWork },
      victimStatus: victimRows[0].status as string,
      theirWorkStatus: rivalBefore.status,
      onTheirRecord: aimedAt.map(what),
      onThisRecord: onOwn.filter((row) => row.safe_reason === 'FOREIGN_REFERENCE').map(what),
    };
  },

  'PAR-TEN-05': async ({ su, tenant }) => {
    const a = await tenant();
    const rival = await tenant('Rival');
    const person = await signUp(fresh('Newcomer'));
    const stranger = await signUp(fresh('Stranger'));
    const secretWork = await createWork(rival.owner, rival.organization, { title: fresh('Theirs') });
    const rivalName = await organizationName(su, rival.organization);

    // Invited to both, by two organizations that know nothing of each other.
    const toA = await invite(a.owner, a.organization, person.email);
    const toRival = await invite(rival.owner, rival.organization, person.email);
    const here = `/invite/${toA}`;
    expect((await read(`/o/${a.organization}`, person.jar)).status).toBe(404);
    expect((await read(`/o/${rival.organization}`, person.jar)).status).toBe(404);

    // It only works for the person it was sent to, and costs them nothing when someone else tries.
    const stolen = await submit(here, stranger.jar, /Accept invitation/);
    expect(locationOf(stolen)).toBe(`${here}?error=INVITATION_INVALID`);
    expect(await membershipsOf(su, stranger)).toEqual([]);
    expect((await read(`/o/${a.organization}`, stranger.jar)).status).toBe(404);

    // Asking, with the form naming the other organization and a better role. Neither is its to name.
    const form = await formOn(here, person.jar, /Accept invitation/);
    const asked = await post(here, person.jar, form, {
      organizationId: rival.organization,
      role: 'owner',
    });
    expect(locationOf(asked)).toBe(`${here}?state=waiting`);
    const waiting = await read(`/o/${a.organization}`, person.jar);
    expect(waiting.status).toBe(404);

    const confirmed = await submit(peoplePage(a.organization), a.owner.jar, confirming(person), {
      confirm: 'yes',
    });
    expect(locationOf(confirmed)).toBe(peoplePage(a.organization));

    // In the one organization, with the role it was sent with, and nowhere else.
    const memberships = await membershipsOf(su, person);
    expect(memberships).toEqual([
      { organization_id: a.organization, role: 'member', status: 'active' },
    ]);
    expect((await read(`/o/${a.organization}`, person.jar)).status).toBe(200);
    expect((await visit('/', person.jar)).headers.get('location')).toBe(`/o/${a.organization}`);
    const inRival = {
      home: (await read(`/o/${rival.organization}`, person.jar)).status,
      people: (await read(peoplePage(rival.organization), person.jar)).status,
      work: (await read(workPage(rival.organization, secretWork), person.jar)).status,
      api: (await api(person.jar, 'GET', `${apiRoot(rival.organization)}/work-units`)).status,
    };
    expect(inRival).toEqual({ home: 404, people: 404, work: 404, api: 404 });
    const homeOfA = await read(`/o/${a.organization}`, person.jar);
    expect(homeOfA.html).not.toContain(rivalName);

    // One organization's confirmation does nothing for another's invitation, which is still its own.
    const rivalPeople = await read(peoplePage(rival.organization), rival.owner.jar);
    expect(rivalPeople.html).toContain(person.email);
    expect(formsIn(rivalPeople.html).some(confirming(person))).toBe(false);

    // It works once.
    const again = await submit(here, person.jar, /Accept invitation/);
    expect(locationOf(again)).toBe(`${here}?error=INVITATION_INVALID`);

    // The second invitation was never used up by the first, and still needs its own confirmation.
    const askedRival = await submit(`/invite/${toRival}`, person.jar, /Accept invitation/);
    expect(locationOf(askedRival)).toBe(`/invite/${toRival}?state=waiting`);
    const stillOut = await read(`/o/${rival.organization}`, person.jar);
    expect(stillOut.status).toBe(404);
    const membershipsAtTheEnd = (await membershipsOf(su, person)).length;
    expect(membershipsAtTheEnd).toBe(1);

    return {
      strangerUsingTheLink: errorIn(stolen),
      waitingForConfirmation: waiting.status,
      memberships: memberships.map(({ role, status }) => ({ role, status })),
      inTheOtherOrganization: inRival,
      secondUseOfTheLink: errorIn(again),
      otherInvitationAfterAsking: stillOut.status,
      membershipsAtTheEnd,
    };
  },

  'PAR-TEN-06': async ({ su, tenant }) => {
    const a = await tenant();
    const rival = await tenant('Rival');
    const { organization: org, owner } = a;
    const people = peoplePage(org);
    const member = await join(owner, org, fresh('Member'));
    const colleague = await join(owner, org, fresh('Colleague'));
    const memberId = await membershipOf(su, member, org);
    const ownerId = await membershipOf(su, owner, org);
    const colleagueId = await membershipOf(su, colleague, org);
    const addresses = (...who: ReadonlyArray<{ readonly email: string }>) =>
      named(Object.fromEntries(who.map((person, at) => [`address ${at}`, person.email])));
    const restrictedTitle = fresh('Restricted');
    const restricted = await createWork(colleague, org, {
      title: restrictedTitle,
      classification: 'restricted',
    });

    // A member: names and roles, and nobody's address.
    const asMember = await read(people, member.jar);
    expect(asMember.status).toBe(200);
    const memberDirectory = sectionOf(asMember.html, 'members-heading');
    expect(memberDirectory).toContain(owner.name);
    expect(memberDirectory).toContain(colleague.name);
    expect(memberDirectory).toContain('>Owner<');
    expect(memberDirectory).toContain('>Member<');
    expect(memberDirectory).not.toContain('>Email<');
    const statedWhy = memberDirectory.includes(
      'Email addresses are only shown to owners and admins.',
    );
    expect(statedWhy).toBe(true);
    const shownToMember = foundIn(asMember.html, addresses(owner, colleague));
    expect(shownToMember).toEqual([]);
    const offeredToMember = asMember.html.includes('name="email"');
    expect(offeredToMember).toBe(false);
    expect(asMember.html).not.toContain('invitations-heading');
    expect(sectionOf(asMember.html, 'teams-heading')).not.toContain('Move ');

    // Control: an owner has all of it, under each name, so it is the member who is being filtered.
    const asOwner = await read(people, owner.jar);
    const ownerDirectory = sectionOf(asOwner.html, 'members-heading');
    expect(ownerDirectory).not.toContain('Email addresses are only shown to owners and admins.');
    const shownToOwner = foundIn(ownerDirectory, addresses(owner, member, colleague));
    expect(shownToOwner.length).toBe(3);
    const offeredToOwner = asOwner.html.includes('name="email"');
    expect(offeredToOwner).toBe(true);

    // Nobody from another tenant, for either of them.
    for (const page of [asMember, asOwner]) {
      expect(page.html).not.toContain(rival.owner.email);
      expect(page.html).not.toContain(rival.owner.name);
    }

    // The choices on a Work Unit name people the same way.
    const own = await createWork(member, org, { title: fresh('Mine') });
    const onWork = await read(workPage(org, own), member.jar);
    expect(onWork.html).toContain(`>${colleague.name}</option>`);
    for (const other of [owner, colleague]) expect(onWork.html).not.toContain(other.email);

    // What they may not see is not there, and not as a page either.
    const restrictedPage = await read(workPage(org, restricted), member.jar);
    expect(restrictedPage.status).toBe(404);
    expect(restrictedPage.html).not.toContain(restrictedTitle);
    expect((await read(`/o/${org}/work`, member.jar)).html).not.toContain(restrictedTitle);

    // A form an owner holds does not work for a member. The page says so, and the record shows it.
    const emailForged = `forged-${randomUUID()}@example.invalid`;
    const invited = await post(people, member.jar, await formOn(people, owner.jar, /name="email"/), {
      email: emailForged,
      role: 'admin',
    });
    expect(tokenIn(await invited.text())).toBeUndefined();
    const invitationsMade = await countRows(su, 'org.invitations', 'email', emailForged);
    expect(invitationsMade).toBe(0);

    const raised = await post(
      people,
      member.jar,
      await formOn(
        people,
        owner.jar,
        (form: Form) =>
          form.hidden.get('membershipId') === memberId &&
          form.html.includes(`Save access for ${member.name}`),
      ),
      { role: 'admin' },
    );
    expect(locationOf(raised)).toBe(`${people}?error=FORBIDDEN`);
    expect((await read(locationOf(raised), member.jar)).html).toContain(
      'You do not have permission to do that.',
    );
    const disabledOwner = await post(
      people,
      member.jar,
      await formOn(
        people,
        owner.jar,
        (form: Form) =>
          form.hidden.get('membershipId') === colleagueId && />Disable</.test(form.html),
      ),
      { membershipId: ownerId, confirm: 'yes' },
    );
    expect(locationOf(disabledOwner)).toBe(`${people}?error=FORBIDDEN`);
    const { rows } = await su.query(
      'select id, role, status from org.memberships where id = any($1) order by role',
      [[memberId, ownerId]],
    );
    expect(rows).toEqual([
      { id: memberId, role: 'member', status: 'active' },
      { id: ownerId, role: 'owner', status: 'active' },
    ]);
    const record = await refusalsOn(su, org, memberId);
    expect(record.map((row) => row.safe_reason)).toEqual(['FORBIDDEN']);

    return {
      member: {
        addressesShown: shownToMember.length,
        inviteOffered: offeredToMember,
        statedWhy,
        restrictedWork: restrictedPage.status,
      },
      owner: { addressesShown: shownToOwner.length, inviteOffered: offeredToOwner },
      forged: {
        invitationsMade,
        raisingOwnRole: errorIn(raised),
        disablingTheOwner: errorIn(disabledOwner),
      },
      rolesAfter: rows.map((row) => row.role as string),
      onTheRecord: record.map((row) => row.safe_reason),
    };
  },

  'PAR-SEC-01': async ({ su, tenant }) => {
    const a = await tenant();
    const rival = await tenant('Rival');
    const { organization: org, owner } = a;
    const member = await join(owner, org, fresh('Member'));
    const insider = await join(owner, org, fresh('Insider'));
    const reviewer = await join(owner, org, fresh('Reviewer'));

    const inDocument = canary('DOCUMENT');
    const onWork = {
      title: canary('TITLE'),
      objective: canary('OBJECTIVE'),
      'file name': `${canary('FILENAME')}.txt`,
    };

    // Restricted work only the insider and the reviewer are on, holding a document only they can open.
    const work = await createWork(insider, org, {
      title: onWork.title,
      objective: onWork.objective,
      classification: 'restricted',
    });
    const page = workPage(org, work);
    const file = await attach(
      insider,
      page,
      new File([`A key that must stay in here: ${inDocument}`], onWork['file name'], {
        type: 'text/plain',
      }),
    );
    const addedReviewer = await submit(page, insider.jar, /Add someone/, {
      membershipId: await membershipOf(su, reviewer, org),
    });
    expect(locationOf(addedReviewer)).toBe(page);
    const approval = await askForReview(su, insider, reviewer, org, work);
    const pages = scannedPages(org, work, approval);
    const downloadPath = `${page}/files/${file}`;

    const document = named({ 'the document': inDocument });
    const everything = [...document, ...named(onWork)];
    const server = serverSecrets();

    // Nobody off the work gets anything, in any form of any page.
    const offTheWork = await scan(member, pages, [...everything, ...server]);
    expect(offTheWork.found).toEqual([]);
    const ownerOffTheWork = await scan(owner, pages, [...everything, ...server]);
    expect(ownerOffTheWork.found).toEqual([]);
    const outsider = await scan(
      rival.owner,
      [...pages, ...scannedPages(rival.organization, work, approval)],
      [...everything, ...server],
    );
    expect(outsider.found).toEqual([]);

    // On the work, the page says what the work is and never what the document holds.
    const onTheWork = await scan(insider, pages, [...document, ...server]);
    expect(onTheWork.found).toEqual([]);
    const reviewing = await scan(reviewer, pages, [...document, ...server]);
    expect(reviewing.found).toEqual([]);

    // Each scan really read pages and payloads, so a page that failed to render cannot pass as clean.
    for (const seen of [offTheWork, ownerOffTheWork, outsider, onTheWork, reviewing]) {
      expect(seen.answered).toBeGreaterThan(0);
      expect(seen.payloads).toBeGreaterThan(0);
    }
    const shown = await read(page, insider.jar);
    expect(shown.status).toBe(200);
    expect(shown.html).toContain(onWork.title);
    expect(shown.html).toContain(onWork.objective);
    expect(shown.html).toContain(onWork['file name']);

    // The document is where it should be, for those it belongs to, and nowhere for anyone else.
    const opened = await visit(downloadPath, insider.jar);
    expect(opened.status).toBe(200);
    expect(await opened.text()).toContain(inDocument);
    const refusedDownloads = {
      member: (await read(downloadPath, member.jar)).status,
      ownerOfTheOrganization: (await read(downloadPath, owner.jar)).status,
      otherTenant: (await read(downloadPath, rival.owner.jar)).status,
    };
    expect(refusedDownloads).toEqual({ member: 404, ownerOfTheOrganization: 404, otherTenant: 404 });

    // A request that fails badly, carrying the value where an ID belongs, has every reason to log it.
    const inbox = `/o/${org}/inbox`;
    const badRequest = await post(
      inbox,
      reviewer.jar,
      await formOn(inbox, reviewer.jar, /name="target"/),
      { id: `x\n{"forged":"${inDocument}"}` },
    );
    expect(locationOf(badRequest)).toBe(`${inbox}?error=INVALID_INPUT`);

    // Control: this reads what the stack logged in this very scenario, and not an empty answer.
    expect(logsOf('web')).toContain(org);
    const logs = stackLogs();
    expect(logs.length).toBeGreaterThan(0);
    const inLogs = foundIn(logs, everything);
    expect(inLogs).toEqual([]);

    return {
      foundOnPages: {
        offTheWork: offTheWork.found.length,
        ownerOffTheWork: ownerOffTheWork.found.length,
        otherTenant: outsider.found.length,
        onTheWork: onTheWork.found.length,
        reviewing: reviewing.found.length,
      },
      pagesScanned: pages.length,
      refusedDownloads,
      openedByThoseOnTheWork: opened.status,
      foundInLogs: inLogs.length,
    };
  },

  'PAR-SEC-02': async ({ su, tenant }) => {
    const a = await tenant();
    const streams = openStreams();
    try {
      await expectEachReplicaAnswers();
      const seen: Record<string, Observation> = {};
      for (const [changedOn, askedOf] of BOTH_WAYS) {
        seen[`changed on ${changedOn}, asked of ${askedOf}`] = {
          disabled: await disabledWhileWarm(su, a, streams, changedOn, askedOf),
          demoted: await demotedWhileWarm(su, a, changedOn, askedOf),
        };
      }
      return seen;
    } finally {
      streams.closeAll();
    }
  },

  'PAR-SEC-03': async () => {
    const temporalNetworks = networksOf('temporal');
    const temporalAddresses = addressesOf('temporal');
    expect(temporalAddresses.length).toBeGreaterThanOrEqual(2);
    const config = resolvedConfig();
    // This lookup is itself an outbound DNS query, so with outside names blackholed it would count as
    // an attempt against PAR-MODE-09. It is left out of what is compared, and the name pin below says
    // the same thing in every mode, without a packet.
    const mayLookUp = !process.env.ENSEMUS_COMPOSE_AIRGAP;

    const replicas: Record<string, Observation> = {};
    for (const service of WEB_TIER) {
      const networks = networksOf(service);
      expect(networks.length, service).toBeGreaterThan(0);
      const shared = networks.filter((network) => temporalNetworks.includes(network));
      expect(shared, service).toEqual([]);

      const pinned = Object.keys(pinsOf(config, service)).includes('temporal');
      expect(pinned, service).toBe(false);
      if (mayLookUp) expect(lookUpFrom(service, 'temporal'), service).toBe('blocked');

      const connections = temporalAddresses.map((address) => connectFrom(service, address, 7233));
      expect(new Set(connections), service).toEqual(new Set(['blocked']));

      const temporalPackages = temporalPackagesIn(service);
      expect(temporalPackages, service).toBe(0);

      replicas[service] = {
        sharedNetworks: shared.length,
        namePinned: pinned,
        connections,
        temporalPackages,
      };
    }

    // Control: Temporal is up, and answers the worker the same way, so "blocked" meant the network.
    const worker = connectFrom('worker', 'temporal', 7233);
    expect(worker).toBe('connected');

    return { ...replicas, workerControl: worker };
  },

  'PAR-SEC-04': async ({ seam, tenant }) => {
    const models = seam('modelSupply');
    const a = await tenant();
    const rival = await tenant('Rival');
    await models.arrange(a, 'answers');
    await models.arrange(rival, 'answers');

    const before = await models.callsReceived();
    const chat = refusalOf(
      await models.invoke(a, { dataClass: 'restricted', purpose: 'chat' }),
    );
    const embedding = refusalOf(
      await models.invoke(a, { dataClass: 'restricted', purpose: 'embedding' }),
    );
    const chatInRival = refusalOf(
      await models.invoke(rival, { dataClass: 'restricted', purpose: 'chat' }),
    );
    expect(chatInRival).toBe(chat);
    const afterRefusals = await models.callsReceived();
    expect(afterRefusals).toBe(before);

    // Control: the same tenant and the same fake answer other data, on both paths. Otherwise a fake
    // nothing could reach would make "no calls" pass.
    const answeredChat = await models.invoke(a, { dataClass: 'internal', purpose: 'chat' });
    const answeredEmbedding = await models.invoke(a, {
      dataClass: 'internal',
      purpose: 'embedding',
    });
    expect(answeredChat.result).toBe('answered');
    expect(answeredEmbedding.result).toBe('answered');
    const afterControls = await models.callsReceived();
    expect(afterControls).toBe(before + 2);

    return {
      restricted: { chat, embedding },
      callsAddedByRefusals: afterRefusals - before,
      internal: { chat: answeredChat.result, embedding: answeredEmbedding.result },
      callsAddedByControls: afterControls - afterRefusals,
    };
  },

  'PAR-ACT-01': async ({ seam, tenant }) => {
    const actions = seam('externalActions');
    const a = await tenant();
    const rival = await tenant('Rival');

    const changed = await actions.changeRecipientAfterApproval(a);
    expect(changed.approval).toBe(VOIDED);
    expect(changed.effects).toBe(0);

    // Control, in another tenant so the counts cannot mix: an approval nobody touched goes out once.
    // Otherwise a fake that never counted anything would make "no effects" pass.
    const untouched = await actions.sendApproved(rival, 'accepts');
    expect(untouched).toEqual({ status: SENT, effects: 1 });

    return {
      approvalAfterChange: changed.approval,
      effectsAfterChange: changed.effects,
      control: { status: untouched.status, effects: untouched.effects },
    };
  },

  'PAR-ACT-02': async ({ seam, tenant }) => {
    const actions = seam('externalActions');
    const a = await tenant();
    const rival = await tenant('Rival');

    const timedOut = await actions.sendApproved(a, 'accepts_then_times_out');
    expect(timedOut.status).toBe(UNKNOWN);
    expect(timedOut.effects).toBe(1);

    // Control: the same send with an answer says sent, so unknown means what it says.
    const answered = await actions.sendApproved(rival, 'accepts');
    expect(answered).toEqual({ status: SENT, effects: 1 });

    return {
      timedOut: { status: timedOut.status, effects: timedOut.effects },
      control: { status: answered.status, effects: answered.effects },
    };
  },

  'PAR-ACT-03': async ({ seam, tenant }) => {
    const actions = seam('externalActions');
    const a = await tenant();
    const rival = await tenant('Rival');

    const replayed = await actions.replayWebhook(a);
    expect(replayed).toEqual({ accepted: 1, effects: 1 });

    // Another tenant's delivery is its own, and was not swallowed as a repeat of the first.
    const inRival = await actions.replayWebhook(rival);
    expect(inRival).toEqual({ accepted: 1, effects: 1 });

    return {
      replayed: { accepted: replayed.accepted, effects: replayed.effects },
      inAnotherTenant: { accepted: inRival.accepted, effects: inRival.effects },
    };
  },
});
