// COMM-06: core Work Unit semantics, in each mode, through the product's own forms and public API. These
// use only what M2 built, so none of them needs a seam. Each one asserts what must hold, and returns what
// it saw, so the gate can also hold the three modes to behaving alike. A refusal here always shows the
// refusal and that nothing happened, by reading the state back.
import { randomUUID } from 'node:crypto';
import { objectKey } from '@ensemus/application';
import { ledgerKeyFor } from '@ensemus/domain/tombstone-ledger';
import { expect } from 'vitest';
import {
  createWork,
  locationOf,
  mainOf,
  membershipOf,
  move,
  sectionOf,
  toStatus,
  workPage,
} from '../../helpers/flows';
import { type Form, formOn, join, onReplica, post, read, submit } from '../../helpers/forms';
import { compose } from '../../helpers/stack';
import { eventsPath, lastIdOf, openStreams } from '../../helpers/streams';
import { describeParity } from '../harness';
import {
  api,
  approvalOn,
  artifactIn,
  askForReview,
  countOf,
  deciding,
  decisionsOn,
  describeRow,
  download,
  envelope,
  forged,
  inboxPath,
  inboxRows,
  LEDGER_WAIT,
  linkTo,
  objectStore,
  ownersOn,
  PLAN_WAIT,
  refusal,
  RESUME_WAIT,
  rowOf,
  runOutOfTime,
  statusShown,
  STREAM_WAIT,
  upload,
  withUpkeep,
  workUnitApi,
  workUnitsApi,
} from './work-support';

const unique = (label: string) => `${label} ${randomUUID()}`;

describeParity('work', {
  // WORK-01: the states a person sees, in order, and that nothing lets work skip them.
  'PAR-WORK-01': async ({ su, tenant }) => {
    const { organization, owner } = await tenant();
    const rival = await tenant('Rival');
    const title = unique('Sequence');
    const id = await createWork(owner, organization, { title, objective: 'Each status in turn.' });
    const page = workPage(organization, id);
    const apiStatus = async () => {
      const result = await api(owner, 'GET', workUnitApi(organization, id));
      expect(result.status).toBe(200);
      return result.json as { status: string; version: number; completion?: { basis: string } };
    };

    const start = await rowOf(su, id);
    const skip = await post(page, owner.jar, await formOn(page, owner.jar, toStatus('ready')), {
      to: 'completed',
    });
    const skipRefused = await refusal(skip, page, owner);
    expect(skipRefused.code).toBe('INVALID_TRANSITION');
    expect(await rowOf(su, id)).toEqual(start);

    const statuses = [await statusShown(page, owner)];
    const apiStatuses = [(await apiStatus()).status];
    const versions = [(await apiStatus()).version];
    for (const to of ['ready', 'running', 'verifying', 'completed']) {
      await move(owner, organization, id, to);
      statuses.push(await statusShown(page, owner));
      const now = await apiStatus();
      apiStatuses.push(now.status);
      versions.push(now.version);
    }
    expect(statuses).toEqual(['Waiting to start', 'Ready', 'In progress', 'Checking', 'Done']);
    expect(apiStatuses).toEqual(['queued', 'ready', 'running', 'verifying', 'completed']);
    expect(versions).toEqual([1, 2, 3, 4, 5]);

    const { rows: recorded } = await su.query<{ from_status: string; to_status: string }>(
      `select from_status, to_status from work.work_transitions
       where work_unit_id = $1 order by from_version`,
      [id],
    );

    // Nobody outside the organization learns any of this.
    const outsider = await read(page, rival.owner.jar);
    expect(outsider.status).toBe(404);
    expect(outsider.html).not.toContain(title);
    const outsiderApi = await api(rival.owner, 'GET', workUnitApi(organization, id));

    return {
      statuses,
      apiStatuses,
      versions,
      recorded: recorded.map((row) => `${row.from_status}>${row.to_status}`),
      completionBasis: (await apiStatus()).completion?.basis ?? null,
      skipRefused,
      outsider: { page: outsider.status, api: envelope(outsiderApi, 404, 'NOT_FOUND').code },
    };
  },

  // WORK-01: two tabs. The later save wins nothing, whichever way it comes in.
  'PAR-WORK-02': async ({ su, tenant }) => {
    const { organization, owner } = await tenant();
    const rival = await tenant('Rival');
    const id = await createWork(owner, organization, { title: unique('Stale') });
    const page = workPage(organization, id);
    // Both read the same version, and the first save moves it on.
    const staleMove = await formOn(page, owner.jar, toStatus('ready'));
    const staleEdit = await formOn(page, owner.jar, /Save changes/);
    const changed = unique('Changed');
    const saved = await post(page, owner.jar, staleEdit, {
      title: changed,
      objective: '',
      dueAt: '',
    });
    expect(locationOf(saved)).toBe(page);
    const standing = await rowOf(su, id);
    expect(standing).toEqual({ status: 'queued', version: 2, title: changed });

    const moveRefused = await refusal(await post(page, owner.jar, staleMove), page, owner);
    expect(moveRefused).toEqual({
      code: 'VERSION_CONFLICT',
      message: 'Someone else changed this first. Check the latest version and try again.',
    });
    expect(await rowOf(su, id)).toEqual(standing);

    // What was typed is handed back beside what is new, and it replaces nothing until saved knowingly.
    const typed = unique('A long objective someone spent a while on');
    const overwrite = await post(page, owner.jar, staleEdit, {
      title: 'Overwritten',
      objective: typed,
      dueAt: '',
    });
    expect(locationOf(overwrite)).toBe('');
    const explained = await overwrite.text();
    expect(explained).toContain('This changed while you were editing');
    expect(explained).toContain(changed);
    expect(explained).toContain(typed);
    expect(await rowOf(su, id)).toEqual(standing);

    const staleApi = await api(owner, 'PATCH', workUnitApi(organization, id), {
      body: { title: 'Saved later from old data' },
      headers: { 'if-match': '"1"' },
    });
    const apiRefused = envelope(staleApi, 409, 'VERSION_CONFLICT');
    expect(await rowOf(su, id)).toEqual(standing);

    const outsider = await api(rival.owner, 'PATCH', workUnitApi(organization, id), {
      body: { title: 'Taken over' },
      headers: { 'if-match': '"2"' },
    });
    const outsiderRefused = envelope(outsider, 404, 'NOT_FOUND');
    expect(await rowOf(su, id)).toEqual(standing);

    return {
      moveRefused,
      editRefused: { status: overwrite.status, typedTextKept: true, latestShown: true },
      apiRefused,
      outsiderRefused,
      row: { status: standing.status, version: standing.version },
      titleStands: true,
    };
  },

  // WORK-02, QA-004: a cycle is refused however it is made, and only the first edge is stored.
  'PAR-WORK-03': async ({ su, tenant }) => {
    const { organization, owner } = await tenant();
    const rival = await tenant('Rival');
    const make = () => createWork(owner, organization, { title: unique('Edge') });
    const page = (id: string) => workPage(organization, id);
    const edges = () =>
      countOf(su, 'work.work_dependencies where organization_id = $1', [organization]);
    const addEdge = (dependent: string, prerequisite: string) =>
      submit(page(dependent), owner.jar, /Add dependency/, { prerequisiteId: prerequisite });

    const [a, b, c] = [await make(), await make(), await make()];
    expect(locationOf(await addEdge(a, b))).toBe(page(a));
    const firstEdge = await edges();
    expect(firstEdge).toBe(1);

    // The form offers no way to do this, so this is the request someone would have to write.
    const reverseForm = await formOn(page(b), owner.jar, /Add dependency/);
    const reverse = await refusal(
      await post(page(b), owner.jar, reverseForm, { prerequisiteId: a }),
      page(b),
      owner,
    );
    expect(reverse).toEqual({
      code: 'DEPENDENCY_CYCLE',
      message:
        'That would make these pieces of work wait for each other forever, so it was not added.',
    });
    const edgesAfterReverse = await edges();
    expect(edgesAfterReverse).toBe(1);
    const reverseShown = sectionOf((await read(page(b), owner.jar)).html, 'dependencies-heading');
    expect(reverseShown).toContain('<p class="muted">Nothing.</p>');

    // Through a third piece of work, and to itself.
    expect(locationOf(await addEdge(b, c))).toBe(page(b));
    const indirectForm = await formOn(page(c), owner.jar, /Add dependency/);
    const indirect = await refusal(
      await post(page(c), owner.jar, indirectForm, { prerequisiteId: a }),
      page(c),
      owner,
    );
    expect(indirect.code).toBe('DEPENDENCY_CYCLE');
    const depend = (dependent: string, prerequisite: string) =>
      api(owner, 'POST', `${workUnitApi(organization, dependent)}/dependencies`, {
        body: { prerequisite_id: prerequisite },
      });
    const toItself = envelope(await depend(a, a), 409, 'DEPENDENCY_CYCLE');
    const edgesAfterIndirect = await edges();
    expect(edgesAfterIndirect).toBe(2);

    // Two opposite edges at the same moment: exactly one of them can win (WORK-02).
    const [d, e] = [await make(), await make()];
    const raced = await Promise.all([depend(d, e), depend(e, d)]);
    const racedStatuses = raced.map((result) => result.status).sort();
    expect(racedStatuses).toEqual([201, 409]);
    const edgesAfterRace = await edges();
    expect(edgesAfterRace).toBe(3);

    // Work in another tenant is not found, and neither tenant gains an edge.
    const theirs = await createWork(rival.owner, rival.organization, { title: unique('Theirs') });
    const foreignForm = await formOn(page(c), owner.jar, /Add dependency/);
    const foreign = await refusal(
      await post(page(c), owner.jar, foreignForm, { prerequisiteId: theirs }),
      page(c),
      owner,
    );
    expect(foreign.code).toBe('NOT_FOUND');
    expect(await edges()).toBe(3);
    const rivalEdges = await countOf(su, 'work.work_dependencies where organization_id = $1', [
      rival.organization,
    ]);
    expect(rivalEdges).toBe(0);

    return {
      firstEdge: 'added',
      reverse,
      edgesAfterReverse,
      indirect: indirect.code,
      toItself,
      edgesAfterIndirect,
      racedStatuses,
      edgesAfterRace,
      foreign,
      rivalEdges,
    };
  },

  // WORK-04, QA-006: done needs what the work asked for, or its accountable owner's own word.
  'PAR-WORK-04': async ({ su, tenant }) => {
    const { organization, owner } = await tenant();
    const delegate = await join(owner, organization, 'Dana Delegate');
    const rival = await tenant('Rival');

    const id = await createWork(owner, organization, {
      title: unique('Evidence'),
      criteria: ['artifact_exists'],
    });
    const page = workPage(organization, id);
    await move(owner, organization, id, 'ready', 'running', 'verifying');

    // The page offers no way to finish, and a forged request is refused too.
    const waiting = await read(page, owner.jar);
    const offersDone = waiting.html.includes('>Mark done<');
    expect(offersDone).toBe(false);
    const stillNeeded = sectionOf(waiting.html, 'verification-heading').includes('Still needed');
    expect(stillNeeded).toBe(true);
    const held = await rowOf(su, id);
    const inHand = await formOn(page, owner.jar, toStatus('running'));
    const withoutEvidence = await refusal(
      await post(page, owner.jar, inHand, { to: 'completed' }),
      page,
      owner,
    );
    expect(withoutEvidence).toEqual({
      code: 'EVIDENCE_MISSING',
      message:
        'This work cannot be marked done yet. Add what “Done when” asks for, then try again.',
    });
    expect(await rowOf(su, id)).toEqual(held);
    const statusAfterRefusal = await statusShown(page, owner);
    expect(statusAfterRefusal).toBe('Checking');

    const outsider = await post(page, rival.owner.jar, inHand, { to: 'completed' });
    expect(outsider.status).toBe(404);
    expect(await rowOf(su, id)).toEqual(held);

    // So that the refusal above cannot be a page that simply never finishes anything.
    await upload(owner, organization, id, new File(['result'], 'result.txt'));
    await move(owner, organization, id, 'completed');
    const withEvidence = await api(owner, 'GET', workUnitApi(organization, id));
    const evidenceBasis = (withEvidence.json as { completion?: { basis: string } }).completion
      ?.basis;
    expect(evidenceBasis).toBe('evidence');

    // Work that asks for nothing rests on one person's word, and that person only.
    const asked = await createWork(owner, organization, { title: unique('Confirm') });
    const askedPage = workPage(organization, asked);
    await submit(askedPage, owner.jar, /Add someone/, {
      membershipId: await membershipOf(su, delegate, organization),
    });
    await move(owner, organization, asked, 'ready', 'running', 'verifying');
    const theirs = await formOn(askedPage, delegate.jar, toStatus('running'));
    const notTheOwner = await refusal(
      await post(askedPage, delegate.jar, theirs, { to: 'completed' }),
      askedPage,
      delegate,
    );
    expect(notTheOwner.code).toBe('OWNER_CONFIRMATION_REQUIRED');
    const statusForDelegate = await statusShown(askedPage, delegate);
    expect(statusForDelegate).toBe('Checking');
    await move(owner, organization, asked, 'completed');
    const confirmed = await api(owner, 'GET', workUnitApi(organization, asked));
    const confirmedBasis = (confirmed.json as { completion?: { basis: string } }).completion?.basis;
    expect(confirmedBasis).toBe('owner_confirmed');

    return {
      offersDone,
      stillNeeded,
      withoutEvidence,
      statusAfterRefusal,
      versionMoved: false,
      outsider: outsider.status,
      evidenceBasis: evidenceBasis ?? null,
      notTheOwner,
      statusForDelegate,
      confirmedBasis: confirmedBasis ?? null,
    };
  },

  // WORK-03: one accountable owner, and a delegate who can move work along and nothing more.
  'PAR-WORK-05': async ({ su, tenant }) => {
    const { organization, owner } = await tenant();
    const delegate = await join(owner, organization, 'Dana Delegate');
    const member = await join(owner, organization, 'Milo Member');
    const rival = await tenant('Rival');
    const id = await createWork(owner, organization, { title: unique('Delegated') });
    const page = workPage(organization, id);
    const added = await submit(page, owner.jar, /Add someone/, {
      membershipId: await membershipOf(su, delegate, organization),
    });
    expect(locationOf(added)).toBe(page);

    const ownerShown = async () =>
      ownersOn(sectionOf((await read(page, owner.jar)).html, 'owner-heading'));
    const assignments = () => countOf(su, 'work.work_assignments where work_unit_id = $1', [id]);
    const startingOwner = await ownerShown();
    expect(startingOwner).toEqual({ count: 1, name: owner.name });
    const startingAssignments = await assignments();

    const delegateMain = mainOf((await read(page, delegate.jar)).html);
    const offered = {
      markReady: delegateMain.includes('Mark ready'),
      changeOwner: delegateMain.includes('Change owner'),
      addSomeone: delegateMain.includes('Add someone'),
      stop: delegateMain.includes('Stop this work'),
    };
    expect(offered).toEqual({
      markReady: true,
      changeOwner: false,
      addSomeone: false,
      stop: false,
    });

    // Out of scope, using the owner's own forms, so the page not offering them is not what stops it.
    const before = await rowOf(su, id);
    const changeOwner = await formOn(page, owner.jar, /Change owner/);
    const addSomeone = await formOn(page, owner.jar, /Add someone/);
    const stop = await formOn(page, owner.jar, toStatus('cancelled'));
    const refused = {
      changeOwner: await refusal(
        await forged(page, delegate, changeOwner, {
          membershipId: await membershipOf(su, delegate, organization),
        }),
        page,
        delegate,
      ),
      addSomeone: await refusal(
        await forged(page, delegate, addSomeone, {
          membershipId: await membershipOf(su, member, organization),
        }),
        page,
        delegate,
      ),
      stop: await refusal(
        await forged(page, delegate, stop, { confirm: 'yes', reason: 'Trying to stop it' }),
        page,
        delegate,
      ),
    };
    for (const each of Object.values(refused)) {
      expect(each).toEqual({
        code: 'FORBIDDEN',
        message: 'You do not have permission to do that.',
      });
    }
    expect(await ownerShown()).toEqual(startingOwner);
    expect(await assignments()).toBe(startingAssignments);
    expect(await rowOf(su, id)).toEqual(before);

    // Someone in the organization who is not on the work, and someone from outside it.
    const nextStep = await formOn(page, owner.jar, toStatus('ready'));
    const notOnIt = await refusal(await forged(page, member, nextStep), page, member);
    expect(notOnIt.code).toBe('FORBIDDEN');
    const outsider = await forged(page, rival.owner, changeOwner, {
      membershipId: await membershipOf(su, rival.owner, rival.organization),
    });
    expect(outsider.status).toBe(404);
    expect(await ownerShown()).toEqual(startingOwner);
    expect(await rowOf(su, id)).toEqual(before);

    // In scope.
    await move(delegate, organization, id, 'ready', 'running');
    const delegateMoved = await statusShown(page, owner);
    expect(delegateMoved).toBe('In progress');

    // Scope ends when it is taken away, with the next form they had still in their hand.
    const heldByDelegate = await formOn(page, delegate.jar, toStatus('verifying'));
    const removed = await submit(page, owner.jar, (form: Form) =>
      form.html.includes(`Remove ${delegate.name} from this work`),
    );
    expect(locationOf(removed)).toBe(page);
    const afterRemoval = await refusal(
      await post(page, delegate.jar, heldByDelegate),
      page,
      delegate,
    );
    expect(afterRemoval.code).toBe('FORBIDDEN');
    const statusAfterRemoval = await statusShown(page, owner);
    expect(statusAfterRemoval).toBe('In progress');

    // Handing over replaces the owner. There is never a second one.
    const handed = await submit(page, owner.jar, /Change owner/, {
      membershipId: await membershipOf(su, member, organization),
    });
    expect(locationOf(handed)).toBe(page);
    const newOwner = await ownerShown();
    expect(newOwner).toEqual({ count: 1, name: member.name });

    return {
      ownersNamed: startingOwner.count,
      offered,
      refused,
      assignmentsChanged: false,
      notOnIt,
      outsider: outsider.status,
      delegateMoved,
      afterRemoval,
      statusAfterRemoval,
      ownersAfterHandover: newOwner.count,
    };
  },

  // WORK-05: an approval covers one exact action until it runs out, and both are checked when used.
  'PAR-WORK-06': async ({ su, tenant }) => {
    const { organization, owner } = await tenant();
    const reviewer = await join(owner, organization, 'Remy Reviewer');
    const rival = await tenant('Rival');
    const newWork = async (criteria: readonly string[] = []) => {
      const id = await createWork(owner, organization, {
        title: unique('Approval'),
        criteria: [...criteria],
      });
      return { id, page: workPage(organization, id) };
    };
    const edit = (page: string) =>
      submit(page, owner.jar, /Save changes/, {
        title: unique('Changed'),
        objective: 'Something the reviewer never saw',
        dueAt: '',
      });
    const verification = async (page: string) =>
      sectionOf((await read(page, owner.jar)).html, 'verification-heading');

    // A decision on anything but what the page showed. Nothing is recorded, and it stays open.
    const tampered = await newWork();
    const open = await askForReview(su, owner, reviewer, organization, tampered.id);
    const form = await formOn(open.path, reviewer.jar, deciding('approve'));
    const changedAction = await refusal(
      await post(open.path, reviewer.jar, form, { shownHash: 'a'.repeat(64) }),
      open.path,
      reviewer,
    );
    expect(changedAction).toEqual({
      code: 'APPROVAL_HASH_MISMATCH',
      message:
        'The action changed after you reviewed it. Please review it again before you decide.',
    });
    const afterChangedAction = await statusShown(open.path, reviewer);
    expect(afterChangedAction).toBe('Waiting');
    const decisionsAfterChange = await decisionsOn(su, open.approvalId);
    expect(decisionsAfterChange).toBe(0);

    const outsider = await post(open.path, rival.owner.jar, form);
    expect(outsider.status).toBe(404);
    expect(await statusShown(open.path, reviewer)).toBe('Waiting');
    expect(await decisionsOn(su, open.approvalId)).toBe(0);

    // Approved, then the work changes: the approval stops counting, so nothing can finish on it.
    const edited = await newWork(['reviewer_approved']);
    const approved = await askForReview(su, owner, reviewer, organization, edited.id);
    await submit(approved.path, reviewer.jar, deciding('approve'));
    expect(await statusShown(approved.path, reviewer)).toBe('Approved');
    expect(locationOf(await edit(edited.page))).toBe(edited.page);
    await move(owner, organization, edited.id, 'ready', 'running', 'verifying');
    const editedReview = await verification(edited.page);
    expect(editedReview).toContain('Out of date');
    expect(editedReview).toContain('Still needed');
    const backFromEdited = await formOn(edited.page, owner.jar, toStatus('running'));
    const completeEdited = await refusal(
      await post(edited.page, owner.jar, backFromEdited, { to: 'completed' }),
      edited.page,
      owner,
    );
    expect(completeEdited.code).toBe('EVIDENCE_MISSING');
    const statusAfterEdited = await statusShown(edited.page, owner);
    expect(statusAfterEdited).toBe('Checking');

    // Still open when the work changes: it is closed, and the decision in hand finds nothing to decide.
    const closing = await newWork();
    const closed = await askForReview(su, owner, reviewer, organization, closing.id);
    const closedForm = await formOn(closed.path, reviewer.jar, deciding('approve'));
    expect(locationOf(await edit(closing.page))).toBe(closing.page);
    const reviewAfterEdit = await statusShown(closed.path, reviewer);
    expect(reviewAfterEdit).toBe('Closed');
    const decideClosed = await refusal(
      await post(closed.path, reviewer.jar, closedForm),
      closed.path,
      reviewer,
    );
    expect(decideClosed.code).toBe('APPROVAL_NOT_PENDING');
    const decisionsAfterClose = await decisionsOn(su, closed.approvalId);
    expect(decisionsAfterClose).toBe(0);

    // The time runs out before the decision, with the form still open in someone's tab.
    const lapsing = await newWork();
    const lapse = await askForReview(su, owner, reviewer, organization, lapsing.id);
    const lapseForm = await formOn(lapse.path, reviewer.jar, deciding('approve'));
    await runOutOfTime(su, lapse.approvalId);
    const decideExpired = await refusal(
      await post(lapse.path, reviewer.jar, lapseForm),
      lapse.path,
      reviewer,
    );
    expect(decideExpired).toEqual({
      code: 'APPROVAL_EXPIRED',
      message:
        'The time to decide this approval has passed. Ask for a new one if it is still needed.',
    });
    const reviewAfterExpiry = await read(lapse.path, reviewer.jar);
    const expiredOffersDecision = reviewAfterExpiry.html.includes('name="decision"');
    expect(expiredOffersDecision).toBe(false);
    const decisionsAfterExpiry = await decisionsOn(su, lapse.approvalId);
    expect(decisionsAfterExpiry).toBe(0);
    const expiredShown = await statusShown(lapse.path, reviewer);
    expect(expiredShown).toBe('Expired');

    // Approved in time, and used too late: expiry is checked again when it is used.
    const late = await newWork(['reviewer_approved']);
    const used = await askForReview(su, owner, reviewer, organization, late.id);
    await submit(used.path, reviewer.jar, deciding('approve'));
    await move(owner, organization, late.id, 'ready', 'running', 'verifying');
    expect((await read(late.page, owner.jar)).html).toContain('>Mark done<');
    await runOutOfTime(su, used.approvalId);
    const lateReview = await verification(late.page);
    expect(lateReview).toContain('Out of date');
    expect(lateReview).toContain('Still needed');
    const backFromLate = await formOn(late.page, owner.jar, toStatus('running'));
    const completeLate = await refusal(
      await post(late.page, owner.jar, backFromLate, { to: 'completed' }),
      late.page,
      owner,
    );
    expect(completeLate.code).toBe('EVIDENCE_MISSING');
    const statusAfterLate = await statusShown(late.page, owner);
    expect(statusAfterLate).toBe('Checking');

    return {
      changedAction,
      afterChangedAction,
      decisionsAfterChange,
      outsider: outsider.status,
      afterEdit: { review: 'Out of date', evidence: 'Still needed', completion: completeEdited },
      statusAfterEdited,
      reviewAfterEdit,
      decideClosed,
      decisionsAfterClose,
      decideExpired,
      expiredShown,
      expiredOffersDecision,
      decisionsAfterExpiry,
      afterLateUse: { review: 'Out of date', evidence: 'Still needed', completion: completeLate },
      statusAfterLate,
    };
  },

  // WORK-07, QA-014: the wait lives in durable state, so a restarted worker takes it up where it was.
  'PAR-WORK-07': async ({ su, tenant }) => {
    const { organization, owner } = await tenant();
    const reviewer = await join(owner, organization, 'Remy Reviewer');
    const rival = await tenant('Rival');
    const id = await createWork(owner, organization, {
      title: unique('Through a restart'),
      executionPlan: 'checklist',
      criteria: ['reviewer_approved'],
    });
    const page = workPage(organization, id);
    await move(owner, organization, id, 'ready');
    const statuses = [await statusShown(page, owner)];

    const started = await submit(page, owner.jar, /Run the plan/, {
      reviewerMembershipId: await membershipOf(su, reviewer, organization),
    });
    expect(locationOf(started)).toBe(page);
    await expect.poll(() => statusShown(page, owner), PLAN_WAIT).toBe('Waiting for approval');
    statuses.push(await statusShown(page, owner));
    const { approvalId, path } = await approvalOn(page, owner, organization);

    // Only the reviewer's decision can release it, before the restart or after.
    const inHand = await formOn(page, owner.jar, toStatus('cancelled'));
    const release = await refusal(
      await post(page, owner.jar, inHand, { to: 'running' }),
      page,
      owner,
    );
    expect(release.code).toBe('INVALID_TRANSITION');
    const held = await rowOf(su, id);

    compose('restart', 'worker');

    statuses.push(await statusShown(page, owner));
    const reviewAfterRestart = await statusShown(path, reviewer);
    expect(reviewAfterRestart).toBe('Waiting');
    expect(await rowOf(su, id)).toEqual(held);

    const decision = await formOn(path, reviewer.jar, deciding('approve'));
    const outsider = await post(path, rival.owner.jar, decision);
    expect(outsider.status).toBe(404);
    expect(await decisionsOn(su, approvalId)).toBe(0);
    expect(await rowOf(su, id)).toEqual(held);

    const decided = await post(path, reviewer.jar, decision);
    expect(locationOf(decided)).toBe(path);
    await expect.poll(() => statusShown(page, owner), RESUME_WAIT).toBe('Checking');
    statuses.push(await statusShown(page, owner));

    // Nothing was repeated by coming back: one checklist, and one review with one decision.
    const files = await countOf(su, 'work.work_artifacts where work_unit_id = $1', [id]);
    expect(files).toBe(1);
    const reviews = await countOf(su, 'work.approvals where work_unit_id = $1', [id]);
    expect(reviews).toBe(1);
    const decisions = await decisionsOn(su, approvalId);
    expect(decisions).toBe(1);

    // The approval given after the restart is the evidence this work asked for.
    await move(owner, organization, id, 'completed');
    statuses.push(await statusShown(page, owner));
    expect(statuses).toEqual([
      'Ready',
      'Waiting for approval',
      'Waiting for approval',
      'Checking',
      'Done',
    ]);

    return {
      statuses,
      release,
      reviewAfterRestart,
      outsider: outsider.status,
      files,
      reviews,
      decisions,
    };
  },

  // UX-17: told and reminded in the product, which works with nothing outside it reachable. The Sovereign
  // round runs with outside names unreachable, so passing there is part of what this shows.
  'PAR-WORK-08': async ({ su, tenant }) => {
    const { organization, owner } = await tenant();
    const reviewer = await join(owner, organization, 'Remy Reviewer');
    const bystander = await join(owner, organization, 'Bea Bystander');
    const rival = await tenant('Rival');

    const title = unique('Unanswered');
    const id = await createWork(owner, organization, { title });
    const { approvalId, path } = await askForReview(su, owner, reviewer, organization, id);
    const target = `approval:${approvalId}`;

    // Something newer, so that a reminder bringing the request back to the top is something to see.
    const later = await createWork(owner, organization, { title: unique('Later') });
    await submit(workPage(organization, later), owner.jar, /Add someone/, {
      membershipId: await membershipOf(su, reviewer, organization),
    });

    const rows = async () => (await inboxRows(reviewer, organization)).map(describeRow);
    const notice = await rows();
    expect(notice).toEqual([
      { says: 'You were put on some work', reminder: false, unread: true },
      { says: 'An approval needs your decision', reminder: false, unread: true },
    ]);
    const reviewsPath = `/o/${organization}?view=reviews`;
    const reviewerHome = await read(reviewsPath, reviewer.jar);
    expect(reviewerHome.status).toBe(200);
    const reviewQueue = sectionOf(reviewerHome.html, 'review-queue-heading');
    expect(reviewQueue).toContain(title);
    expect(reviewQueue).toContain(`href="${path}"`);

    // Told by reference only, and only the person asked is told.
    const { rows: stored } = await su.query<{ reference: string; reminders: number }>(
      `select split_part(target_ref, ':', 1) as reference, reminders_sent::int as reminders
       from platform.notifications where target_ref = $1`,
      [target],
    );
    expect(stored).toEqual([{ reference: 'approval', reminders: 0 }]);
    const bystanderRows = await inboxRows(bystander, organization);
    expect(bystanderRows).toEqual([]);
    const bystanderHome = await read(reviewsPath, bystander.jar);
    expect(bystanderHome.status).toBe(200);
    const bystanderMain = mainOf(bystanderHome.html);
    expect(bystanderMain).toContain('No reviews waiting');
    expect(bystanderMain).not.toContain(title);
    expect(bystanderMain).not.toContain(`href="${path}"`);
    const outsider = await read(inboxPath(organization), rival.owner.jar);
    expect(outsider.status).toBe(404);
    expect(outsider.html).not.toContain(title);
    const rivalRows = await inboxRows(rival.owner, rival.organization);
    expect(rivalRows.join()).not.toContain(title);

    const reminded = await withUpkeep(organization, async (runUpkeep) => {
      // As if it had been waiting long enough. Nothing is due until the clock says so.
      await su.query(
        `update platform.notifications set remind_at = now() - interval '1 minute'
         where target_ref = $1`,
        [target],
      );
      await runUpkeep();
      await expect
        .poll(
          async () =>
            (
              await su.query<{ n: number }>(
                'select reminders_sent::int as n from platform.notifications where target_ref = $1',
                [target],
              )
            ).rows[0]?.n,
          { timeout: 60_000, interval: 500 },
        )
        .toBe(1);
      return rows();
    });
    expect(reminded).toEqual([
      { says: 'An approval needs your decision', reminder: true, unread: true },
      { says: 'You were put on some work', reminder: false, unread: true },
    ]);
    expect(await inboxRows(bystander, organization)).toEqual([]);

    // Opening the notice leads to the decision, which is what it is for.
    const opening = await submit(
      inboxPath(organization),
      reviewer.jar,
      (form: Form) => form.hidden.get('target') === path,
    );
    expect(locationOf(opening)).toBe(path);

    // The Inbox works with no provider connection or external action.
    const externalActions = await countOf(
      su,
      'integrations.external_actions where organization_id = $1',
      [organization],
    );
    expect(externalActions).toBe(0);
    const connections = await countOf(su, 'integrations.connections where organization_id = $1', [
      organization,
    ]);
    expect(connections).toBe(0);

    // Once decided, it stops asking.
    await submit(path, reviewer.jar, deciding('approve'));
    const afterDecision = await rows();
    const decidedRow = afterDecision.find((row) => row.says === 'An approval needs your decision');
    expect(decidedRow?.unread).toBe(false);
    const stillDue = await countOf(
      su,
      'platform.notifications where target_ref = $1 and remind_at is not null',
      [target],
    );
    expect(stillDue).toBe(0);
    const ownerRows = await inboxRows(owner, organization);
    const ownerTold = ownerRows.some((row) => row.includes('A review of your work was decided'));
    expect(ownerTold).toBe(true);

    return {
      notice,
      reminded,
      stored,
      bystanderRows: bystanderRows.length,
      outsider: outsider.status,
      externalActions,
      connections,
      decidedRow: decidedRow ?? null,
      stillDue,
      ownerTold,
    };
  },

  // API-12: one error shape for everything a client can get wrong, and one contract for all of it. Every
  // answer here has also been checked against the OpenAPI document by api().
  'PAR-WORK-09': async ({ su, tenant }) => {
    const { organization, owner } = await tenant();
    const rival = await tenant('Rival');
    const collection = workUnitsApi(organization);
    const works = () => countOf(su, 'work.work_units where organization_id = $1', [organization]);
    const create = (options: Parameters<typeof api>[3]) =>
      api(owner, 'POST', collection, { key: randomUUID(), ...options });

    // A request that is right gets through, so the refusals below are not an API that refuses everything.
    const made = await create({ body: { title: unique('Fine'), objective: 'Written by a test' } });
    expect(made.status, made.text).toBe(201);
    const created = made.json as { id: string; status: string; version: number };
    const read200 = await api(owner, 'GET', workUnitApi(organization, created.id));
    expect(read200.status).toBe(200);
    expect(await works()).toBe(1);

    const canary = `canary${randomUUID()}`;
    const malformed = await create({ raw: `{"title": "${canary}", oops` });
    expect(malformed.text).not.toContain(canary);
    const wrongField = await create({ body: { title: canary, objective: 42 } });
    expect(wrongField.text).not.toContain(canary);
    const notAnId = await api(owner, 'GET', workUnitApi(organization, 'not-a-uuid'));
    const wrongType = await create({
      raw: '{}',
      headers: { 'content-type': 'text/plain' },
    });
    const missingWork = await api(owner, 'GET', workUnitApi(organization, randomUUID()));
    const missingApproval = await api(
      owner,
      'GET',
      `/api/v1/organizations/${organization}/approvals/${randomUUID()}`,
    );
    const notSignedIn = await api(undefined, 'GET', collection);

    // Another tenant's work answers exactly as work that does not exist, so no ID can be probed.
    const theirs = await api(rival.owner, 'POST', workUnitsApi(rival.organization), {
      key: randomUUID(),
      body: { title: unique('Theirs'), objective: 'Written by a test' },
    });
    expect(theirs.status).toBe(201);
    const theirId = (theirs.json as { id: string }).id;
    const missingShape = envelope(missingWork, 404, 'NOT_FOUND');
    const theirWork = envelope(
      await api(owner, 'GET', workUnitApi(organization, theirId)),
      404,
      'NOT_FOUND',
    );
    const theirOrganization = envelope(
      await api(owner, 'GET', workUnitApi(rival.organization, theirId)),
      404,
      'NOT_FOUND',
    );
    expect(theirWork).toEqual(missingShape);
    expect(theirOrganization).toEqual(missingShape);

    const refused = {
      malformedBody: envelope(malformed, 400, 'INVALID_INPUT'),
      wrongField: envelope(wrongField, 400, 'INVALID_INPUT'),
      notAnId: envelope(notAnId, 400, 'INVALID_INPUT'),
      wrongMediaType: envelope(wrongType, 415, 'UNSUPPORTED_MEDIA_TYPE'),
      missingWork: missingShape,
      missingApproval: envelope(missingApproval, 404, 'NOT_FOUND'),
      notSignedIn: envelope(notSignedIn, 401, 'UNAUTHENTICATED'),
    };
    expect(refused.wrongField.details).toEqual({ fields: ['objective'] });

    // None of those made anything.
    const worksAfter = await works();
    expect(worksAfter).toBe(1);
    const canaryRows = await countOf(su, 'work.work_units where title = $1', [canary]);
    expect(canaryRows).toBe(0);

    return {
      created: { status: made.status, workStatus: created.status, version: created.version },
      read: read200.status,
      refused,
      foreignAnswersAsMissing: true,
      worksAfter,
      canaryRows,
    };
  },

  // API-13: nothing about a status stream lives in the replica serving it, so a client that comes back on
  // the other one finds the same durable state.
  'PAR-WORK-10': async ({ su, tenant }) => {
    const { organization, owner } = await tenant();
    const rival = await tenant('Rival');
    const streams = openStreams();
    try {
      const title = unique('Reconnect');
      const id = await createWork(owner, organization, { title });
      const page = workPage(organization, id);
      const path = eventsPath(organization, id);
      const retitle = async (on: 'web' | 'web-2', version: number) => {
        const result = await api(owner, 'PATCH', workUnitApi(organization, id), {
          body: { title: unique('Changed') },
          headers: { 'if-match': `"${version}"` },
          replica: on,
        });
        expect(result.status, result.text).toBe(200);
        expect(result.headers.get('x-ensemus-served-by')).toBe(on);
        return version + 1;
      };

      const first = await streams.follow(owner.jar, path);
      expect(first.servedBy).toBe('web');
      await expect.poll(() => lastIdOf(first), STREAM_WAIT).toBe('1');
      let version = await retitle('web', 1);
      await expect.poll(() => lastIdOf(first), STREAM_WAIT).toBe('2');
      const seen = lastIdOf(first) as string;

      // The client goes away, and the work moves on without it, through a page and through the API.
      first.close();
      await move(owner, organization, id, 'ready');
      version += 1;
      version = await retitle('web', version);
      expect(lastIdOf(first)).toBe(seen);

      const second = await streams.follow(owner.jar, path, {
        replica: 'web-2',
        lastEventId: seen,
      });
      expect(second.status).toBe(200);
      expect(second.servedBy).toBe('web-2');
      await expect.poll(() => lastIdOf(second), STREAM_WAIT).toBe(String(version));
      // The latest state, once, and not a replay of what it missed.
      const onReconnect = second.received.map((event) => ({
        event: event.event,
        id: event.id ?? null,
        data: event.data,
      }));
      expect(onReconnect).toEqual([
        { event: 'status', id: String(version), data: String(version) },
      ]);

      // The same state whichever replica is asked, and whichever way.
      const statusOnWeb = await onReplica('web', () => statusShown(page, owner));
      const statusOnOther = await onReplica('web-2', () => statusShown(page, owner));
      expect(statusOnOther).toBe(statusOnWeb);
      const apiOnWeb = await api(owner, 'GET', workUnitApi(organization, id));
      const apiOnOther = await api(owner, 'GET', workUnitApi(organization, id), {
        replica: 'web-2',
      });
      expect(apiOnOther.json).toEqual(apiOnWeb.json);
      expect((apiOnOther.json as { version: number }).version).toBe(version);
      const { version: stored } = await rowOf(su, id);
      expect(stored).toBe(version);

      // Live from then on, including what the other replica does.
      version = await retitle('web', version);
      await expect.poll(() => lastIdOf(second), STREAM_WAIT).toBe(String(version));

      // Already up to date: nothing to say until something changes, and it stays open.
      const current = await streams.follow(owner.jar, path, {
        replica: 'web-2',
        lastEventId: String(version),
      });
      await new Promise((done) => setTimeout(done, 2_500));
      expect(current.received).toEqual([]);
      const stayedOpen = !current.ended();
      expect(stayedOpen).toBe(true);

      // Someone else, holding the same last version, on the same replica.
      const outsider = await streams.follow(rival.owner.jar, path, {
        replica: 'web-2',
        lastEventId: seen,
      });
      expect(outsider.status).toBe(404);
      expect(outsider.servedBy).toBe('web-2');
      await expect.poll(() => outsider.ended(), STREAM_WAIT).toBe(true);
      expect(outsider.received).toEqual([]);
      expect(outsider.raw()).not.toContain(title);

      return {
        firstServedBy: first.servedBy ?? null,
        reconnectServedBy: second.servedBy ?? null,
        reconnectStatus: second.status,
        onReconnect,
        statusOnWeb,
        statusOnOther,
        liveVersion: lastIdOf(second) ?? null,
        whenCurrent: { received: current.received.length, stayedOpen },
        outsider: { status: outsider.status, received: outsider.received.length },
      };
    } finally {
      streams.closeAll();
    }
  },

  // LIFE-01: gone for everyone, at once, on both replicas and in the store, and the ledger holds that
  // for after a restore. Restoring a backup is tests/stack/restore.test.ts: a parity round does not do it.
  'PAR-WORK-11': async ({ su, tenant }) => {
    const { organization, owner } = await tenant();
    const member = await join(owner, organization, 'Milo Member');
    const reviewer = await join(owner, organization, 'Remy Reviewer');
    const rival = await tenant('Rival');
    const store = objectStore();

    const id = await createWork(owner, organization, { title: unique('Files') });
    const page = workPage(organization, id);
    const name = `doomed-${randomUUID()}.txt`;
    const content = `The doomed content ${randomUUID()}`;
    const file = () => new File([content], name, { type: 'text/plain' });
    // Kept, so sending it again can be tried. A resent page is how deleted things come back.
    const uploadForm = await formOn(page, owner.jar, /name="file"/);
    const sent = await post(page, owner.jar, uploadForm, { file: file() });
    expect(locationOf(sent)).toBe(page);
    const link = await linkTo(page, owner, name);
    const artifactId = artifactIn(link);
    const keptName = `kept-${randomUUID()}.txt`;
    const keptLink = await upload(owner, organization, id, new File(['kept'], keptName));
    const bytes = objectKey(organization, artifactId);

    // Everything that serves it does, first, so what follows cannot pass because it never worked.
    expect((await download(link, owner.jar)).body).toBe(content);
    expect((await onReplica('web-2', () => download(link, owner.jar))).body).toBe(content);
    expect(await store.exists(bytes)).toBe(true);
    const review = await askForReview(su, owner, reviewer, organization, id);
    await submit(review.path, reviewer.jar, deciding('approve'));
    const covered = sectionOf((await read(review.path, reviewer.jar)).html, 'covers-heading');
    expect(covered).toContain(name);

    // Deleting has to be meant, and has to be allowed. Each refusal leaves the file where it was.
    const deleting = (form: Form) => form.hidden.get('artifactId') === artifactId;
    const deleteForm = await formOn(page, owner.jar, deleting);
    const notMeant = await refusal(await post(page, owner.jar, deleteForm), page, owner);
    expect(notMeant.code).toBe('INVALID_INPUT');
    const notAllowed = await refusal(
      await post(page, member.jar, deleteForm, { confirm: 'yes' }),
      page,
      member,
    );
    expect(notAllowed.code).toBe('FORBIDDEN');
    const outsiderDelete = await post(page, rival.owner.jar, deleteForm, { confirm: 'yes' });
    expect(outsiderDelete.status).toBe(404);
    expect((await download(link, owner.jar)).status).toBe(200);
    expect(await store.exists(bytes)).toBe(true);
    const tombstones = () =>
      countOf(su, `platform.tombstones where target_type = 'artifact' and target_id = $1`, [
        artifactId,
      ]);
    expect(await tombstones()).toBe(0);

    const removed = await post(page, owner.jar, deleteForm, { confirm: 'yes' });
    expect(locationOf(removed)).toBe(page);

    // Each path that served it, with nothing in between to give a cache time to expire.
    const owners = await download(link, owner.jar);
    const otherReplica = await onReplica('web-2', () => download(link, owner.jar));
    const signedOut = await download(link);
    const outsider = await download(link, rival.owner.jar);
    for (const answer of [owners, otherReplica, outsider]) {
      expect(answer.status).toBe(404);
      expect(answer.body).not.toContain(content);
    }
    expect(signedOut.status).not.toBe(200);
    expect(signedOut.body).not.toContain(content);

    const workView = mainOf((await read(page, owner.jar)).html);
    expect(workView).not.toContain(name);
    const reviewView = sectionOf((await read(review.path, reviewer.jar)).html, 'covers-heading');
    expect(reviewView).not.toContain(name);
    expect(reviewView).toContain('One file this covered has since been deleted.');

    // What was deleted is the only thing that went.
    const kept = await download(keptLink, owner.jar);
    expect(kept.status).toBe(200);
    expect(kept.body).toBe('kept');

    // The bytes are gone, and the record of it is written down in both places a restore looks.
    const bytesRemain = await store.exists(bytes);
    expect(bytesRemain).toBe(false);
    const tombstoneRows = await tombstones();
    expect(tombstoneRows).toBe(1);
    const rowsLeft = await countOf(su, 'work.artifacts where id = $1', [artifactId]);
    expect(rowsLeft).toBe(0);
    const { rows: lifecycle } = await su.query<{ state: string }>(
      'select state from platform.blob_lifecycle where artifact_id = $1',
      [artifactId],
    );
    expect(lifecycle).toEqual([{ state: 'purged' }]);
    const ledgerKey = ledgerKeyFor({
      organizationId: organization,
      targetType: 'artifact',
      targetId: artifactId,
    });
    await expect.poll(() => store.exists(ledgerKey), LEDGER_WAIT).toBe(true);

    // Nothing brings it back: deleting it again finds nothing, and resending the very form that added
    // it attaches a new file, with an ID of its own, while the old address stays gone.
    const again = await refusal(
      await post(page, owner.jar, deleteForm, { confirm: 'yes' }),
      page,
      owner,
    );
    expect(again.code).toBe('NOT_FOUND');
    const resent = await post(page, owner.jar, uploadForm, { file: file() });
    expect(locationOf(resent)).toBe(page);
    const newLink = await linkTo(page, owner, name);
    const sameAddress = newLink === link;
    expect(sameAddress).toBe(false);
    const oldAddress = await download(link, owner.jar);
    expect(oldAddress.status).toBe(404);
    const oldOnOtherReplica = await onReplica('web-2', () => download(link, owner.jar));
    expect(oldOnOtherReplica.status).toBe(404);
    const oldBytesRemain = await store.exists(bytes);
    expect(oldBytesRemain).toBe(false);

    return {
      refused: { notMeant, notAllowed, outsider: outsiderDelete.status },
      afterDelete: {
        owner: owners.status,
        otherReplica: otherReplica.status,
        outsider: outsider.status,
        signedOutServed: signedOut.status === 200,
        listedOnWork: false,
        listedOnReview: false,
        kept: kept.status,
      },
      bytesRemain,
      tombstoneRows,
      rowsLeft,
      lifecycle: lifecycle.map((row) => row.state),
      inLedger: true,
      deleteAgain: again,
      resend: {
        sameAddress,
        oldAddress: oldAddress.status,
        oldOnOtherReplica: oldOnOtherReplica.status,
        oldBytesRemain,
      },
    };
  },
});
