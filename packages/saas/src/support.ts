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
  facts: BreakGlassFacts,
  signature: { side: 'operator'; operatorRef: string } | { side: 'customer'; membershipId: string },
  config: BreakGlassConfig,
  now: Date,
): BreakGlassDecision {
  if (!config.enabled) return { ok: false, code: 'BREAK_GLASS_DISABLED' };
  if (
    !Number.isSafeInteger(config.maxMinutes) ||
    config.maxMinutes < 1 ||
    !Number.isSafeInteger(facts.requestedMinutes) ||
    facts.requestedMinutes < 1 ||
    facts.requestedMinutes > config.maxMinutes
  )
    return { ok: false, code: 'BREAK_GLASS_TOO_LONG' };
  if (!Number.isFinite(now.getTime())) return { ok: false, code: 'BREAK_GLASS_EXPIRED' };
  if (facts.state === 'expired' || (facts.expiresAt && facts.expiresAt <= now))
    return { ok: false, code: 'BREAK_GLASS_EXPIRED' };
  if (facts.state !== 'requested' || facts.authorizedFrom !== null || facts.expiresAt !== null)
    return { ok: false, code: 'BREAK_GLASS_NOT_REQUESTED' };
  const person = signature.side === 'operator' ? signature.operatorRef : signature.membershipId;
  if (
    !person ||
    person !== person.trim() ||
    person === facts.requestedBy ||
    person ===
      (signature.side === 'operator'
        ? facts.customerAuthorizerMembershipId
        : facts.operatorAuthorizer)
  )
    return { ok: false, code: 'BREAK_GLASS_SAME_PERSON' };
  const existing =
    signature.side === 'operator' ? facts.operatorAuthorizer : facts.customerAuthorizerMembershipId;
  if (existing && existing !== person) return { ok: false, code: 'BREAK_GLASS_NOT_REQUESTED' };
  const operator = signature.side === 'operator' ? person : facts.operatorAuthorizer,
    customer = signature.side === 'customer' ? person : facts.customerAuthorizerMembershipId;
  if (!operator || !customer) return { ok: true, state: 'requested', expiresAt: null };
  const expiresAt = new Date(now.getTime() + facts.requestedMinutes * 60_000);
  if (!Number.isFinite(expiresAt.getTime())) return { ok: false, code: 'BREAK_GLASS_TOO_LONG' };
  return { ok: true, state: 'authorized', expiresAt };
}

/** Whether a grant holds right now. The clock decides, so an expiry cannot be missed by a late sweep. */
export function breakGlassInForce(facts: BreakGlassFacts, now: Date): boolean {
  return (
    facts.state === 'authorized' &&
    Boolean(
      facts.operatorAuthorizer &&
      facts.customerAuthorizerMembershipId &&
      facts.operatorAuthorizer !== facts.requestedBy &&
      facts.operatorAuthorizer !== facts.customerAuthorizerMembershipId &&
      facts.customerAuthorizerMembershipId !== facts.requestedBy,
    ) &&
    Number.isSafeInteger(facts.requestedMinutes) &&
    facts.requestedMinutes > 0 &&
    facts.authorizedFrom !== null &&
    facts.expiresAt !== null &&
    Number.isFinite(now.getTime()) &&
    facts.authorizedFrom <= now &&
    facts.expiresAt > now &&
    facts.expiresAt.getTime() - facts.authorizedFrom.getTime() <= facts.requestedMinutes * 60_000
  );
}

/** A published schedule: which hours, in the schedule's own timezone. All of it is the owner's data. */
export type CoverageWindow = { day: number; from: string; to: string };

/** Whether someone is rostered at `at`. No schedule published is false, and never a guess. */
export function withinCoverage(
  windows: readonly CoverageWindow[] | null,
  timezone: string | null,
  at: Date,
): boolean {
  if (!windows?.length || !timezone || !Number.isFinite(at.getTime())) return false;
  const minute = (value: string, end = false) => {
    if (end && value === '24:00') return 1440;
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
    const [hour, minutes] = value.split(':').map(Number);
    return hour! * 60 + minutes!;
  };
  if (
    windows.some(
      (window) =>
        !Number.isInteger(window.day) ||
        window.day < 0 ||
        window.day > 6 ||
        minute(window.from) === null ||
        minute(window.to, true) === null,
    )
  )
    return false;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(at);
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
        parts.find((part) => part.type === 'weekday')!.value,
      ),
      local =
        Number(parts.find((part) => part.type === 'hour')!.value) * 60 +
        Number(parts.find((part) => part.type === 'minute')!.value);
    return windows.some((window) => {
      const from = minute(window.from)!,
        to = minute(window.to, true)!;
      return from < to
        ? window.day === day && local >= from && local < to
        : from > to &&
            ((window.day === day && local >= from) || ((window.day + 1) % 7 === day && local < to));
    });
  } catch {
    return false;
  }
}
