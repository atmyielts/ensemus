// ADR-037 D9: a proxy in front that nobody named makes everyone look like one private address. Five people
// from one such address raise a warning in web's output, without the address, and nothing is refused.
// proxy/Caddyfile.test lets a test choose the address with X-Ensemus-Test-Client.
import { beforeAll, describe, expect, it } from 'vitest';
import {
  aClientAddress,
  createOrganization,
  fromAddress,
  PASSWORD,
  type Person,
  read,
  signUp,
  submit,
  visit,
} from '../helpers/forms';
import { compose } from '../helpers/stack';

const SHARED_ADDRESS = '10.1.2.3';
const WARNING = 'proxy.client_addresses_look_shared';
const PEOPLE = 5;
const RESTART_TIMEOUT = 180_000;

const logs = () => compose('logs', '--no-log-prefix', 'web');
const warnings = () =>
  logs()
    .split('\n')
    .filter((line) => line.includes(WARNING));

const fromTheSharedAddress = <T>(work: () => Promise<T>) => fromAddress(SHARED_ADDRESS, work);

describe('many people arriving from one private address', () => {
  const people: { person: Person; organization: string }[] = [];

  /** A new web process, and so a new watch: what other tests did must not decide this one. */
  const restartWeb = () => compose('up', '-d', '--no-deps', '--force-recreate', '--wait', 'web');

  /** Someone seen by a page, through requireTenant. */
  const onAPage = async ({ person, organization }: (typeof people)[number]) =>
    read(`/o/${organization}`, person.jar);

  /** Someone seen by the API, through apiRoute. */
  const throughTheApi = async ({ person, organization }: (typeof people)[number]) =>
    visit(`/api/v1/organizations/${organization}/work-units`, person.jar);

  beforeAll(async () => {
    // Everyone is set up from an address of their own, and before the restart, so that none of this counts.
    for (let index = 0; index < PEOPLE + 1; index += 1) {
      const person = await signUp(`Person ${index}`);
      people.push({ person, organization: await createOrganization(person, `Org ${index}`) });
    }
    restartWeb();
  }, RESTART_TIMEOUT);

  it('says nothing about visitors with no session, however many', async () => {
    await fromTheSharedAddress(async () => {
      for (let visitor = 0; visitor < PEOPLE * 2; visitor += 1) {
        const answer = await visit(`/api/v1/organizations/${people[0]?.organization}/work-units`);
        expect(answer.status).toBe(401);
        const page = await read(`/o/${people[0]?.organization}`);
        expect(page.location).toContain('/sign-in');
      }
    });
    expect(warnings()).toEqual([]);
  });

  it('says nothing about four people, or about one of them coming back', async () => {
    await fromTheSharedAddress(async () => {
      for (const someone of people.slice(0, 3)) {
        expect((await onAPage(someone)).status).toBe(200);
      }
      const fourth = people[3] as (typeof people)[number];
      for (let time = 0; time < 10; time += 1) {
        expect((await throughTheApi(fourth)).status).toBe(200);
      }
    });
    expect(warnings()).toEqual([]);
  });

  it('warns at the fifth person, once, whichever way each of them arrived', async () => {
    const fifth = people[4] as (typeof people)[number];
    const answer = await fromTheSharedAddress(() => throughTheApi(fifth));
    expect(answer.status).toBe(200);

    await expect.poll(() => warnings().length, { timeout: 15_000 }).toBe(1);
    const line = JSON.parse(warnings()[0] as string);
    expect(line).toMatchObject({ level: 'warn', service: 'web', event: WARNING, count: PEOPLE });
    expect(Object.keys(line).sort()).toEqual(['count', 'event', 'level', 'service', 'ts']);
  });

  it('does not repeat itself for a sixth person', async () => {
    const sixth = people[5] as (typeof people)[number];
    expect((await fromTheSharedAddress(() => onAPage(sixth))).status).toBe(200);
    expect(warnings()).toHaveLength(1);
  });

  it('leaves the address and the people out of the whole log', () => {
    const output = logs();
    expect(output).toContain(WARNING);
    expect(output).not.toContain(SHARED_ADDRESS);
    for (const { person } of people) expect(output).not.toContain(person.email);
  });

  it('refuses nothing because of it: sign-in still works from that address', async () => {
    const { person, organization } = people[0] as (typeof people)[number];
    const jar = { cookie: '' };
    const signedIn = await fromTheSharedAddress(() =>
      submit('/sign-in', jar, /name="password"/, { email: person.email, password: PASSWORD }),
    );
    expect(signedIn.status).toBe(303);
    expect(signedIn.headers.get('location')).toBe('/');
    expect(jar.cookie).toContain('session_token');
    expect((await fromTheSharedAddress(() => read(`/o/${organization}`, jar))).status).toBe(200);
  });

  it('still keeps people out of a tenant that is not theirs', async () => {
    const { person } = people[0] as (typeof people)[number];
    const { organization: theirs } = people[1] as (typeof people)[number];
    const asked = await fromTheSharedAddress(() =>
      visit(`/api/v1/organizations/${theirs}/work-units`, person.jar),
    );
    expect(asked.status).toBe(404);
    expect((await fromTheSharedAddress(() => read(`/o/${theirs}`, person.jar))).status).toBe(404);
  });

  it('stays quiet in a fresh window of ordinary people, each from their own address', async () => {
    restartWeb();
    for (const someone of people) {
      const answer = await fromAddress(aClientAddress(), () => onAPage(someone));
      expect(answer.status).toBe(200);
    }
    expect(warnings()).toEqual([]);
  }, RESTART_TIMEOUT);
});
