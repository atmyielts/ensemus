// Every page and state a person can reach, as data, so accessibility checks and screenshots cover the
// same list. Adding a page means adding one line here, with what shows that this state was reached.
import type { Locator, Page } from '@playwright/test';
import type { Person } from '../../helpers/forms';
import type { World } from './world';

export type PageState = {
  name: string;
  /** Who is looking. Null means signed out. */
  who: (world: World) => Person | null;
  path: (world: World) => string;
  /** What the page must answer. 200 unless it says otherwise. */
  status?: number;
  /** Anything to do after the page loads and before it is checked. */
  then?: (page: Page) => Promise<void>;
  /** What must be visible for this to be this state, and not an error page or a redirect. */
  shows: (page: Page) => Locator[];
};

const org = (world: World) => `/o/${world.organization}`;
const quiet = (world: World) => `/o/${world.quietOrganization}`;
const alice = (world: World) => world.alice;
const bob = (world: World) => world.bob;

const heading = (name: string | RegExp) => (page: Page) => [page.getByRole('heading', { name })];
const says =
  (...texts: string[]) =>
  (page: Page) =>
    texts.map((text) => page.getByText(text));
const headed =
  (name: string | RegExp, ...texts: string[]) =>
  (page: Page) => [page.getByRole('heading', { name }), ...says(...texts)(page)];

/** The title of a piece of work, the status the page gives it, and anything else it must show. */
const workShows =
  (title: string | RegExp, status: string, ...texts: string[]) =>
  (page: Page) => [
    page.getByRole('heading', { name: title }),
    page.locator('dt:text-is("Status") + dd .badge').filter({ hasText: status }),
    ...says(...texts)(page),
  ];

const work = (key: keyof World['work'], who: PageState['who'] = alice) => ({
  who,
  path: (world: World) => `${org(world)}/work/${world.work[key]}`,
});
const approval = (key: keyof World['approvals'], who: PageState['who'] = bob) => ({
  who,
  path: (world: World) => `${org(world)}/approvals/${world.approvals[key]}`,
});

export const STATES: PageState[] = [
  {
    name: 'knowledge-sources',
    who: alice,
    path: (world) => `${org(world)}/knowledge`,
    shows: heading('Company knowledge'),
  },
  {
    name: 'knowledge-new-source',
    who: alice,
    path: (world) => `${org(world)}/knowledge/new`,
    shows: heading('Add a source'),
  },
  {
    name: 'knowledge-passage-search',
    who: alice,
    path: (world) => `${org(world)}/knowledge/search`,
    shows: heading('Find a source passage'),
  },
  {
    name: 'knowledge-question',
    who: alice,
    path: (world) => `${org(world)}/knowledge/ask`,
    shows: heading('Ask company knowledge'),
  },
  {
    name: 'knowledge-my-answers',
    who: alice,
    path: (world) => `${org(world)}/knowledge/answers`,
    shows: heading('My answers'),
  },
  {
    name: 'knowledge-facts',
    who: alice,
    path: (world) => `${org(world)}/knowledge/facts`,
    shows: heading('Company facts'),
  },
  {
    name: 'knowledge-related-records',
    who: alice,
    path: (world) => `${org(world)}/knowledge/graph`,
    shows: heading('Related records'),
  },
  {
    name: 'company-search',
    who: alice,
    path: (world) => `${org(world)}/search`,
    shows: heading('Search the company'),
  },
  {
    name: 'model-data-sharing',
    who: alice,
    path: (world) => `${org(world)}/settings/egress`,
    shows: heading('Model data sharing'),
  },
  {
    name: 'client-onboarding-start',
    who: alice,
    path: (world) => `${org(world)}/onboarding`,
    shows: heading('Start client onboarding'),
  },
  {
    name: 'sign-in',
    who: () => null,
    path: () => '/sign-in',
    shows: heading('Sign in to Ensemus'),
  },
  {
    name: 'sign-in-refused',
    who: () => null,
    path: () => '/sign-in?error=invalid',
    shows: headed('Sign in to Ensemus', 'That email and password did not match.'),
  },
  {
    name: 'sign-up',
    who: () => null,
    path: () => '/sign-up',
    shows: heading('Create your account'),
  },
  {
    name: 'sign-up-refused',
    who: () => null,
    path: () => '/sign-up?error=invalid',
    shows: headed('Create your account', 'We could not create that account.'),
  },
  {
    name: 'setup-code',
    who: () => null,
    path: () => '/setup',
    shows: heading('Set up your account'),
  },
  {
    name: 'setup-code-refused',
    who: () => null,
    path: () => '/setup?error=code',
    shows: headed('Set up your account', 'That setup code does not work.'),
  },

  {
    name: 'home-no-organization',
    who: (w) => w.newcomer,
    path: () => '/',
    shows: heading('Set up your organization'),
  },
  {
    name: 'home-no-organization-refused',
    who: (w) => w.newcomer,
    path: () => '/?error=name',
    shows: headed('Set up your organization', 'Enter a name of up to 120 characters.'),
  },
  {
    name: 'home-two-organizations',
    who: (w) => w.both,
    path: () => '/',
    shows: headed('Your organizations', 'Northwind Studio', 'Ito & Sons'),
  },
  {
    name: 'home-empty',
    who: (w) => w.quiet,
    path: quiet,
    shows: headed('Hello, Quinn', 'You are not on any open work.'),
  },
  {
    name: 'home-owner-busy',
    who: alice,
    path: org,
    shows: (page) => [...heading('Hello, Alice')(page), ...heading('Needs attention')(page)],
  },
  {
    name: 'home-reviewer',
    who: bob,
    path: org,
    shows: (page) => [
      ...heading('Hello, Bob')(page),
      ...heading('Waiting for your approval')(page),
    ],
  },

  {
    name: 'work-list-empty',
    who: (w) => w.quiet,
    path: (w) => `${quiet(w)}/work`,
    shows: headed('Work', 'No work yet.'),
  },
  {
    name: 'work-list',
    who: alice,
    path: (w) => `${org(w)}/work`,
    shows: headed('Work', 'Redesign the pricing page'),
  },
  {
    name: 'work-list-filter-no-match',
    who: (w) => w.quiet,
    path: (w) => `${quiet(w)}/work?status=failed`,
    shows: headed('Work', 'No work matches this filter.'),
  },
  {
    name: 'work-list-bad-cursor',
    who: alice,
    path: (w) => `${org(w)}/work?cursor=nonsense`,
    shows: headed('Work', 'Please check the details and try again.', 'Redesign the pricing page'),
  },

  {
    name: 'work-new',
    who: alice,
    path: (w) => `${org(w)}/work/new`,
    shows: (page) => [...heading('New work')(page), page.getByLabel('Project')],
  },
  {
    name: 'work-new-no-projects',
    who: (w) => w.quiet,
    path: (w) => `${quiet(w)}/work/new`,
    shows: heading('New work'),
  },
  {
    name: 'work-new-refused',
    who: alice,
    path: (w) => `${org(w)}/work/new`,
    then: async (page) => {
      await page.getByLabel('What should be true when this is done?').fill('   ');
      await page.getByRole('button', { name: 'Create work' }).click();
      await page.getByText('It cannot be only spaces.').waitFor();
    },
    shows: headed('New work', 'It cannot be only spaces.'),
  },

  {
    name: 'work-queued-with-dependency',
    ...work('queued'),
    shows: workShows(
      'Write the onboarding guide for new clients',
      'Waiting to start',
      'Agree the brand palette with the client',
    ),
  },
  {
    name: 'work-ready-plain-review-open',
    ...work('ready'),
    shows: workShows('Book the photographer for the spring shoot', 'Ready'),
  },
  {
    name: 'work-ready-with-plan',
    ...work('plan'),
    shows: workShows('Prepare the quarterly report pack', 'Ready'),
  },
  {
    name: 'work-running-with-file',
    ...work('running'),
    shows: workShows('Redesign the pricing page', 'In progress', 'pricing-page-draft-v2.txt'),
  },
  {
    name: 'work-blocked',
    ...work('blocked'),
    shows: workShows('Migrate the client newsletter list', 'Blocked'),
  },
  {
    name: 'work-paused-owner',
    ...work('paused'),
    shows: workShows('Sign off the Meridian Health proposal', 'Waiting for approval'),
  },
  {
    name: 'work-paused-reviewer',
    ...work('paused', bob),
    shows: workShows('Sign off the Meridian Health proposal', 'Waiting for approval'),
  },
  {
    name: 'work-verifying',
    ...work('verifying'),
    shows: workShows('Check the invoices for October', 'Checking'),
  },
  {
    name: 'work-done',
    ...work('done'),
    shows: workShows('Publish the autumn newsletter', 'Done'),
  },
  {
    name: 'work-done-with-files',
    ...work('doneWithFiles'),
    shows: workShows('Deliver the brand guidelines', 'Done', 'brand-guidelines.txt'),
  },
  {
    name: 'work-failed',
    ...work('failed'),
    shows: workShows('Import last year’s time sheets', 'Failed'),
  },
  {
    name: 'work-stopped',
    ...work('stopped'),
    shows: workShows('Plan the summer offsite', 'Stopped'),
  },
  {
    name: 'work-overdue',
    ...work('overdue'),
    shows: (page) => [
      ...workShows('Renew the design software licences', 'Waiting to start')(page),
      page.locator('.badge').filter({ hasText: 'Overdue' }),
    ],
  },
  {
    name: 'work-long-text',
    ...work('long'),
    shows: workShows(/A title long enough to wrap/, 'Waiting to start'),
  },
  {
    name: 'work-read-only',
    ...work('done', (w) => w.carol),
    shows: workShows('Publish the autumn newsletter', 'Done'),
  },
  {
    name: 'work-refused',
    who: alice,
    path: (w) => `${org(w)}/work/${w.work.queued}?error=PREREQUISITES_INCOMPLETE`,
    shows: workShows(
      'Write the onboarding guide for new clients',
      'Waiting to start',
      'This work is waiting on prerequisites that are not done.',
    ),
  },

  {
    name: 'approvals-empty',
    who: (w) => w.quiet,
    path: (w) => `${quiet(w)}/approvals`,
    shows: headed('Approvals', 'No approvals are waiting for you.'),
  },
  {
    name: 'approvals-waiting',
    who: bob,
    path: (w) => `${org(w)}/approvals`,
    shows: headed('Approvals', 'Sign off the Meridian Health proposal'),
  },
  {
    name: 'approval-decide-holding-work',
    ...approval('holding'),
    shows: headed('Your decision is needed', 'This work is paused until you decide.'),
  },
  {
    name: 'approval-decide-plain-review',
    ...approval('plain'),
    shows: headed('Your decision is needed', 'it does not start or stop anything'),
  },
  {
    name: 'approval-approved',
    ...approval('approved'),
    shows: headed('Approval', 'Approved by Bob Okafor'),
  },
  {
    name: 'approval-denied',
    ...approval('denied'),
    shows: headed('Approval', 'Denied by Bob Okafor'),
  },
  {
    name: 'approval-expired',
    ...approval('expired'),
    shows: headed('Approval', 'The time to decide has passed'),
  },
  {
    name: 'approval-closed',
    ...approval('closed'),
    shows: headed('Approval', 'This was closed without a decision'),
  },
  {
    name: 'approval-someone-else-decides',
    ...approval('holding', alice),
    shows: headed('Approval', 'Bob Okafor decides this one.'),
  },
  {
    name: 'approval-asked-by-me',
    ...approval('asked'),
    shows: headed('Approval', 'Carol Reyes decides this one.'),
  },

  {
    name: 'people-owner',
    who: alice,
    path: (w) => `${org(w)}/people`,
    shows: (page) => [...heading('People and teams')(page), ...heading('Invite someone')(page)],
  },
  {
    name: 'people-member',
    who: bob,
    path: (w) => `${org(w)}/people`,
    shows: headed('People and teams', 'Email addresses are only shown to owners and admins.'),
  },
  {
    name: 'people-empty',
    who: (w) => w.quiet,
    path: (w) => `${quiet(w)}/people`,
    shows: headed('People and teams', 'No teams yet.'),
  },
  {
    name: 'people-invitation-link-shown',
    who: (w) => w.quiet,
    path: (w) => `${quiet(w)}/people`,
    then: async (page) => {
      await page.getByLabel('Email address').fill('colleague@example.invalid');
      await page.getByRole('button', { name: 'Create invitation' }).click();
      await page.getByLabel('Invitation link').waitFor();
    },
    shows: (page) => [...heading('People and teams')(page), page.getByLabel('Invitation link')],
  },

  {
    name: 'clients-empty',
    who: (w) => w.quiet,
    path: (w) => `${quiet(w)}/clients`,
    shows: headed('Clients and projects', 'No clients yet.'),
  },
  {
    name: 'clients-owner',
    who: alice,
    path: (w) => `${org(w)}/clients`,
    shows: (page) => [
      ...headed('Clients and projects', 'Harbour Foods')(page),
      page.getByLabel('Client name'),
    ],
  },
  {
    name: 'clients-member',
    who: bob,
    path: (w) => `${org(w)}/clients`,
    shows: headed('Clients and projects', 'Harbour Foods'),
  },

  {
    name: 'inbox-empty',
    who: (w) => w.quiet,
    path: (w) => `${quiet(w)}/inbox`,
    shows: headed('Inbox', 'Nothing here.'),
  },
  {
    name: 'inbox-with-items',
    who: bob,
    path: (w) => `${org(w)}/inbox`,
    shows: headed('Inbox', 'An approval needs your decision'),
  },

  {
    name: 'invitation-signed-out',
    who: () => null,
    path: (w) => `/invite/${w.inviteToken}`,
    shows: headed('You have been invited', 'Sign in with the email address'),
  },
  {
    name: 'invitation-signed-in',
    who: (w) => w.invited,
    path: (w) => `/invite/${w.inviteToken}`,
    shows: (page) => [
      ...heading('You have been invited')(page),
      page.getByRole('button', { name: 'Accept invitation' }),
    ],
  },
  {
    name: 'invitation-waiting',
    who: (w) => w.asking,
    path: (w) => `/invite/${w.askingToken}?state=waiting`,
    shows: heading('Waiting for confirmation'),
  },
  {
    name: 'invitation-refused',
    who: (w) => w.invited,
    path: (w) => `/invite/${w.inviteToken}?error=INVITATION_INVALID`,
    shows: headed('You have been invited', 'This invitation is not valid.'),
  },

  {
    name: 'not-found-signed-out',
    who: () => null,
    path: () => '/no-such-page',
    status: 404,
    shows: heading('Page not found'),
  },
  {
    name: 'not-found-signed-in',
    who: alice,
    path: () => '/no-such-page',
    status: 404,
    shows: heading('Page not found'),
  },
  {
    name: 'not-found-in-organization',
    who: alice,
    path: (w) => `${org(w)}/work/00000000-0000-4000-8000-000000000000`,
    status: 404,
    shows: heading('Page not found'),
  },
];
