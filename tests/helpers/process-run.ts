// Generated real HTTP publication fixture. The auth-only MFA prerequisite is seeded through the
// existing restricted test helper; this does not claim a browser TOTP enrolment or provider qualification.
import { randomUUID } from 'node:crypto';
import { BASE, type Person } from './forms';
import { proveSecondFactor } from './product';
export async function publishGeneratedProcess(person: Person, organization: string) {
  const sessionResponse = await fetch(BASE + '/api/auth/get-session', {
    headers: { cookie: person.jar.cookie },
  });
  const session = (await sessionResponse.json()) as {
    user?: { id?: unknown };
    session?: { id?: unknown };
  };
  if (
    !sessionResponse.ok ||
    typeof session.user?.id !== 'string' ||
    typeof session.session?.id !== 'string'
  )
    throw new Error('TEST_NATIVE_SESSION_REFUSED');
  await proveSecondFactor({ userId: session.user.id, sessionId: session.session.id });
  const base = `/api/v1/organizations/${organization}/studio`;
  async function call(method: string, suffix: string, body: unknown, version?: number) {
    const response = await fetch(BASE + base + suffix, {
      method,
      headers: {
        cookie: person.jar.cookie,
        origin: BASE,
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
        ...(version === undefined ? {} : { 'if-match': String(version) }),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`TEST_PUBLICATION_HTTP_${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  }
  const name = `Generated human workflow ${randomUUID().slice(0, 8)}`,
    draft = await call('POST', '/process-drafts', { name, classification: 'internal' });
  if (typeof draft.id !== 'string' || typeof draft.version !== 'number')
    throw new Error('TEST_DRAFT_REFUSED');
  const saved = await call(
    'PATCH',
    `/process-drafts/${draft.id}`,
    {
      graph: {
        schemaVersion: 1,
        nodes: [
          { id: 'start', kind: 'start', label: 'Start', x: 0, y: 0 },
          { id: 'prepare', kind: 'work_item', label: 'Prepare the generated report', x: 100, y: 0 },
          { id: 'end', kind: 'end', label: 'End', x: 200, y: 0 },
        ],
        edges: [
          { from: 'start', to: 'prepare' },
          { from: 'prepare', to: 'end' },
        ],
      },
    },
    draft.version,
  );
  const simulation = await call('POST', `/process-drafts/${draft.id}/simulations`, {
    scenario_key: 'standard.process',
  });
  if (typeof simulation.id !== 'string') throw new Error('TEST_SIMULATION_REFUSED');
  let passed = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    const response = await fetch(BASE + base + `/simulations/${simulation.id}`, {
        headers: { cookie: person.jar.cookie },
      }),
      row = (await response.json()) as { status?: string; subject_sha256?: string };
    if (!response.ok) throw new Error('TEST_SIMULATION_READ_REFUSED');
    if (row.status === 'passed') {
      if (row.subject_sha256 !== saved.spec_sha256) throw new Error('TEST_SIMULATION_STALE');
      passed = true;
      break;
    }
    if (['failed', 'errored'].includes(row.status ?? ''))
      throw new Error('TEST_SCENARIO_NOT_PASSED');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!passed) throw new Error('TEST_SCENARIO_NOT_FINISHED');
  let review = await call('POST', '/publish-reviews', {
    subject_kind: 'process_draft',
    subject_id: draft.id,
    simulation_run_id: simulation.id,
  });
  if (typeof review.id !== 'string' || typeof review.version !== 'number')
    throw new Error('TEST_REVIEW_REFUSED');
  const reviewId = review.id;
  review = await call(
    'POST',
    `/publish-reviews/${reviewId}/decisions`,
    { decision: 'approved' },
    review.version,
  );
  if (typeof review.version !== 'number') throw new Error('TEST_REVIEW_REFUSED');
  const published = await call(
    'POST',
    `/publish-reviews/${reviewId}/publication`,
    {},
    review.version,
  );
  if (typeof published.published_ref !== 'string') throw new Error('TEST_PUBLICATION_REFUSED');
  return { specId: published.published_ref, name };
}
