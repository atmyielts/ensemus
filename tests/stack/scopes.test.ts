// WORK-03, UX-15, NEXT-01: who may do what, as a person meets it on the page and as a forged form
// tries it anyway, and the record a refusal leaves. Against built images, with JavaScript off.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createWork,
  locationOf,
  mainOf,
  membershipOf,
  move,
  sectionOf,
  statusOn,
  toStatus,
  workPage,
} from '../helpers/flows';
import {
  createOrganization,
  type Form,
  formOn,
  join,
  type Person,
  post,
  read,
  signUp,
  submit,
} from '../helpers/forms';
import { urls } from '../helpers/stack';

describe('who may do what', () => {
  let su: pg.Client;
  let appRole: pg.Client;
  let owner: Person;
  let member: Person;
  let delegate: Person;
  let rival: Person;
  let org: string;
  let rivalOrg: string;

  const people = (organization = org) => `/o/${organization}/people`;

  beforeAll(async () => {
    su = new pg.Client({ connectionString: urls.superuser() });
    await su.connect();
    appRole = new pg.Client({ connectionString: urls.app() });
    await appRole.connect();
    owner = await signUp('Olive Owner');
    org = await createOrganization(owner, `Scopes ${randomUUID()}`);
    member = await join(owner, org, 'Milo Member');
    delegate = await join(owner, org, 'Dana Delegate');
    rival = await signUp('Rita Rival');
    rivalOrg = await createOrganization(rival, `Rival ${randomUUID()}`);
  });

  afterAll(async () => {
    await su?.end();
    await appRole?.end();
  });

  describe('someone assigned to work (WORK-03)', () => {
    /** Work Olive owns, with Dana assigned to it. */
    async function assigned() {
      const id = await createWork(owner, org, { title: `Delegated ${randomUUID()}` });
      const page = workPage(org, id);
      const added = await submit(page, owner.jar, /Add someone/, {
        membershipId: await membershipOf(su, delegate, org),
      });
      expect(locationOf(added)).toBe(page);
      return { id, page };
    }

    const ownerOf = async (id: string) => {
      const { rows } = await su.query(
        'select owner_membership_id as id from work.work_units where id = $1',
        [id],
      );
      return rows[0].id as string;
    };

    it('is offered the work and the next step, and not what belongs to the owner', async () => {
      const { page } = await assigned();
      const { html } = await read(page, delegate.jar);
      const main = mainOf(html);
      expect(main).toContain('Mark ready');
      expect(main).toContain('Edit the details');
      expect(main).toContain('You are on this work, so you can work on it and move it along.');
      expect(main).not.toContain('Change owner');
      expect(main).not.toContain('Add someone');
      expect(main).not.toContain('Stop this work');
      expect(main).toContain('Take yourself off this work');
    });

    it('offers all of it to the owner', async () => {
      const { page } = await assigned();
      const main = mainOf((await read(page, owner.jar)).html);
      expect(main).toContain('Change owner');
      expect(main).toContain('Add someone');
      expect(main).toContain('Stop this work');
      expect(main).toContain(`Remove ${delegate.name} from this work`);
      expect(main).not.toContain('You are on this work, so');
    });

    it('moves it along through its page', async () => {
      const { id, page } = await assigned();
      await move(delegate, org, id, 'ready', 'running');
      expect(statusOn((await read(page, owner.jar)).html)).toBe('In progress');
    });

    it('cannot change the owner, even with the owner’s own form', async () => {
      const { id, page } = await assigned();
      const before = await ownerOf(id);
      const form = await formOn(page, owner.jar, /Change owner/);
      const forged = await post(page, delegate.jar, form, {
        membershipId: await membershipOf(su, delegate, org),
      });
      expect(locationOf(forged)).toBe(`${page}?error=FORBIDDEN`);
      expect(await ownerOf(id)).toBe(before);
      expect((await read(locationOf(forged), delegate.jar)).html).toContain(
        'You do not have permission to do that.',
      );
    });

    it('cannot add or remove anyone else, even with the owner’s own form', async () => {
      const { id, page } = await assigned();
      const add = await formOn(page, owner.jar, /Add someone/);
      const remove = await formOn(page, owner.jar, (f) =>
        f.html.includes(`Remove ${delegate.name} from this work`),
      );
      const assignments = async () => {
        const { rows } = await su.query(
          'select count(*)::int as n from work.work_assignments where work_unit_id = $1',
          [id],
        );
        return rows[0].n as number;
      };
      const before = await assignments();
      const added = await post(page, delegate.jar, add, {
        membershipId: await membershipOf(su, member, org),
      });
      expect(locationOf(added)).toBe(`${page}?error=FORBIDDEN`);
      // Olive is on the work too, because she made it. Dana cannot take her off it.
      const removed = await post(page, delegate.jar, remove, {
        membershipId: await membershipOf(su, owner, org),
      });
      expect(locationOf(removed)).toBe(`${page}?error=FORBIDDEN`);
      expect(await assignments()).toBe(before);
    });

    it('cannot stop it, even with the owner’s own form', async () => {
      const { id, page } = await assigned();
      const form = await formOn(page, owner.jar, toStatus('cancelled'));
      const forged = await post(page, delegate.jar, form, {
        confirm: 'yes',
        reason: 'Trying to stop it',
      });
      expect(locationOf(forged)).toBe(`${page}?error=FORBIDDEN`);
      const { rows } = await su.query('select status from work.work_units where id = $1', [id]);
      expect(rows).toEqual([{ status: 'queued' }]);
    });

    it('can take themselves off', async () => {
      const { page } = await assigned();
      const leaving = await submit(page, delegate.jar, /Take yourself off this work/);
      expect(locationOf(leaving)).toBe(page);
      expect(mainOf((await read(page, owner.jar)).html)).not.toContain(
        `Remove ${delegate.name} from this work`,
      );
    });

    it('leaves it to an admin, and refuses someone in another tenant outright', async () => {
      const { id, page } = await assigned();
      const admin = await join(owner, org, 'Ada Admin');
      await su.query(`update org.memberships set role = 'admin' where id = $1`, [
        await membershipOf(su, admin, org),
      ]);
      expect(mainOf((await read(page, admin.jar)).html)).toContain('Stop this work');

      const form = await formOn(page, owner.jar, /Change owner/);
      const before = await ownerOf(id);
      const outsider = await post(page, rival.jar, form, {
        membershipId: await membershipOf(su, rival, rivalOrg),
      });
      expect(outsider.status).toBe(404);
      expect(await ownerOf(id)).toBe(before);
    });
  });

  describe('the directory (UX-15)', () => {
    it('shows a member names and roles, and no one else’s address anywhere in the page', async () => {
      const { status, html } = await read(people(), member.jar);
      expect(status).toBe(200);
      const directory = sectionOf(html, 'members-heading');
      expect(directory).toContain(owner.name);
      expect(directory).toContain(delegate.name);
      expect(directory).toContain('>Owner<');
      expect(directory).toContain('>Member<');
      expect(directory).toContain('Email addresses are only shown to owners and admins.');
      expect(directory).not.toContain('>Email<');
      for (const other of [owner, delegate]) expect(html).not.toContain(other.email);
    });

    it('shows no one else’s address in the choices on a Work Unit either', async () => {
      const id = await createWork(member, org, { title: `Mine ${randomUUID()}` });
      const { html } = await read(workPage(org, id), member.jar);
      expect(html).toContain(`>${delegate.name}</option>`);
      for (const other of [owner, delegate]) expect(html).not.toContain(other.email);
    });

    it('shows an owner every address, under each name', async () => {
      const { html } = await read(people(), owner.jar);
      const directory = sectionOf(html, 'members-heading');
      expect(directory).not.toContain('Email addresses are only shown to owners and admins.');
      for (const person of [owner, member, delegate]) expect(directory).toContain(person.email);
    });

    it('shows nobody from another tenant', async () => {
      const { html } = await read(people(), owner.jar);
      expect(html).not.toContain(rival.email);
      expect(html).not.toContain(rival.name);
    });
  });

  describe('nested teams (UX-15)', () => {
    const teamId = async (name: string) => {
      const { rows } = await su.query('select id from org.teams where name = $1', [name]);
      if (!rows[0]) throw new Error('No team');
      return rows[0].id as string;
    };
    const parentOf = async (name: string) => {
      const { rows } = await su.query('select parent_id from org.teams where name = $1', [name]);
      return rows[0].parent_id as string | null;
    };
    const moving = (name: string) => (form: Form) =>
      form.html.includes(`aria-label="Move ${name}"`);

    /** A team with a team inside it and another inside that, made through the page. */
    async function nested() {
      const suffix = randomUUID();
      const [top, middle, bottom] = [`Top ${suffix}`, `Middle ${suffix}`, `Bottom ${suffix}`];
      await submit(people(), owner.jar, /Create team/, { name: top });
      await submit(people(), owner.jar, /Create team/, {
        name: middle,
        parentId: await teamId(top),
      });
      await submit(people(), owner.jar, /Create team/, {
        name: bottom,
        parentId: await teamId(middle),
      });
      return { top, middle, bottom };
    }

    it('shows a team inside its parent', async () => {
      const { top, middle, bottom } = await nested();
      const list = sectionOf((await read(people(), member.jar)).html, 'teams-heading');
      const at = (name: string) => list.indexOf(`<strong>${name}</strong>`);
      expect(at(top)).toBeGreaterThan(-1);
      expect(at(middle)).toBeGreaterThan(at(top));
      expect(at(bottom)).toBeGreaterThan(at(middle));
      // Each one opens inside the one above: its list has not closed by the time it starts.
      const between = list.slice(at(top), at(middle));
      expect(between.split('<ul').length - between.split('</ul>').length).toBe(1);
    });

    it('moves a team somewhere else through the page, and back to the top', async () => {
      const { top, middle, bottom } = await nested();
      const moved = await submit(people(), owner.jar, moving(bottom), {
        parentId: await teamId(top),
      });
      expect(locationOf(moved)).toBe(people());
      expect(await parentOf(bottom)).toBe(await teamId(top));
      await submit(people(), owner.jar, moving(middle), { parentId: '' });
      expect(await parentOf(middle)).toBeNull();
    });

    it('does not offer a team’s own teams as its parent', async () => {
      const { top, middle, bottom } = await nested();
      const form = await formOn(people(), owner.jar, moving(top));
      const choices = /<select[\s\S]*<\/select>/.exec(form.html)?.[0] ?? '';
      expect(choices).toContain('No parent team');
      expect(choices).not.toContain(`>${middle}<`);
      expect(choices).not.toContain(`>${bottom}<`);
      expect(choices).not.toContain(`>${top}<`);
    });

    it('refuses a loop from a forged form, and says why in plain words', async () => {
      const { top, bottom } = await nested();
      const form = await formOn(people(), owner.jar, moving(top));
      const refused = await post(people(), owner.jar, form, { parentId: await teamId(bottom) });
      expect(locationOf(refused)).toBe(`${people()}?error=TEAM_CYCLE`);
      expect(await parentOf(top)).toBeNull();
      expect((await read(locationOf(refused), owner.jar)).html).toContain(
        'A team cannot sit inside itself or inside one of its own teams. Choose a different parent.',
      );
    });

    it('is not offered to a member, and is refused from a forged form', async () => {
      const { top, bottom } = await nested();
      const teams = sectionOf((await read(people(), member.jar)).html, 'teams-heading');
      expect(teams).toContain(top);
      expect(teams).not.toContain('Move ');
      const form = await formOn(people(), owner.jar, moving(bottom));
      const refused = await post(people(), member.jar, form, { parentId: await teamId(top) });
      expect(locationOf(refused)).toBe(`${people()}?error=FORBIDDEN`);
      expect(await parentOf(bottom)).not.toBe(await teamId(top));
    });

    it('refuses a parent from another tenant, and an outsider altogether', async () => {
      const { top } = await nested();
      const theirs = `Theirs ${randomUUID()}`;
      await submit(people(rivalOrg), rival.jar, /Create team/, { name: theirs });
      const form = await formOn(people(), owner.jar, moving(top));
      const foreign = await post(people(), owner.jar, form, { parentId: await teamId(theirs) });
      expect(locationOf(foreign)).toBe(`${people()}?error=INVALID_INPUT`);
      expect(await parentOf(top)).toBeNull();
      const outsider = await post(people(), rival.jar, form, { parentId: '' });
      expect(outsider.status).toBe(404);
    });
  });

  describe('refusals leave a record (NEXT-01)', () => {
    type Row = {
      actor_id: string;
      action: string;
      target_ref: string;
      decision: string;
      safe_reason: string;
    };

    const refusals = async (organization: string, actor: string, reason: string) => {
      const { rows } = await su.query<Row>(
        `select actor_id, action, target_ref, decision, safe_reason from governance.audit_events
         where organization_id = $1 and actor_id = $2 and safe_reason = $3
           and action like 'access.refused%'`,
        [organization, actor, reason],
      );
      return rows;
    };

    const userIdOf = async (person: Person) => {
      const { rows } = await su.query('select id from identity.users where email = $1', [
        person.email,
      ]);
      return rows[0].id as string;
    };

    /** What this application role can read, bound to one tenant the way every request is. */
    async function readableFrom(boundTo: string, actor: string) {
      await appRole.query('begin');
      try {
        await appRole.query(`select set_config('app.organization_id', $1, true)`, [boundTo]);
        const { rows } = await appRole.query(
          `select id from governance.audit_events
           where actor_id = $1 and action like 'access.refused%'`,
          [actor],
        );
        return rows.length;
      } finally {
        await appRole.query('rollback');
      }
    }

    it('records a forged tenant once, with nothing from the request, out of others’ reach', async () => {
      const attacker = await join(owner, org, 'Art Attacker');
      const actor = await userIdOf(attacker);
      const canary = `Canary-${randomUUID()}`;
      const page = `/o/${org}/work/new`;
      const form = await formOn(page, attacker.jar, /name="title"/);
      for (let i = 0; i < 6; i += 1) {
        const refused = await post(page, attacker.jar, form, {
          organizationId: rivalOrg,
          title: canary,
          classification: 'internal',
        });
        expect(refused.status).toBe(404);
      }

      expect(await refusals(rivalOrg, actor, 'TENANT_ACCESS_DENIED')).toEqual([
        {
          actor_id: actor,
          action: 'access.refused.web',
          target_ref: `organization:${rivalOrg}`,
          decision: 'deny',
          safe_reason: 'TENANT_ACCESS_DENIED',
        },
      ]);
      const { rows } = await su.query(
        'select * from governance.audit_events where organization_id = $1',
        [rivalOrg],
      );
      expect(JSON.stringify(rows)).not.toContain(canary);

      // The tenant it concerned can read it. Someone in another tenant cannot, even by asking the
      // database for it: not the person who tried, and not anyone else there.
      expect(await readableFrom(rivalOrg, actor)).toBe(1);
      expect(await readableFrom(org, actor)).toBe(0);
    });

    it('records a tenant that was only visited too', async () => {
      const visitor = await join(owner, org, 'Vic Visitor');
      const actor = await userIdOf(visitor);
      expect((await read(`/o/${rivalOrg}`, visitor.jar)).status).toBe(404);
      expect(await refusals(rivalOrg, actor, 'TENANT_ACCESS_DENIED')).toHaveLength(1);
    });

    it('writes nothing for a tenant that does not exist, with the same answer', async () => {
      const missing = randomUUID();
      const page = `/o/${org}/work/new`;
      const form = await formOn(page, member.jar, /name="title"/);
      const refused = await post(page, member.jar, form, {
        organizationId: missing,
        title: 'x',
        classification: 'internal',
      });
      expect(refused.status).toBe(404);
      const { rows } = await su.query(
        'select count(*)::int as n from governance.audit_events where organization_id = $1',
        [missing],
      );
      expect(rows[0].n).toBe(0);
    });

    it('records a forged role, once, under the member’s own tenant', async () => {
      const climber = await join(owner, org, 'Cam Climber');
      const actor = await membershipOf(su, climber, org);
      const form = await formOn(people(), owner.jar, (f) => f.html.includes('Save access for'));
      for (let i = 0; i < 3; i += 1) {
        const refused = await post(people(), climber.jar, form, {
          membershipId: actor,
          role: 'owner',
        });
        expect(locationOf(refused)).toBe(`${people()}?error=FORBIDDEN`);
      }
      const { rows } = await su.query('select role from org.memberships where id = $1', [actor]);
      expect(rows).toEqual([{ role: 'member' }]);
      expect(await refusals(org, actor, 'FORBIDDEN')).toEqual([
        expect.objectContaining({ action: 'access.refused.web', decision: 'deny' }),
      ]);
      expect(await readableFrom(rivalOrg, actor)).toBe(0);
    });

    it('records a forged state', async () => {
      const id = await createWork(owner, org, { title: `State ${randomUUID()}` });
      const page = workPage(org, id);
      const actor = await membershipOf(su, owner, org);
      const form = await formOn(page, owner.jar, toStatus('ready'));
      const refused = await post(page, owner.jar, form, { to: 'completed' });
      expect(locationOf(refused)).toBe(`${page}?error=INVALID_TRANSITION`);
      expect(await refusals(org, actor, 'INVALID_TRANSITION')).toHaveLength(1);
    });

    it('leaves an ordinary mistake unrecorded', async () => {
      const typist = await join(owner, org, 'Tess Typist');
      const actor = await membershipOf(su, typist, org);
      const id = await createWork(typist, org, { title: `Mistake ${randomUUID()}` });
      const page = workPage(org, id);
      const form = await formOn(page, typist.jar, toStatus('ready'));
      await post(page, typist.jar, form, { version: '99' });
      const { rows } = await su.query(
        `select count(*)::int as n from governance.audit_events
         where actor_id = $1 and action like 'access.refused%'`,
        [actor],
      );
      expect(rows[0].n).toBe(0);
    });
  });
});
