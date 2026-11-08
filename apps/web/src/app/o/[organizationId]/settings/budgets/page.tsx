import { loadSaasConfig } from '@ensemus/config';
import {
  getStopDiagnostics,
  getUsageSummary,
  listBudgetableVersions,
  listBudgets,
  type DenialKind,
} from '@ensemus/application/ai-budget';
import { formatMicrosUsd, getEntitlementsView } from '@ensemus/commercial';
import { can } from '@ensemus/domain/policy';
import { notFound } from 'next/navigation';
import { SubmitButton } from '@/components/submit-button';
import { Empty, ErrorNotice, PageHead } from '@/components/ui';
import { requireTenant } from '@/server/tenant';
import { setBudgetAction } from './actions';

export const metadata = { title: 'Budgets and usage | Ensemus' };

const MODE_WORDS = {
  cloud: 'Ensemus Cloud',
  byom: 'Your own model provider',
  sovereign: 'Your own deployment',
} as const;

const FEATURE_WORDS: Record<string, string> = {
  'agent.run': 'Running agents',
  'model.call': 'Calling a model',
};

/** Words the web tier owns. The code goes alongside, so an admin can match it to a run's stop reason. */
const DENIAL_WORDS: Record<DenialKind, string> = {
  entitlement: 'Not included for this organization. This is about the account, not your rules.',
  budget: 'Stopped by a spending limit, or by a model with no rate card.',
  policy: 'Stopped by your organization’s own policy. The account would have allowed it.',
};

const isPeriod = (value: string | undefined): value is string =>
  value !== undefined && /^[0-9]{4}-(0[1-9]|1[0-2])$/.test(value);

export default async function BudgetsPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ error?: string; period?: string }>;
}) {
  const { organizationId } = await params;
  const { error, period: asked } = await searchParams;
  const { context, database } = await requireTenant(organizationId);
  // Someone who may not see usage sees the same page as someone asking for one that does not exist.
  if (!can(context.role, 'usage.view')) notFound();
  const canManage = can(context.role, 'budget.manage');
  const period = isPeriod(asked) ? asked : new Date().toISOString().slice(0, 7);

  const [summary, rows, entitlements, stops, versions] = await Promise.all([
    getUsageSummary(database, context, { period }),
    listBudgets(database, context, { period }),
    getEntitlementsView(database, context, { billingEnabled: loadSaasConfig().billingEnabled }),
    getStopDiagnostics(database, context, { period }),
    canManage ? listBudgetableVersions(database, context) : Promise.resolve([]),
  ]);
  const spentLabel = summary.is_estimate ? 'Estimated spend' : 'Spend';

  return (
    <>
      <PageHead
        title="Budgets and usage"
        description="What agents may spend, and what they have spent. With no budget set, no agent can run."
      />
      <ErrorNotice code={error} />
      <div className="stack">
        <section className="card" aria-labelledby="month-heading">
          <h2 id="month-heading">Month</h2>
          <form className="inline-form" method="get">
            <label>
              Month, in UTC
              <input
                type="month"
                name="period"
                defaultValue={period}
                pattern="[0-9]{4}-[0-9]{2}"
                required
              />
            </label>
            <SubmitButton className="quiet">Show</SubmitButton>
          </form>
        </section>

        <section className="card" aria-labelledby="usage-heading">
          <h2 id="usage-heading">Usage</h2>
          <dl>
            <dt>{spentLabel}</dt>
            <dd>{formatMicrosUsd(summary.spent_micros)}</dd>
            <dt>Held for calls in progress</dt>
            <dd>{formatMicrosUsd(summary.reserved_micros)}</dd>
            <dt>Organization limit</dt>
            <dd>
              {summary.limit_micros === null ? 'Not set' : formatMicrosUsd(summary.limit_micros)}
            </dd>
            <dt>Tokens sent and received</dt>
            <dd>
              {summary.input_tokens.toLocaleString('en-US')} and{' '}
              {summary.output_tokens.toLocaleString('en-US')}
            </dd>
          </dl>
          {summary.is_estimate && (
            <p>
              <small>
                These are estimates from your rate cards, and a lost answer counts at the most it
                could have cost, so they can run higher than the real bill.
                {summary.billable
                  ? ''
                  : ' Ensemus does not bill for this usage: your model provider does.'}
              </small>
            </p>
          )}
        </section>

        <section className="card" aria-labelledby="budgets-heading">
          <h2 id="budgets-heading">Budgets for {period}</h2>
          {rows.length === 0 ? (
            <Empty>No budget is set for this month, so agents cannot run in it.</Empty>
          ) : (
            <ul className="list">
              {rows.map((row) => (
                <li key={row.id}>
                  {row.scope === 'organization'
                    ? 'This organization'
                    : `${row.agentName ?? 'Agent'}, version ${row.agentVersionNumber ?? '?'}`}
                  <small>
                    {formatMicrosUsd(row.spentMicros)} spent and{' '}
                    {formatMicrosUsd(row.reservedMicros)} held, of{' '}
                    {formatMicrosUsd(row.limitMicros)}
                  </small>
                </li>
              ))}
            </ul>
          )}
          {canManage && (
            <form className="inline-form divided" action={setBudgetAction}>
              <input type="hidden" name="organizationId" value={organizationId} />
              <input type="hidden" name="period" value={period} />
              <label>
                Applies to
                <select name="target" defaultValue="organization">
                  <option value="organization">This organization</option>
                  {versions.map((version) => (
                    <option key={version.id} value={version.id}>
                      {version.name}, version {version.versionNumber}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Limit in US dollars
                <input
                  name="limitUsd"
                  required
                  inputMode="decimal"
                  pattern="[0-9]{1,9}(\.[0-9]{1,6})?"
                  autoComplete="off"
                />
              </label>
              <SubmitButton className="quiet">Set budget</SubmitButton>
            </form>
          )}
        </section>

        <section className="card" aria-labelledby="stops-heading">
          <h2 id="stops-heading">Why agents were stopped</h2>
          {stops.length === 0 ? (
            <Empty>No agent was stopped by a limit or a policy this month.</Empty>
          ) : (
            <ul className="list">
              {stops.map((stop) => (
                <li key={stop.code}>
                  {DENIAL_WORDS[stop.kind]}
                  <small>
                    {stop.code}: {stop.count} {stop.count === 1 ? 'run' : 'runs'}
                  </small>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card" aria-labelledby="entitlements-heading">
          <h2 id="entitlements-heading">What this organization has</h2>
          <p>{MODE_WORDS[entitlements.mode]}</p>
          <dl>
            <dt>Account balance in microcredits</dt>
            <dd>
              {entitlements.capacity.balanceMicrocredits?.toLocaleString('en-US') ?? 'Unavailable'}
            </dd>
            <dt>Included microcredits</dt>
            <dd>
              {entitlements.capacity.includedMicrocredits?.toLocaleString('en-US') ?? 'Unavailable'}
            </dd>
            <dt>Active member limit</dt>
            <dd>
              {entitlements.capacity.maxActiveMembers?.toLocaleString('en-US') ?? 'Unavailable'}
            </dd>
          </dl>
          <p className="muted">
            Unavailable amounts are never shown as zero. Billing shows exact account balances.
          </p>
          {entitlements.features.length === 0 ? (
            <Empty>Nothing is included yet, so agents cannot run.</Empty>
          ) : (
            <ul className="list">
              {entitlements.features.map((feature) => (
                <li key={feature}>{FEATURE_WORDS[feature] ?? feature}</li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
