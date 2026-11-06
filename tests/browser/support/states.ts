// Every page and state a person can reach, as data, so accessibility checks and screenshots cover the
// same list. Adding a page means adding one line here.
import type { Page } from '@playwright/test';
import type { Person } from '../../helpers/forms';
import type { World } from './world';

export type PageState = {
  name: string;
  /** Who is looking. Null means signed out. */
  who: (world: World) => Person | null;
  path: (world: World) => string;
  /** Anything to do after the page loads and before it is checked. */
  then?: (page: Page) => Promise<void>;
};

const org = (world: World) => `/o/${world.organization}`;
const quiet = (world: World) => `/o/${world.quietOrganization}`;
const alice = (world: World) => world.alice;
const bob = (world: World) => world.bob;

const work = (key: keyof World['work'], who: PageState['who'] = alice) => ({
  who,
  path: (world: World) => `${org(world)}/work/${world.work[key]}`,
});
const approval = (key: keyof World['approvals'], who: PageState['who'] = bob) => ({
  who,
  path: (world: World) => `${org(world)}/approvals/${world.approvals[key]}`,
});

export const STATES: PageState[] = [
  { name: 'sign-in', who: () => null, path: () => '/sign-in' },
  { name: 'sign-in-refused', who: () => null, path: () => '/sign-in?error=invalid' },
  { name: 'sign-up', who: () => null, path: () => '/sign-up' },
  { name: 'sign-up-refused', who: () => null, path: () => '/sign-up?error=invalid' },
  { name: 'setup-code', who: () => null, path: () => '/setup' },
  { name: 'setup-code-refused', who: () => null, path: () => '/setup?error=code' },

  { name: 'home-no-organization', who: (w) => w.newcomer, path: () => '/' },
  { name: 'home-no-organization-refused', who: (w) => w.newcomer, path: () => '/?error=name' },
  { name: 'home-two-organizations', who: (w) => w.both, path: () => '/' },
  { name: 'home-empty', who: (w) => w.quiet, path: quiet },
  { name: 'home-owner-busy', who: alice, path: org },
  { name: 'home-reviewer', who: bob, path: org },

  { name: 'work-list-empty', who: (w) => w.quiet, path: (w) => `${quiet(w)}/work` },
  { name: 'work-list', who: alice, path: (w) => `${org(w)}/work` },
  {
    name: 'work-list-filter-no-match',
    who: (w) => w.quiet,
    path: (w) => `${quiet(w)}/work?status=failed`,
  },
  { name: 'work-list-bad-cursor', who: alice, path: (w) => `${org(w)}/work?cursor=nonsense` },

  { name: 'work-new', who: alice, path: (w) => `${org(w)}/work/new` },
  { name: 'work-new-no-projects', who: (w) => w.quiet, path: (w) => `${quiet(w)}/work/new` },
  {
    name: 'work-new-refused',
    who: alice,
    path: (w) => `${org(w)}/work/new`,
    then: async (page) => {
      await page.getByLabel('What should be true when this is done?').fill('   ');
      await page.getByRole('button', { name: 'Create work' }).click();
      await page.getByText('It cannot be only spaces.').waitFor();
    },
  },

  { name: 'work-queued-with-dependency', ...work('queued') },
  { name: 'work-ready-plain-review-open', ...work('ready') },
  { name: 'work-ready-with-plan', ...work('plan') },
  { name: 'work-running-with-file', ...work('running') },
  { name: 'work-blocked', ...work('blocked') },
  { name: 'work-paused-owner', ...work('paused') },
  { name: 'work-paused-reviewer', ...work('paused', bob) },
  { name: 'work-verifying', ...work('verifying') },
  { name: 'work-done', ...work('done') },
  { name: 'work-done-with-files', ...work('doneWithFiles') },
  { name: 'work-failed', ...work('failed') },
  { name: 'work-stopped', ...work('stopped') },
  { name: 'work-overdue', ...work('overdue') },
  { name: 'work-long-text', ...work('long') },
  { name: 'work-read-only', ...work('done', (w) => w.carol) },
  {
    name: 'work-refused',
    who: alice,
    path: (w) => `${org(w)}/work/${w.work.queued}?error=PREREQUISITES_INCOMPLETE`,
  },

  { name: 'approvals-empty', who: (w) => w.quiet, path: (w) => `${quiet(w)}/approvals` },
  { name: 'approvals-waiting', who: bob, path: (w) => `${org(w)}/approvals` },
  { name: 'approval-decide-holding-work', ...approval('holding') },
  { name: 'approval-decide-plain-review', ...approval('plain') },
  { name: 'approval-approved', ...approval('approved') },
  { name: 'approval-denied', ...approval('denied') },
  { name: 'approval-expired', ...approval('expired') },
  { name: 'approval-closed', ...approval('closed') },
  { name: 'approval-someone-else-decides', ...approval('holding', alice) },
  { name: 'approval-asked-by-me', ...approval('asked') },

  { name: 'people-owner', who: alice, path: (w) => `${org(w)}/people` },
  { name: 'people-member', who: bob, path: (w) => `${org(w)}/people` },
  { name: 'people-empty', who: (w) => w.quiet, path: (w) => `${quiet(w)}/people` },
  {
    name: 'people-invitation-link-shown',
    who: (w) => w.quiet,
    path: (w) => `${quiet(w)}/people`,
    then: async (page) => {
      await page.getByLabel('Email address').fill('colleague@example.invalid');
      await page.getByRole('button', { name: 'Create invitation' }).click();
      await page.getByLabel('Invitation link').waitFor();
    },
  },

  { name: 'clients-empty', who: (w) => w.quiet, path: (w) => `${quiet(w)}/clients` },
  { name: 'clients-owner', who: alice, path: (w) => `${org(w)}/clients` },
  { name: 'clients-member', who: bob, path: (w) => `${org(w)}/clients` },

  { name: 'inbox-empty', who: (w) => w.quiet, path: (w) => `${quiet(w)}/inbox` },
  { name: 'inbox-with-items', who: bob, path: (w) => `${org(w)}/inbox` },

  {
    name: 'invitation-signed-out',
    who: () => null,
    path: (w) => `/invite/${w.inviteToken}`,
  },
  {
    name: 'invitation-signed-in',
    who: (w) => w.invited,
    path: (w) => `/invite/${w.inviteToken}`,
  },
  {
    name: 'invitation-waiting',
    who: (w) => w.asking,
    path: (w) => `/invite/${w.askingToken}?state=waiting`,
  },
  {
    name: 'invitation-refused',
    who: (w) => w.invited,
    path: (w) => `/invite/${w.inviteToken}?error=INVITATION_INVALID`,
  },

  { name: 'not-found-signed-out', who: () => null, path: () => '/no-such-page' },
  { name: 'not-found-signed-in', who: alice, path: () => '/no-such-page' },
  {
    name: 'not-found-in-organization',
    who: alice,
    path: (w) => `${org(w)}/work/00000000-0000-4000-8000-000000000000`,
  },
];
