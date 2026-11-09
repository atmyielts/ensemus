// WORK-04: a file attached to a Work unit, downloaded with a session through the proxy, against built images.
// Next.js 16.4.5 drops a route's Content-Length, so the route declares the length and the proxy restores it
// (apps/web/src/lib/declared-length.ts). A text file is one the app's own compression would gzip, and then
// send with no length at all, so the route also says no-transform. tests/unit/declared-length.test.ts holds
// the source to both rules, and this sees what a client really receives.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createWork, locationOf, workPage } from '../helpers/flows';
import { createOrganization, type Person, read, signUp, submit, visit } from '../helpers/forms';

describe('downloading a Work file through the proxy', () => {
  let owner: Person;
  let org: string;
  let work: string;
  let rival: Person;
  let rivalOrg: string;

  /** Attaches a file through the Work page's own form, and returns the link the page then shows. */
  async function upload(file: File) {
    const page = workPage(org, work);
    const response = await submit(page, owner.jar, /name="file"/, { file });
    expect(response.status).toBe(303);
    expect(locationOf(response)).toBe(page);
    const { html } = await read(page, owner.jar);
    const name = file.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const link = new RegExp(`href="([^"]+/files/[0-9a-f-]{36})">${name}<`).exec(html)?.[1];
    if (!link) throw new Error(`No link to ${file.name}`);
    return link;
  }

  /** What every answer from this route says, a download or not. */
  function expectGuarded(response: Response) {
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('private, no-store, no-transform');
    // The declared length is the proxy's to read, and never reaches a client.
    expect(response.headers.get('x-ensemus-body-length')).toBeNull();
  }

  beforeAll(async () => {
    owner = await signUp('Fern Filer');
    org = await createOrganization(owner, `Work files ${randomUUID()}`);
    work = await createWork(owner, org, { title: `Download ${randomUUID()}` });
    rival = await signUp('Rory Rival');
    rivalOrg = await createOrganization(rival, `Work files ${randomUUID()}`);
  });

  it.each([
    // Well past compression's threshold, and as compressible as text gets.
    ['notes.txt', 'text/plain', Buffer.from('The same line, again and again.\n'.repeat(256))],
    ['ledger.csv', 'text/csv', Buffer.from('id,amount\n'.concat('1,100\n'.repeat(512)))],
    // Bytes that are not UTF-8, so only the bytes themselves can be measured.
    ['report.bin', 'application/octet-stream', Buffer.from([0, 255, 1, 254, 0x0d, 0x0a, 0x80, 7])],
  ])(
    'sends %s whole, with its exact length and the headers that keep it inert',
    async (name, type, bytes) => {
      const link = await upload(new File([bytes], name, { type }));
      const download = await visit(link, owner.jar);
      expect(download.status).toBe(200);
      expectGuarded(download);
      expect(download.headers.get('content-type')).toBe(type);
      expect(download.headers.get('content-encoding')).toBeNull();
      expect(download.headers.get('content-length')).toBe(String(bytes.length));
      expect(download.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
      expect(download.headers.get('content-disposition')).toMatch(/^attachment; /);
      expect(Buffer.from(await download.arrayBuffer()).equals(bytes)).toBe(true);
    },
  );

  it('states no length, and gives nothing away, to anyone it is not for', async () => {
    const bytes = Buffer.from('Only for this organization.\n'.repeat(64));
    const link = await upload(new File([bytes], 'private.txt', { type: 'text/plain' }));
    const fileId = link.slice(link.lastIndexOf('/') + 1);

    // Answered by the route itself: the same file asked for under the rival's own organization, and a
    // file that does not exist, for someone who can see the Work unit.
    for (const refused of [
      await visit(`${workPage(rivalOrg, work)}/files/${fileId}`, rival.jar),
      await visit(`${workPage(org, work)}/files/${randomUUID()}`, owner.jar),
    ]) {
      expect(refused.status).toBe(404);
      expectGuarded(refused);
      expect(Buffer.from(await refused.arrayBuffer()).includes(bytes)).toBe(false);
    }

    // Answered before the route reads anything: someone from another organization at this one's path,
    // who is told it is not there, and someone not signed in, who is sent to sign in.
    const foreign = await visit(link, rival.jar);
    expect(foreign.status).toBe(404);
    const anonymous = await visit(link);
    expect(anonymous.status).not.toBe(200);
    for (const refused of [foreign, anonymous]) {
      expect(refused.headers.get('x-ensemus-body-length')).toBeNull();
      expect(Buffer.from(await refused.arrayBuffer()).includes(bytes)).toBe(false);
    }
  });
});
