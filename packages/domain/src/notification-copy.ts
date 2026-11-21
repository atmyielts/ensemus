// What a notification says, and where it leads, in one place for the inbox and for email alike. A
// notification holds a kind and an opaque reference, never content (UX-17), so these words are all either
// surface ever shows. The page a reference leads to checks access when it is opened.

const TITLES: Readonly<Record<string, string>> = {
  'approval.requested': 'An approval needs your decision',
  'approval.decided': 'A review of your work was decided',
  'approval.expired': 'A review of your work ran out of time',
  'approval.closed': 'A review of your work was closed, because the reviewer lost access',
  'approval.outdated': 'A review of your work was closed, because the work changed',
  'approval.superseded':
    'A review you asked for was closed, because a plan started and asks its own reviewer',
  'approval.work_finished': 'A review you asked for was closed, because the work finished',
  'approval.work_reopened': 'A review you asked for was closed, because the work was reopened',
  'work.run_withdrawn': 'A plan you asked to run was withdrawn, because someone moved the work',
  'work.stopped': 'Work you own was stopped',
  'work.failed': 'Work you own did not finish',
  'work.assigned': 'You were put on some work',
  'work.owner_recovered':
    'Another owner chose a new owner for restricted work whose owner was disabled',
  'member.join_requested': 'Someone is asking to join, and needs confirming',
  'external_action.unknown': "We don't know whether something was sent, and it needs you to look",
  'external_action.failed': 'Something you asked to send was not sent',
  'external_action.sent': 'Something you asked to send was sent',
  'knowledge.answer_ready': 'The answer to your question is ready',
  'knowledge.fact_disputed': 'Someone questioned a fact, and it needs checking',
  'publish_review.requested': 'A change is waiting for your review before it goes live',
  'publish_review.decided': 'Your change was reviewed',
  'process_run.finished': 'A process you started has finished',
  'organization_export.ready': 'Your company export is ready to download',
  'organization_export.failed': 'Your company export could not be finished',
  'organization_import.finished': 'Your import has finished',
  'invoice.issued': 'You have a new invoice',
  'payment.failed': 'A payment did not go through',
  'payment.unknown': "We can't yet tell whether a payment went through",
  'credits.low': 'Your credits are running low',
  'credits.exhausted': 'Your credits have run out',
  'tenant.standing_changed': "Your company's access to Ensemus changed",
  'offboarding.progress': "There's news about your company leaving Ensemus",
  'ticket.replied': 'Support replied to your request',
  'break_glass.requested': 'Support asked to look at something in your company',
};

const FALLBACK_TITLE = 'Something needs your attention';

/** One plain sentence. An unknown kind gets a general line rather than an internal name. */
export function notificationTitle(kind: string): string {
  return TITLES[kind] ?? FALLBACK_TITLE;
}

/** The kinds this module has words for, so a test can hold the list to the kinds that exist. */
export const TITLED_NOTIFICATION_KINDS: readonly string[] = Object.keys(TITLES);

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The page a reference leads to, under `base` (the organization's path). Only a well-formed ID is ever
 * put in a path, so a reference cannot steer anywhere else. Anything unknown leads to the inbox.
 */
export function notificationPath(base: string, targetRef: string): string {
  const separator = targetRef.indexOf(':');
  if (separator <= 0) return `${base}/inbox`;
  const type = targetRef.slice(0, separator);
  const id = targetRef.slice(separator + 1);
  const withId = (path: string) => (ID.test(id) ? `${base}${path}/${id.toLowerCase()}` : null);
  const path = (() => {
    switch (type) {
      case 'approval':
        return withId('/approvals');
      case 'work_unit':
        return withId('/work');
      case 'external_action':
        return withId('/external-actions');
      case 'knowledge_answer':
        return withId('/knowledge/answers');
      case 'knowledge_fact':
        return withId('/knowledge/facts');
      case 'knowledge_source':
        return withId('/knowledge/sources');
      case 'publish_review':
        return withId('/studio/reviews');
      case 'process_run':
        return withId('/studio/runs');
      case 'invoice':
        return withId('/account/invoices');
      case 'ticket':
        return withId('/account/support');
      case 'invitation':
        return `${base}/people`;
      case 'organization_export':
        return `${base}/account/exports`;
      case 'organization':
        return `${base}/account/credits`;
      case 'payment':
        return `${base}/account/invoices`;
      case 'break_glass':
        return `${base}/account/break-glass`;
      case 'offboarding':
        return `${base}/account/leave`;
      default:
        return null;
    }
  })();
  return path ?? `${base}/inbox`;
}
