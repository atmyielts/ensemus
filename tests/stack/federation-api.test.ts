// API-12: cross-organization consent and file delivery through the deployed bridge and proxy.
import { randomUUID } from 'node:crypto';
import { inboundObjectKey, outboundObjectKey } from '@ensemus/domain/federation';
import { S3ObjectStore } from '@ensemus/storage';
import { describe, expect, it } from 'vitest';
import { createWork, workPage } from '../helpers/flows';
import {
  BASE,
  createOrganization,
  read,
  signUp,
  submit,
  visit,
  type Person,
} from '../helpers/forms';
import { enrollAuthenticator } from '../helpers/native-mfa';
import { contractProblems } from '../helpers/openapi';
import { secret } from '../helpers/stack';

const enabled = process.env.ENSEMUS_CROSS_ORG_ENABLED === 'true';

async function call(
  person: Person,
  organization: string,
  method: 'GET' | 'POST' | 'PUT',
  suffix: string,
  options: { json?: unknown; key?: string; version?: number } = {},
) {
  const path = `/api/v1/organizations/${organization}/federation/${suffix}`;
  const response = await fetch(BASE + path, {
    method,
    headers: {
      cookie: person.jar.cookie,
      ...(method === 'GET' ? {} : { origin: BASE }),
      ...(options.json === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.key === undefined ? {} : { 'idempotency-key': options.key }),
      ...(options.version === undefined ? {} : { 'if-match': `"${options.version}"` }),
    },
    ...(options.json === undefined ? {} : { body: JSON.stringify(options.json) }),
  });
  const binary = response.headers.get('content-type') === 'application/octet-stream';
  const text = binary ? undefined : await response.text();
  expect(
    contractProblems({
      method,
      path,
      status: response.status,
      headers: response.headers,
      ...(text === undefined ? {} : { text }),
    }).problems,
    `${method} ${suffix}`,
  ).toEqual([]);
  expect(response.headers.get('cache-control')).toContain('no-store');
  return {
    status: response.status,
    headers: response.headers,
    body: text === undefined ? null : JSON.parse(text),
    bytes: binary ? Buffer.from(await response.arrayBuffer()) : null,
  };
}

describe.runIf(enabled)('deployed cross-organization collaboration (API-12)', () => {
  it('records consent, delivers a file, and removes the shared copies on withdrawal', async () => {
    const sender = await signUp('Generated collaboration sender');
    const receiver = await signUp('Generated collaboration receiver');
    const outsider = await signUp('Generated collaboration outsider');
    const source = await createOrganization(sender, 'Generated sharing workspace');
    const destination = await createOrganization(receiver, 'Generated receiving workspace');
    const other = await createOrganization(outsider, 'Generated unrelated workspace');

    for (const [owner, workspace] of [
      [sender, source],
      [receiver, destination],
    ] as const) {
      await enrollAuthenticator(owner, workspace);
      const before = await call(owner, workspace, 'GET', 'settings');
      expect(before.status).toBe(200);
      expect(before.body).toMatchObject({ enabled: false, version: 0 });
      const configured = await call(owner, workspace, 'PUT', 'settings', {
        json: { enabled: true, expected_version: before.body.version },
      });
      expect(configured.status).toBe(200);
      expect(configured.body).toMatchObject({ available: true, enabled: true, version: 1 });
    }
    expect((await call(outsider, source, 'GET', 'settings')).status).toBe(404);

    const offer = {
      key: randomUUID(),
      json: {
        purpose: 'document_review',
        max_classification: 'internal',
        expires_in_days: 2,
        invitation_expires_in_days: 1,
      },
    };
    const proposed = await call(sender, source, 'POST', 'grants', offer);
    expect(proposed.status).toBe(201);
    expect(proposed.body.grant.status).toBe('proposed');
    expect((await call(sender, source, 'POST', 'grants', offer)).body.code).toBe(
      'FEDERATION_INVITATION_ALREADY_ISSUED',
    );

    const token = proposed.body.token;
    const grantId = proposed.body.grant.id;
    const grantPath = `grants/${grantId}`;
    expect((await call(outsider, other, 'GET', grantPath)).status).toBe(404);
    const preview = await call(receiver, destination, 'POST', 'invitations/preview', {
      json: { token },
    });
    expect(preview.status).toBe(200);
    expect(preview.body.terms_hash).toBe(proposed.body.grant.terms_hash);
    const accepted = await call(receiver, destination, 'POST', 'invitations/acceptance', {
      key: randomUUID(),
      json: { token, terms_hash: preview.body.terms_hash },
    });
    expect(accepted.status).toBe(201);
    expect(accepted.body).toMatchObject({ status: 'accepted', role: 'receiving' });
    const confirmation = await call(sender, source, 'POST', `${grantPath}/confirmation`, {
      json: { terms_hash: preview.body.terms_hash, expected_version: accepted.body.version },
    });
    expect(confirmation.status).toBe(200);
    const active = confirmation.body;
    expect(active).toMatchObject({ id: grantId, status: 'active', role: 'sharing' });
    expect((await call(sender, source, 'GET', grantPath)).body).toEqual(active);
    expect((await call(receiver, destination, 'GET', 'grants')).body.items).toContainEqual(
      expect.objectContaining({ id: grantId, role: 'receiving', status: 'active' }),
    );

    const work = await createWork(sender, source, { title: 'Generated review source' });
    const page = workPage(source, work);
    const bytes = Buffer.from('Generated content for the collaboration release check.\n');
    const file = new File([new Uint8Array(bytes)], 'federation-proof.txt', { type: 'text/plain' });
    const attachment = await submit(page, sender.jar, /name="file"/, { file });
    expect(attachment.status).toBe(303);
    const { html } = await read(page, sender.jar);
    const artifactId = /\/files\/([0-9a-f-]{36})">federation-proof\.txt</.exec(html)?.[1];
    if (!artifactId) throw new Error('Generated source file is missing from the Work unit');

    const outbound = await call(sender, source, 'POST', `${grantPath}/items`, {
      key: randomUUID(),
      json: { kind: 'artifact', artifact_id: artifactId, title: file.name },
    });
    expect(outbound.status).toBe(201);
    expect(outbound.body).toMatchObject({ kind: 'artifact', state: 'queued', has_file: true });
    const id = outbound.body.id;
    const item = `inbound-items/${id}`;
    await expect
      .poll(async () => (await call(receiver, destination, 'GET', item)).status, {
        timeout: 45_000,
        interval: 600,
      })
      .toBe(200);

    const inbox = await call(receiver, destination, 'GET', 'inbound-items');
    expect(inbox.status).toBe(200);
    expect(inbox.body.items).toContainEqual(
      expect.objectContaining({ id, title: file.name, disposition: 'pending' }),
    );
    const received = await call(receiver, destination, 'GET', item);
    expect(received.status).toBe(200);
    expect(received.body).toMatchObject({ id, has_file: true, file_size_bytes: bytes.byteLength });
    expect((await call(outsider, other, 'GET', `${item}/file`)).status).toBe(404);

    const download = await call(receiver, destination, 'GET', `${item}/file`);
    expect(download.status).toBe(200);
    expect(download.bytes).toEqual(bytes);
    expect(download.headers.get('content-length')).toBe(String(bytes.byteLength));
    expect(download.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(download.headers.get('x-content-type-options')).toBe('nosniff');
    const decision = await call(receiver, destination, 'POST', `${item}/disposition`, {
      json: { disposition: 'accepted', expected_version: received.body.version },
    });
    expect(decision.status).toBe(200);
    expect(decision.body.disposition).toBe('accepted');
    const crossings = await call(receiver, destination, 'GET', 'crossings');
    expect(crossings.status).toBe(200);
    expect(crossings.body.items).toContainEqual(
      expect.objectContaining({ item_id: id, outcome: 'delivered' }),
    );

    const sent = await call(sender, source, 'GET', `${grantPath}/items`);
    expect(sent.status).toBe(200);
    const delivered = sent.body.items.find((row: { id: string }) => row.id === id);
    expect(delivered).toMatchObject({ state: 'delivered' });
    const withdrawn = await call(sender, source, 'POST', `outbound-items/${id}/withdrawal`, {
      version: delivered.version,
    });
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.state).toBe('withdrawn');
    expect((await call(receiver, destination, 'GET', `${item}/file`)).status).toBe(404);
    const ended = await call(sender, source, 'POST', `${grantPath}/ending`, {
      json: { reason: 'revoked', expected_version: active.version },
    });
    expect(ended.status).toBe(200);
    expect(ended.body).toMatchObject({ status: 'ended', end_reason: 'revoked' });

    const store = new S3ObjectStore({
      endpoint: `http://127.0.0.1:${process.env.ENSEMUS_TEST_OBJECTS_PORT ?? '58333'}`,
      bucket: 'ensemus',
      accessKey: secret('objects_access_key'),
      secretKey: secret('objects_secret_key'),
    });
    try {
      await expect
        .poll(
          () =>
            Promise.all([
              store.isPhysicallyAbsent(inboundObjectKey(destination, id)),
              store.isPhysicallyAbsent(outboundObjectKey(source, id)),
            ]),
          { timeout: 45_000, interval: 600 },
        )
        .toEqual([true, true]);
    } finally {
      store.close();
    }
    const original = await visit(`${page}/files/${artifactId}`, sender.jar);
    expect(original.status).toBe(200);
    expect(Buffer.from(await original.arrayBuffer())).toEqual(bytes);
  }, 120_000);
});
