// ADR-037 D3: what really leaves the web tier when an operator names a collector. Next.js makes its own
// spans once a provider exists, and they carry the request's URL, and an invitation link has its token
// in its path. So this drives real requests through a built image, and reads what a sink received.
//
// It needs a sink in the Compose overlay, and ENSEMUS_OTEL_ENDPOINT set on web, so without one it skips.
// A default stack has tracing off, and there would be nothing to read.
import { randomBytes, randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  aClientAddress,
  createOrganization,
  fromAddress,
  type Jar,
  PASSWORD,
  type Person,
  read,
  signUp,
  submit,
} from '../helpers/forms';
import {
  addressesIn,
  emailsIn,
  leaksIn,
  readSink,
  type SinkSpan,
  sinkEnd,
  waitForSpans,
} from '../helpers/otlp-sink';

const sinkFile = process.env.ENSEMUS_TEST_OTLP_SINK_FILE;

const NEEDS_SINK =
  'skipped unless ENSEMUS_TEST_OTLP_SINK_FILE names the file the test overlay sink writes, with ENSEMUS_OTEL_ENDPOINT set on web';

const INVITE_ROUTE = '/invite/[token]';
const HOME_ROUTE = '/o/[organizationId]';

const canary = (kind: string) => `CANARY${kind}${randomUUID().replaceAll('-', '')}`;

/** Shaped exactly like a token we issue, so it gets as far as a real one would. */
const aCanaryToken = () => `sk-CANARY-${randomBytes(17).toString('hex').slice(0, 33)}`;

const isRoute = (route: string) => (span: SinkSpan) =>
  span.service === 'web' && span.attributes['next.route'] === route;

describe.skipIf(!sinkFile)(`what the web tier sends a collector (${NEEDS_SINK})`, () => {
  const file = sinkFile as string;
  const token = aCanaryToken();
  const personName = canary('NAME');
  const organizationName = canary('ORGANIZATION');
  const address = aClientAddress();

  let person: Person;
  let organization: string;
  let signedIn: Jar;
  let spans: SinkSpan[];
  let raw: string;

  beforeAll(async () => {
    const from = sinkEnd(file);
    await fromAddress(address, async () => {
      person = await signUp(personName);
      organization = await createOrganization(person, organizationName);

      signedIn = { cookie: '' };
      const response = await submit('/sign-in', signedIn, /name="password"/, {
        email: person.email,
        password: PASSWORD,
      });
      expect(response.status).toBe(303);
      expect(signedIn.cookie).toContain('session_token');

      // Controls: a page that failed to render would have nothing to leak. The server read the
      // organization's name for this page, and put the token in this link.
      const home = await read(`/o/${organization}`, signedIn);
      expect(home.status).toBe(200);
      expect(home.html).toContain(organizationName);
      const anonymous = await read(`/invite/${token}`);
      expect(anonymous.status).toBe(200);
      expect(anonymous.html).toContain(token);
      expect((await read(`/invite/${token}`, signedIn)).status).toBe(200);
    });

    // Waits for the spans of these very requests, so the scans below read something that could leak.
    spans = await waitForSpans(
      file,
      from,
      (arrived) => arrived.some(isRoute(INVITE_ROUTE)) && arrived.some(isRoute(HOME_ROUTE)),
    );
    // The whole file, including earlier runs: what any of them sent would be just as much a leak.
    raw = readSink(file);
  });

  it('receives spans from the web tier, named by the route and not by the path', () => {
    const invite = spans.filter(isRoute(INVITE_ROUTE));
    expect(invite.length).toBeGreaterThan(0);
    for (const span of invite) expect(span.name).not.toContain('/invite/sk-');
    expect(spans.some((span) => span.name === `GET ${INVITE_ROUTE}`)).toBe(true);
    expect(spans.some((span) => span.name === `GET ${HOME_ROUTE}`)).toBe(true);
  });

  it('does not send the token from an invitation link', () => {
    expect(leaksIn(raw, [token, 'sk-CANARY'])).toEqual([]);
  });

  it('does not send a name, an email or the password', () => {
    const [localPart] = person.email.split('@') as [string];
    expect(
      leaksIn(raw, [personName, organizationName, person.email, localPart, PASSWORD]),
    ).toEqual([]);
    expect(emailsIn(raw)).toEqual([]);
    expect(leaksIn(raw, ['example.invalid'])).toEqual([]);
  });

  it('does not send the client address, or any other', () => {
    expect(leaksIn(raw, [address])).toEqual([]);
    expect(addressesIn(spans)).toEqual([]);
  });

  it('does not send a session cookie', () => {
    const values = signedIn.cookie.split('; ').map((cookie) => cookie.split('=')[1] as string);
    expect(values.length).toBeGreaterThan(0);
    expect(leaksIn(raw, [...values.filter(Boolean), 'session_token'])).toEqual([]);
  });

  it('puts no raw ID in a span name, where only the route pattern belongs', () => {
    expect(spans.filter((span) => span.name.includes(organization))).toEqual([]);
  });

  it('keeps none of the attributes a framework adds about the request', () => {
    const keys = new Set(spans.flatMap((span) => Object.keys(span.attributes)));
    for (const key of [
      'http.target',
      'http.url',
      'http.host',
      'http.client_ip',
      'net.host.name',
      'net.peer.ip',
      'url.full',
      'url.path',
      'url.query',
      'client.address',
      'server.address',
      'user_agent.original',
      'error.type',
    ]) {
      expect(keys, key).not.toContain(key);
    }
  });

  it('sends no event, status message or link attribute, where an error message could go', () => {
    expect(spans.filter((span) => span.eventCount > 0)).toEqual([]);
    expect(spans.filter((span) => span.statusMessage !== '')).toEqual([]);
    expect(spans.filter((span) => span.linkAttributeCount > 0)).toEqual([]);
  });
});
