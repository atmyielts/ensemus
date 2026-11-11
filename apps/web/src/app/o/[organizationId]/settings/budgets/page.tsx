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
  byom: 'Ensemus Cloud, with your own AI model',
  sovereign: 'Ensemus on your own servers',
} as const;

const FEATURE_WORDS: Record<string, string> = {
  'agent.run': 'Running assistants',
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
        description="What assistants may spend each month, and what they have spent. Until a budget is set for a month, no assistant can run in it."
      />
      <ErrorNotice code={error} />
      <form className="inline-form filter" method="get">
        <label>
          Month
          <input
            type="month"
            name="period"
            defaultValue={period}
            pattern="[0-9]{4}-[0-9]{2}"
            required
          />
        </label>
        <SubmitButton className="secondary">Show month</SubmitButton>
      </form>
      <div className="stack">
        <section className="card" aria-labelledby="usage-heading">
          <h2 id="usage-heading">Usage in {period}</h2>
          <dl>
            <dt>{spentLabel}</dt>
            <dd>{formatMicrosUsd(summary.spent_micros)}</dd>
            <dt>Held for work in progress</dt>
            <dd>{formatMicrosUsd(summary.reserved_micros)}</dd>
            <dt>Company limit</dt>
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
            <p className="gap-above">
              <small className="muted">
                These are estimates from your rate cards, and a lost answer counts at the most it
                could have cost, so they can run higher than the real bill.
                {summary.billable
                  ? ''
                  : ' Ensemus does not bill for this usage: the company behind your AI model does.'}
              </small>
            </p>
          )}
        </section>

        <section className="card" aria-labelledby="budgets-heading">
          <h2 id="budgets-heading">Budgets for {period}</h2>
          {rows.length === 0 ? (
            <Empty title="No budget for this month">
              {canManage
                ? 'Assistants cannot run this month until it has one. Set a limit below.'
                : 'Assistants cannot run this month until an administrator sets a limit.'}
            </Empty>
          ) : (
            <ul className="list">
              {rows.map((row) => (
                <li key={row.id}>
                  {row.scope === 'organization'
                    ? 'The whole company'
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
              <small className="muted">
                Set a limit for the whole company, or for one version of an assistant. Setting it
                again replaces the limit for this month.
              </small>
              <input type="hidden" name="organizationId" value={organizationId} />
              <input type="hidden" name="period" value={period} />
              <label>
                Applies to
                <select name="target" defaultValue="organization">
                  <option value="organization">The whole company</option>
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
              <SubmitButton>Set budget</SubmitButton>
            </form>
          )}
        </section>

        <section className="card" aria-labelledby="stops-heading">
          <h2 id="stops-heading">Why assistants were stopped</h2>
          {stops.length === 0 ? (
            <Empty title="Nothing stopped">
              No assistant was stopped by a limit or a rule this month.
            </Empty>
          ) : (
            <ul className="list">
              {stops.map((stop) => (
                <li key={stop.code}>
                  {DENIAL_WORDS[stop.kind]}
                  <small className="muted">
                    {stop.count} {stop.count === 1 ? 'run' : 'runs'}, code {stop.code}
                  </small>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card" aria-labelledby="entitlements-heading">
          <h2 id="entitlements-heading">What your plan includes</h2>
          <p>{MODE_WORDS[entitlements.mode]}</p>
          <dl className="gap-above">
            <dt>Credit balance, in microcredits</dt>
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
          <p className="muted gap-above">
            A microcredit is a millionth of a credit. An amount that is unavailable is never shown
            as zero, and Billing shows exact balances.
          </p>
          {entitlements.features.length === 0 ? (
            <Empty title="Nothing included yet">Until something is, assistants cannot run.</Empty>
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
