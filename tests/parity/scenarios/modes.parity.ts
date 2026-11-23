// COMM-06: what runs on models and data in every mode, then the differences the contract allows. The
// slice's table is in docs/06-delivery/m9p-slices.md, and what each scenario holds is in ../catalog.ts.
//
// Nearly all of this waits on a seam, and calls `seam()` before anything else, so that an unplugged seam
// reports blocked without leaving half a setup behind. `PAR-MODE-01` needs none. None of this has run.
//
// Each mode_contract scenario derives its value from what the deployment did, asserts that against
// `expected('<dimension>')`, and returns it, so it cannot choose its own answer. Numbers in an observation
// are counts. They are never a price, an allowance or a limit, and the packet count stays the air-gap
// gate's, because only that gate has a firewall to count with.
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { sectionOf } from '../../helpers/flows';
import { read, signUp } from '../../helpers/forms';
import {
  ACCEPTED_MANIFESTS,
  MANIFESTS_REFUSED_BY_FORMAT,
  MANIFESTS_REFUSED_BY_RULES,
  NEXT_VERSION,
  SAME_VERSION_WIDENED,
} from '../fixtures/agent-manifests';
import { describeParity, statedDeployment } from '../harness';
import {
  agentVersionsStored,
  chargesIn,
  counted,
  deniedCode,
  exerciseCoreWork,
  expectRefusalCode,
  finishWork,
  holderStatedIn,
  INTERNAL_CHAT,
  INTERNAL_EMBEDDING,
  ledgerOf,
  licenseValidationFrom,
  maintenanceLapseFrom,
  manifestsThatDriftedFromTheSchema,
  MODE_WORDS,
  offlineOperationFrom,
  plantCredentials,
  publishEach,
  seedBusinessRecords,
  startWork,
  updatesFrom,
  vendorTelemetryFrom,
  walkWorkToDone,
  workUnitsStored,
} from './modes-support';

const ANSWERED = { result: 'answered' };

describeParity('modes', {
  'PAR-AGENT-01': async ({ seam, su, tenant }) => {
    const agents = seam('agentRuns');
    expect(manifestsThatDriftedFromTheSchema()).toEqual([]);
    const first = await tenant();
    const rival = await tenant('Rival');

    const accepted = await publishEach(agents, first, ACCEPTED_MANIFESTS);
    expect(Object.values(accepted).every((code) => code === null)).toBe(true);

    const refused = await publishEach(agents, first, [
      ...MANIFESTS_REFUSED_BY_FORMAT,
      ...MANIFESTS_REFUSED_BY_RULES,
    ]);
    for (const code of Object.values(refused)) expectRefusalCode(code);
    // Refused means nothing was written, and not only that a code came back.
    expect(await agentVersionsStored(su, first.organization)).toBe(ACCEPTED_MANIFESTS.length);

    const widened = await agents.publishManifest(first, SAME_VERSION_WIDENED.manifest);
    expectRefusalCode(widened);
    expect(await agents.publishManifest(first, NEXT_VERSION.manifest)).toBeNull();
    const stored = await agentVersionsStored(su, first.organization);
    expect(stored).toBe(ACCEPTED_MANIFESTS.length + 1);

    // One organization's agent IDs say nothing to another, which has only what it published itself.
    const rivalAccepted = await publishEach(agents, rival, ACCEPTED_MANIFESTS);
    expect(Object.values(rivalAccepted).every((code) => code === null)).toBe(true);
    expect(await agentVersionsStored(su, rival.organization)).toBe(ACCEPTED_MANIFESTS.length);

    return {
      accepted: Object.keys(accepted),
      refused,
      sameVersionWidened: widened,
      nextVersion: 'accepted',
      versionsStored: stored,
      rivalAccepted: Object.keys(rivalAccepted),
    };
  },

  'PAR-AGENT-02': async ({ seam, tenant }) => {
    const agents = seam('agentRuns');
    const { end, code } = await agents.runOverBudget(await tenant());
    expect(end).toBe('budget_exceeded');
    expectRefusalCode(code);
    return { end, code };
  },

  'PAR-AGENT-03': async ({ seam, tenant }) => {
    const agents = seam('agentRuns');
    const { end, code } = await agents.delegateBeyondParent(await tenant());
    expect(end).toBe('denied');
    expectRefusalCode(code);
    return { end, code };
  },

  'PAR-AGENT-04': async ({ seam, tenant }) => {
    const agents = seam('agentRuns');
    const stopping = await tenant();
    const rival = await tenant('Rival');
    const { queued, running } = await agents.emergencyStop(stopping);
    expect({ queued, running }).toEqual({ queued: 'stopped', running: 'stopped' });
    // A stop reaches only the organization that pulled it, so another's run still ends by its own rule.
    const elsewhere = await agents.runOverBudget(rival);
    expect(elsewhere.end).toBe('budget_exceeded');
    return { queued, running, otherOrganization: elsewhere.end };
  },

  'PAR-KNOW-01': async ({ seam, tenant }) => {
    const knowledge = seam('knowledge');
    const holder = await tenant();
    const rival = await tenant('Rival');
    const { source } = await knowledge.ingest(holder, `Parity source ${randomUUID()}`);
    const { source: untouched } = await knowledge.ingest(holder, `Parity other ${randomUUID()}`);
    const person = holder.owner;

    // Served twice first, so anything that caches an answer has one when the revoke lands.
    const served = [
      await knowledge.serves(holder, person, source),
      await knowledge.serves(holder, person, source),
    ];
    expect(served).toEqual([true, true]);
    const rivalServed = await knowledge.serves(rival, rival.owner, source);
    expect(rivalServed).toBe(false);

    await knowledge.revoke(holder, person, source);
    // No wait and no retry: the very next read is the claim.
    const afterRevoke = await knowledge.serves(holder, person, source);
    expect(afterRevoke).toBe(false);
    // A search that had simply stopped working would also serve nothing.
    const otherSource = await knowledge.serves(holder, person, untouched);
    expect(otherSource).toBe(true);

    return { served, rivalServed, afterRevoke, otherSource };
  },

  'PAR-KNOW-02': async ({ seam, tenant }) => {
    const knowledge = seam('knowledge');
    const holder = await tenant();
    // Read twice: nothing has reviewed it, so nothing may have settled it in between.
    const states = [
      await knowledge.conflictingFactState(holder),
      await knowledge.conflictingFactState(holder),
    ];
    expect(states).toEqual(['disputed', 'disputed']);
    return { states };
  },

  'PAR-PORT-01': async ({ seam, su, tenant }) => {
    const portability = seam('portability');
    const source = await tenant();
    const rival = await tenant('Rival');
    const own = await seedBusinessRecords(source);
    const theirs = await seedBusinessRecords(rival);

    const { archive, counts } = await portability.exportOrganization(source);
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    expect(total).toBeGreaterThanOrEqual(own.records);

    // The search is shown to find what is there, and another organization's work is not there.
    const holdsOwn = await portability.archiveContains(archive, own.workTitle);
    const holdsRival = await portability.archiveContains(archive, theirs.workTitle);
    expect({ holdsOwn, holdsRival }).toEqual({ holdsOwn: true, holdsRival: false });

    const workBefore = await workUnitsStored(su, source.organization);
    const imported = await portability.importOrganization(archive);
    expect(imported).toEqual(counts);

    // Importing makes a new organization. It must not have written into the one it came from.
    const workAfter = await workUnitsStored(su, source.organization);
    expect(workAfter).toBe(workBefore);

    return { exported: counts, imported, holdsOwn, holdsRival, workUnitsInSource: workAfter };
  },

  'PAR-PORT-02': async ({ seam, su, tenant }) => {
    const portability = seam('portability');
    const holder = await tenant();
    const seeded = await seedBusinessRecords(holder);
    const { connectionName, secrets } = await plantCredentials(su, holder);

    const { archive } = await portability.exportOrganization(holder);

    // Without these two, a search that can find nothing would pass every line below.
    const holdsWork = await portability.archiveContains(archive, seeded.workTitle);
    const holdsConnection = await portability.archiveContains(archive, connectionName);
    expect({ holdsWork, holdsConnection }).toEqual({ holdsWork: true, holdsConnection: true });

    const found: Record<string, boolean> = {};
    for (const [kind, value] of Object.entries(secrets)) {
      found[kind] = await portability.archiveContains(archive, value);
      expect(found[kind], kind).toBe(false);
    }
    return { holdsWork, holdsConnection, found };
  },

  'PAR-MODEL-01': async ({ seam, tenant }) => {
    const supply = seam('modelSupply');
    const down = await tenant();
    const control = await tenant('Rival');
    await supply.arrange(down, 'unreachable');
    await supply.arrange(control, 'answers');

    // The count moves when a call really reaches a provider, so a zero below is not just a broken count.
    const reached = await counted(supply, () => supply.invoke(control, INTERNAL_CHAT));
    expect(reached).toEqual({ answer: ANSWERED, calls: 1 });

    const chat = await counted(supply, () => supply.invoke(down, INTERNAL_CHAT));
    const embedding = await counted(supply, () => supply.invoke(down, INTERNAL_EMBEDDING));
    const chatCode = deniedCode(chat.answer);
    const embeddingCode = deniedCode(embedding.answer);
    expect(chat.calls + embedding.calls).toBe(0);

    // Nothing moved it to a supplier the customer did not choose.
    const supplier = await supply.supplierUsed(down);
    expect(supplier).toBe('customer_providers');

    // One customer's provider being down says nothing about another's.
    const stillUp = await counted(supply, () => supply.invoke(control, INTERNAL_CHAT));
    expect(stillUp).toEqual({ answer: ANSWERED, calls: 1 });

    return {
      chat: chat.answer.result,
      chatCode,
      embedding: embedding.answer.result,
      embeddingCode,
      callsReceived: chat.calls + embedding.calls,
      supplier,
      otherOrganization: stillUp.answer.result,
    };
  },

  'PAR-MODEL-02': async ({ seam, tenant }) => {
    const supply = seam('modelSupply');
    const rotating = await tenant();
    const rival = await tenant('Rival');
    await supply.arrange(rotating, 'answers');
    await supply.arrange(rival, 'answers');

    const before = await counted(supply, () => supply.invoke(rotating, INTERNAL_CHAT));
    expect(before).toEqual({ answer: ANSWERED, calls: 1 });
    const visibleBefore = await supply.customerKeyVisibleToMembers(rotating);

    await supply.rotateCustomerKey(rotating);

    // BYOM-TS-01 allows the call to be denied or to go ahead. What it must not do is anything between.
    const after = await counted(supply, () => supply.invoke(rotating, INTERNAL_CHAT));
    const code = after.answer.result === 'denied' ? deniedCode(after.answer) : null;
    expect(after.calls).toBe(after.answer.result === 'answered' ? 1 : 0);

    const visibleAfter = await supply.customerKeyVisibleToMembers(rotating);
    expect({ visibleBefore, visibleAfter }).toEqual({ visibleBefore: false, visibleAfter: false });
    expect(await supply.supplierUsed(rotating)).toBe('customer_providers');

    const elsewhere = await counted(supply, () => supply.invoke(rival, INTERNAL_CHAT));
    expect(elsewhere).toEqual({ answer: ANSWERED, calls: 1 });

    return {
      afterRotation: after.answer.result,
      code,
      callsReceived: after.calls,
      keyVisible: [visibleBefore, visibleAfter],
      otherOrganization: elsewhere.answer.result,
    };
  },

  // Needs only a person who has no organization yet, which is who the setup page speaks to.
  'PAR-MODE-01': async ({ expected, mode }) => {
    const person = await signUp('Parity Responsibility');
    const { status, html } = await read('/', person.jar);
    expect(status).toBe(200);
    const statement = sectionOf(html, 'responsibility-heading');
    expect(statement).toContain('Who is responsible for your data');
    expect(statement).toContain('AI features use models approved for your organization.');
    expect(statement).toContain('controls what data those models can receive.');

    const holder = holderStatedIn(statement);
    expect(holder).toBe(expected('responsibility_statement'));

    const own = MODE_WORDS[mode];
    const deployment = statedDeployment(html);
    if (deployment === undefined) throw new Error('The page did not state its deployment mode');
    expect(deployment).toBe(own.deployment);
    for (const words of own.says) expect(statement).toContain(words);
    for (const words of own.neverSays) expect(statement).not.toContain(words);
    expect(statement).not.toMatch(/SOC ?2|ISO ?27001|HIPAA|certified/i);

    return { responsibility_statement: holder, deployment, says: [...own.says] };
  },

  'PAR-MODE-02': async ({ expected, seam, tenant }) => {
    const supply = seam('modelSupply');
    const holder = await tenant();
    await supply.arrange(holder, 'answers');
    const call = await counted(supply, () => supply.invoke(holder, INTERNAL_CHAT));
    expect(call).toEqual({ answer: ANSWERED, calls: 1 });
    const supplier = await supply.supplierUsed(holder);
    expect(supplier).toBe(expected('model_supply'));
    return { model_supply: supplier, call: call.answer.result, callsReceived: call.calls };
  },

  'PAR-MODE-03': async ({ expected, mode, seam, su, tenant }) => {
    const billing = seam('entitlement');
    const supply = seam('modelSupply');
    const holder = await tenant();
    const rival = await tenant('Rival');
    await supply.arrange(holder, 'answers');

    const call = await counted(supply, () => supply.invoke(holder, INTERNAL_CHAT));
    expect(call).toEqual({ answer: ANSWERED, calls: 1 });

    const billedTo = await billing.inferenceBilledTo(holder);
    expect(billedTo).toBe(expected('inference_billing'));

    // The seam says who. The ledger says how often, and each entry says which mode made it.
    const ledger = await ledgerOf(su, holder.organization);
    const charges = chargesIn(ledger);
    expect(charges.payer).toBe(billedTo);
    expect(charges.chargedTwice).toBe(0);
    expect(new Set(ledger.map((group) => group.commercial_mode))).toEqual(new Set([mode]));
    expect(await ledgerOf(su, rival.organization)).toEqual([]);

    return {
      inference_billing: billedTo,
      billedEntries: charges.billed,
      unbilledEntries: charges.unbilled,
      chargedTwice: charges.chargedTwice,
    };
  },

  'PAR-MODE-04': async ({ expected, seam, su, tenant }) => {
    const billing = seam('entitlement');
    const holder = await tenant();
    await billing.exhaustAllowance(holder);
    const chargedBefore = chargesIn(await ledgerOf(su, holder.organization)).billed;

    const { run, chargedWithoutAsking } = await billing.afterExhaustion(holder);
    expect({ run, chargedWithoutAsking }).toEqual({ run: 'paused', chargedWithoutAsking: false });
    // Not only the seam's word for it: nothing billable was written while it was paused.
    const newCharges = chargesIn(await ledgerOf(su, holder.organization)).billed - chargedBefore;
    expect(newCharges).toBe(0);

    const billedTo = await billing.inferenceBilledTo(holder);
    expect(billedTo).toBe(expected('inference_billing'));
    return { inference_billing: billedTo, run, chargedWithoutAsking, newCharges };
  },

  'PAR-MODE-05': async ({ expected, seam, tenant }) => {
    const outbound = seam('outbound');
    const holder = await tenant();
    // Exercising the product is the test. Waiting and then counting would prove only an idle stack.
    const core = await exerciseCoreWork(holder);
    const attempts = await outbound.attemptsDuringRound();
    expect(attempts).toBe(0);
    const offline = offlineOperationFrom(attempts);
    expect(offline).toBe(expected('offline_operation'));
    return { offline_operation: offline, attempts, ...core };
  },

  'PAR-MODE-06': async ({ expected, seam, tenant }) => {
    const license = seam('entitlement');
    const holder = await tenant();
    await license.installLicense();
    const unfinished = await startWork(holder);

    await license.lapseMaintenance();

    const check = await license.licenseCheck();
    expect(check).toEqual({ valid: true, outsideContact: false });
    // Work caught by the lapse finishes, new work starts, and someone new can still set up.
    const finished = await finishWork(holder, unfinished.id);
    const newWork = await walkWorkToDone(holder);
    const newOrganization = await walkWorkToDone(await tenant('After Lapse'));
    expect(newOrganization).toEqual(newWork);

    const lapse = maintenanceLapseFrom(check, [finished, newWork, newOrganization]);
    expect(lapse).toBe(expected('maintenance_lapse'));
    return { maintenance_lapse: lapse, licenseValid: check.valid, finished, newWork };
  },

  'PAR-MODE-07': async ({ expected, seam }) => {
    const license = seam('entitlement');
    await license.installLicense();
    const check = await license.licenseCheck();
    const validation = licenseValidationFrom(check);
    expect(validation).toBe(expected('license_validation'));
    return {
      license_validation: validation,
      valid: check.valid,
      outsideContact: check.outsideContact,
    };
  },

  'PAR-MODE-08': async ({ expected, seam }) => {
    const bundles = seam('entitlement');
    // Refusals first, and the intact one after, so a verifier that refuses everything cannot pass.
    const answers = {
      tampered: await bundles.verifyBundle('tampered'),
      unsigned: await bundles.verifyBundle('unsigned'),
      intact: await bundles.verifyBundle('intact'),
    };
    expect(answers).toEqual({ tampered: 'refused', unsigned: 'refused', intact: 'accepted' });
    const updates = updatesFrom(answers);
    expect(updates).toBe(expected('updates'));
    return { updates, ...answers };
  },

  // Last on purpose: the count is over the whole round, and by now every other scenario has run.
  'PAR-MODE-09': async ({ expected, seam, tenant }) => {
    const outbound = seam('outbound');
    const core = await exerciseCoreWork(await tenant());
    const signedOut = await read('/sign-in');
    expect(signedOut.status).toBe(200);
    const attempts = await outbound.attemptsDuringRound();
    expect(attempts).toBe(0);
    const telemetry = vendorTelemetryFrom(attempts);
    expect(telemetry).toBe(expected('vendor_telemetry'));
    return { vendor_telemetry: telemetry, attempts, pagesRead: core.pagesRead };
  },
});
