// Explicit loopback test deployment only. This uses the existing no-JS test-form driver, which accepts
// the local test certificate. It is never a production onboarding or credential tool.
import { randomBytes, randomUUID } from 'node:crypto';
import {
  openSync,
  closeSync,
  writeSync,
  fsyncSync,
  ftruncateSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { parseArgs } from 'node:util';
import { profiles, scenarios } from './profiles.mjs';
import { validateProfile } from './harness.mjs';

export function parseSeedCommand(args) {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: Object.fromEntries(
      ['base-url', 'profile', 'profile-file', 'out'].map((key) => [
        key,
        { type: 'string', multiple: true },
      ]),
    ),
  });
  if (Object.values(values).some((value) => value.length !== 1 || !value[0]))
    throw new Error('ARGUMENT_INVALID');
  const input = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value[0]]));
  if (!input['base-url'] || !input.out || !input.profile || !Object.hasOwn(profiles, input.profile))
    throw new Error('EXPLICIT_TARGET_REQUIRED');
  const url = new URL(input['base-url']);
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('LOOPBACK_TEST_TARGET_REQUIRED');
  return { ...input, baseUrl: url.origin };
}
export async function main(args) {
  const input = parseSeedCommand(args);
  if (
    input['profile-file'] &&
    (!statSync(input['profile-file']).isFile() ||
      statSync(input['profile-file']).size > 1024 * 1024)
  )
    throw new Error('PROFILE_FILE_INVALID');
  const profile = validateProfile({
    ...profiles[input.profile],
    ...(input['profile-file'] ? JSON.parse(readFileSync(input['profile-file'], 'utf8')) : {}),
  });
  if (!Object.hasOwn(scenarios, profile.scenario)) throw new Error('PROFILE_INVALID');
  const descriptor = openSync(input.out, 'wx', 0o600),
    fixture = {
      kind: 'ensemus-generated-load-fixture-v1',
      generated: false,
      complete: false,
      tenants: [],
      dataset: { workUnitsCreated: 0, documentsCreated: 0, clientsCreated: 0, projectsCreated: 0 },
      runRef: randomUUID(),
    };
  const persist = () => {
    const text = `${JSON.stringify(fixture, null, 2)}\n`;
    writeSync(descriptor, text, 0, 'utf8');
    ftruncateSync(descriptor, Buffer.byteLength(text));
    fsyncSync(descriptor);
  };
  try {
    // Set an explicit validated origin BEFORE importing the test helper, which otherwise has a test default.
    process.env.ENSEMUS_TEST_BASE = input.baseUrl;
    const { submit, createOrganization, bringIn } = await import('../helpers/forms.ts');
    const signup = async () => {
      const email = `load-${randomUUID()}@example.invalid`,
        person = { name: `Generated load ${randomUUID()}`, email, jar: { cookie: '' } };
      const response = await submit('/sign-up', person.jar, /name="password"/, {
        name: person.name,
        email,
        password: randomBytes(32).toString('base64url'),
      });
      if (response.status !== 303 || !person.jar.cookie.includes('session_token'))
        throw new Error('GENERATED_SIGNUP_REFUSED');
      const session = await fetch(`${input.baseUrl}/api/auth/get-session`, {
        redirect: 'error',
        headers: { cookie: person.jar.cookie },
      });
      if (!session.ok) throw new Error('GENERATED_SESSION_REFUSED');
      const value = await session.json();
      if (typeof value?.user?.id !== 'string') throw new Error('GENERATED_SESSION_INVALID');
      return { person, actor: { userId: value.user.id, email, cookie: person.jar.cookie } };
    };
    persist();
    for (let index = 0; index < profile.tenantCount; index++) {
      const owner = await signup(),
        organizationId = await createOrganization(
          owner.person,
          `Generated load ${fixture.runRef}-${index}`,
        ),
        tenant = { organizationId, actors: [owner.actor] };
      fixture.tenants.push(tenant);
      persist();
      for (let actor = 1; actor < profile.concurrencyPerTenant; actor++) {
        const member = await signup();
        await bringIn(owner.person, organizationId, member.person);
        tenant.actors.push(member.actor);
        persist();
      }
      for (let work = 0; work < profile.workUnits; work++) {
        const response = await fetch(
          `${input.baseUrl}/api/v1/organizations/${organizationId}/work-units`,
          {
            method: 'POST',
            redirect: 'error',
            headers: {
              cookie: owner.actor.cookie,
              origin: input.baseUrl,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              title: `Generated load work ${work}`,
              classification: 'internal',
            }),
          },
        );
        await response.arrayBuffer();
        if (response.status !== 201) throw new Error('GENERATED_WORK_REFUSED');
        fixture.dataset.workUnitsCreated++;
        if (work % 10 === 0) persist();
      }
    }
    fixture.generated = true;
    fixture.complete = true;
    persist();
    return 0;
  } catch {
    // Retain only the private partial fixture so an operator can account for created generated rows.
    fixture.generated = false;
    persist();
    throw new Error('GENERATED_FIXTURE_INCOMPLETE');
  } finally {
    closeSync(descriptor);
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.stderr.write('GENERATED_FIXTURE_REFUSED_OR_FAILED\n');
      process.exitCode = 2;
    });
