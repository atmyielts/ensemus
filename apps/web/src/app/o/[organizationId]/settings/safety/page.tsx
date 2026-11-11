import { listHaltableAgentVersions, listKillSwitches } from '@ensemus/application/ai-halt';
import { can } from '@ensemus/domain/policy';
import { ConfirmForm } from '@/components/confirm-form';
import { Empty, ErrorNotice, formatDateTime, PageHead } from '@/components/ui';
import { requireTenant } from '@/server/tenant';
import { engageKillSwitchAction, releaseKillSwitchAction } from './actions';
import { HALT_REASONS, reasonLabel, scopeLabel } from './safety-view';

export const metadata = { title: 'Safety | Ensemus' };

function ReasonField() {
  return (
    <label>
      Why
      <select name="reasonCode" required defaultValue="">
        <option value="" disabled>
          Choose a reason
        </option>
        {HALT_REASONS.map(({ code, label }) => (
          <option key={code} value={code}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}

export default async function SafetyPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { organizationId } = await params;
  const { error } = await searchParams;
  const { context, database } = await requireTenant(organizationId);
  const head = (
    <PageHead
      title="Safety"
      description="An emergency stop for your AI agents (the assistants built in Automation Studio). People’s own work carries on, and only agents stop."
    />
  );

  if (!can(context.role, 'ai.halt')) {
    return (
      <>
        {head}
        <ErrorNotice code={error} />
        <Empty title="For owners and administrators">
          Only owners and administrators can see and change emergency stops.
        </Empty>
      </>
    );
  }

  const [switches, versions] = await Promise.all([
    listKillSwitches(database, context),
    listHaltableAgentVersions(database, context),
  ]);
  const nameOf = new Map(
    versions.map((version) => [version.id, `${version.name}, version ${version.versionNumber}`]),
  );
  const org = <input type="hidden" name="organizationId" value={organizationId} />;
  const orgWideStop = switches.some((row) => row.scope === 'organization');

  return (
    <>
      {head}
      <ErrorNotice code={error} />
      <div className="stack">
        <section className="card" aria-labelledby="stops-heading">
          <h2 id="stops-heading">Stops in force</h2>
          {switches.length === 0 ? (
            <Empty title="Nothing is stopped">
              Agents can run. If something goes wrong, use a stop below.
            </Empty>
          ) : (
            <ul className="list">
              {switches.map((row) => {
                const covers = scopeLabel(
                  row,
                  row.targetRef ? nameOf.get(row.targetRef) : undefined,
                );
                return (
                  <li key={row.id} className="block">
                    <div className="spread">
                      <strong>{covers}</strong>
                      <span className="badge bad">Stopped</span>
                    </div>
                    <p className="muted">
                      {reasonLabel(row.reasonCode)}. Since {formatDateTime(row.engagedAt)}.
                    </p>
                    {row.operator ? (
                      <p className="muted gap-above-small">
                        Set by whoever runs Ensemus for your company. Only they can lift it.
                      </p>
                    ) : (
                      <div className="gap-above-small">
                        <ConfirmForm
                          action={releaseKillSwitchAction}
                          fields={
                            <>
                              {org}
                              <input type="hidden" name="switch" value={row.id} />
                            </>
                          }
                          summary="Lift this stop"
                          summaryLabel={`Lift the stop on: ${covers}`}
                          consequence="Let agents covered by this stop run again. Runs it already ended stay ended. Lifting it goes in the audit log."
                          confirmLabel="Lift this stop"
                        />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="card" aria-labelledby="stop-all-heading">
          <h2 id="stop-all-heading">Stop every agent in your company</h2>
          <p className="muted">
            A model call in flight is cut off, and no queued run, model call or tool action can
            start until this is lifted. Anything an agent already sent stays sent.
          </p>
          {orgWideStop && (
            <p className="notice warn flush gap-above-small">
              A stop like this is already in force.
            </p>
          )}
          <div className="gap-above">
            <ConfirmForm
              action={engageKillSwitchAction}
              fields={
                <>
                  {org}
                  <input type="hidden" name="scope" value="organization" />
                </>
              }
              summary="Stop every agent"
              consequence="Stop every agent in this organization now. This goes in the audit log, and it stays until an owner or admin lifts it."
              confirmLabel="Stop every agent"
            >
              <ReasonField />
            </ConfirmForm>
          </div>
        </section>

        <section className="card" aria-labelledby="stop-one-heading">
          <h2 id="stop-one-heading">Stop one agent version</h2>
          <p className="muted">
            Stop a single published version, and every other agent carries on.
          </p>
          {versions.length === 0 ? (
            <Empty title="No agents yet">
              Once an agent is published in Automation Studio, you can stop it here.
            </Empty>
          ) : (
            <ConfirmForm
              action={engageKillSwitchAction}
              fields={
                <>
                  {org}
                  <input type="hidden" name="scope" value="agent_version" />
                </>
              }
              summary="Stop one agent version"
              consequence="Stop this version now, in this organization. Other agents carry on. This goes in the audit log, and it stays until an owner or admin lifts it."
              confirmLabel="Stop this version"
            >
              <label>
                Agent version
                <select name="target" required defaultValue="">
                  <option value="" disabled>
                    Choose a version
                  </option>
                  {versions.map((version) => (
                    <option key={version.id} value={version.id}>
                      {nameOf.get(version.id)}
                    </option>
                  ))}
                </select>
              </label>
              <ReasonField />
            </ConfirmForm>
          )}
        </section>
      </div>
    </>
  );
}
