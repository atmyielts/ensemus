// The support desk and break-glass (OPS-22, OPS-24). Pure. The default is no support access to customer
// content, and this milestone adds no way to change that: a break-glass request is a record of who asked
// and who agreed, and nothing reads content because of one (ADR-032 D8).
// The tables of values are fixed. The functions are owned by the support slice.

export const TICKET_STATUSES = [
  'open',
  'waiting_on_customer',
  'waiting_on_support',
  'resolved',
  'closed',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export const TICKET_CATEGORIES = ['account', 'billing', 'incident', 'security', 'other'] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

export const BREAK_GLASS_STATES = [
  'requested',
  'authorized',
  'denied',
  'revoked',
  'expired',
] as const;
export type BreakGlassState = (typeof BREAK_GLASS_STATES)[number];

/** Matches `support.check_break_glass_change` in migration 0501, and a test holds the two together. */
export const BREAK_GLASS_TRANSITIONS: Readonly<
  Record<BreakGlassState, readonly BreakGlassState[]>
> = {
  requested: ['authorized', 'denied', 'expired'],
  authorized: ['revoked', 'expired'],
  denied: [],
  revoked: [],
  expired: [],
};

/** Set per deployment, and off unless named. There is no default number of minutes. */
export type BreakGlassConfig = { enabled: false } | { enabled: true; maxMinutes: number };

export type BreakGlassFacts = {
  state: BreakGlassState;
  requestedBy: string;
  requestedMinutes: number;
  operatorAuthorizer: string | null;
  customerAuthorizerMembershipId: string | null;
  authorizedFrom: Date | null;
  expiresAt: Date | null;
};

export type BreakGlassRefusal =
  | 'BREAK_GLASS_DISABLED'
  | 'BREAK_GLASS_TOO_LONG'
  | 'BREAK_GLASS_NEEDS_TWO_AUTHORIZERS'
  | 'BREAK_GLASS_SAME_PERSON'
  | 'BREAK_GLASS_NOT_REQUESTED'
  | 'BREAK_GLASS_EXPIRED';

export type BreakGlassDecision =
  | { ok: true; state: 'requested' | 'authorized'; expiresAt: Date | null }
  | { ok: false; code: BreakGlassRefusal };

/**
 * Applies one signature. It reaches `authorized` only with both signatures, from two different people, and
 * within the configured limit, and the time runs from the second signature. Off answers BREAK_GLASS_DISABLED.
 */
export function signBreakGlass(
  _facts: BreakGlassFacts,
  _signature:
    { side: 'operator'; operatorRef: string } | { side: 'customer'; membershipId: string },
  _config: BreakGlassConfig,
  _now: Date,
): BreakGlassDecision {
  throw new Error('NOT_IMPLEMENTED');
}

/** Whether a grant holds right now. The clock decides, so an expiry cannot be missed by a late sweep. */
export function breakGlassInForce(_facts: BreakGlassFacts, _now: Date): boolean {
  throw new Error('NOT_IMPLEMENTED');
}

/** A published schedule: which hours, in the schedule's own timezone. All of it is the owner's data. */
export type CoverageWindow = { day: number; from: string; to: string };

/** Whether someone is rostered at `at`. No schedule published is false, and never a guess. */
export function withinCoverage(
  _windows: readonly CoverageWindow[] | null,
  _timezone: string | null,
  _at: Date,
): boolean {
  throw new Error('NOT_IMPLEMENTED');
}
