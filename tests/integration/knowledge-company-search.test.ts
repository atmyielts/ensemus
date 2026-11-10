import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AppError,
  createClient,
  createProject,
  createTeam,
  createWorkUnit,
} from '@ensemus/application';
import { searchCompany } from '@ensemus/application/knowledge/company-search';
import {
  createOrganization,
  openAppDatabase,
  resolveTenantContext,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { knowledgeCanary, seedMember, seedSearchableSource } from '../helpers/knowledge';
import { urls } from '../helpers/stack';

describe('one company search, with each kind authorized before ranking', () => {
  let database: ReturnType<typeof openAppDatabase>;
  let auth: pg.Client;
  let owner: TenantContext;
  let reader: TenantContext;
  let foreign: TenantContext;
  beforeAll(async () => {
    database = openAppDatabase(urls.app());
    auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
    const createOwner = async () => {
      const userId = randomUUID();
      await auth.query('insert into identity.users (id,name,email) values ($1,$2,$3)', [
        userId,
        'Same owner',
        `${userId}@example.invalid`,
      ]);
      const org = await createOrganization(database.db, {
        userId,
        name: 'Same company',
        commercialMode: 'sovereign',
      });
      return resolveTenantContext(database.db, userId, org.organizationId);
    };
    owner = await createOwner();
    foreign = await createOwner();
    const member = await seedMember(database.db, owner, auth);
    reader = await resolveTenantContext(database.db, member.userId, owner.organizationId);
  });
  afterAll(async () => {
    await auth.end();
    await database.close();
  });

  it('denies service search, and a hidden document never takes a visible result slot', async () => {
    const word = knowledgeCanary();
    await seedSearchableSource(database.db, owner, { title: word, passages: [word], grants: [] });
    const visible = await createClient(database.db, owner, { displayName: word });
    await expect(
      searchCompany(database.db, createServiceContext(owner.organizationId), { query: word }),
    ).rejects.toEqual(new AppError('FORBIDDEN'));
    expect(await searchCompany(database.db, owner, { query: word, limit: 1 })).toEqual([
      {
        kind: 'client',
        id: visible!.id,
        title: word,
        excerpt: null,
        path: `/o/${owner.organizationId}/clients`,
      },
    ]);
  });
  it('uses live work permissions, including an owner having no restricted-work override', async () => {
    const word = knowledgeCanary();
    const hidden = await createWorkUnit(database.db, reader, {
      title: word,
      classification: 'restricted',
    });
    expect(await searchCompany(database.db, owner, { query: word, kinds: ['work_unit'] })).toEqual(
      [],
    );
    expect(
      await searchCompany(database.db, reader, { query: word, kinds: ['work_unit'] }),
    ).toMatchObject([
      { kind: 'work_unit', id: hidden.id, path: `/o/${owner.organizationId}/work/${hidden.id}` },
    ]);
  });
  it('isolates same named clients, projects and teams in two organizations', async () => {
    const word = knowledgeCanary();
    const expected: string[] = [];
    for (const context of [owner, foreign]) {
      const client = await createClient(database.db, context, { displayName: word });
      const project = await createProject(database.db, context, {
        name: word,
        clientId: client!.id,
      });
      const team = await createTeam(database.db, context, { name: word });
      if (context === owner) expected.push(client!.id, project!.id, team!.id);
    }
    const hits = await searchCompany(database.db, reader, { query: word });
    expect(hits.map((hit) => hit.id).sort()).toEqual(expected.sort());
    expect(hits.every((hit) => hit.path.startsWith(`/o/${owner.organizationId}/`))).toBe(true);
    expect(await searchCompany(database.db, reader, { query: word, kinds: [] })).toEqual([]);
  });
  it('returns plain document text and never searches a directory email hidden by the People page', async () => {
    const word = knowledgeCanary();
    const emailWord = knowledgeCanary();
    await auth.query('update identity.users set name=$2,email=$3 where id=$1', [
      owner.userId,
      word,
      `${emailWord}@example.invalid`,
    ]);
    const document = await seedSearchableSource(database.db, owner, {
      title: 'A generated title',
      passages: [`${word} <script>untrusted text</script>`],
      grants: [{ kind: 'organization' }],
    });
    const hits = await searchCompany(database.db, reader, {
      query: word,
      kinds: ['document', 'person'],
    });
    expect(hits.map((hit) => hit.kind).sort()).toEqual(['document', 'person']);
    expect(hits.find((hit) => hit.kind === 'document')).toMatchObject({
      id: document.documentId,
      excerpt: `${word} <script>untrusted text</script>`,
      path: `/o/${owner.organizationId}/knowledge/sources/${document.sourceId}`,
    });
    expect(
      await searchCompany(database.db, reader, { query: emailWord, kinds: ['person'] }),
    ).toEqual([]);
    expect(
      await searchCompany(database.db, reader, {
        query: "'; select * from identity.users; --",
        kinds: ['person'],
      }),
    ).toEqual([]);
  });
  it('filters client class and inherited project class before ranking and the shared limit', async () => {
    const word = knowledgeCanary();
    const confidential = await createClient(database.db, owner, {
      displayName: word,
      classification: 'confidential',
    });
    const restricted = await createClient(database.db, owner, {
      displayName: word,
      classification: 'restricted',
    });
    const project = await createProject(database.db, owner, {
      name: word,
      clientId: confidential!.id,
    });
    expect(
      await searchCompany(database.db, reader, { query: word, kinds: ['client', 'project'] }),
    ).toEqual([]);
    const visible = await searchCompany(database.db, owner, {
      query: word,
      kinds: ['client', 'project'],
    });
    // The actual creator is the named owner of this restricted client. An organization role alone
    // would not grant access; the member above remains unable to discover either private record.
    expect(visible.map((hit) => hit.id).sort()).toEqual(
      [confidential!.id, restricted!.id, project!.id].sort(),
    );
  });
});
