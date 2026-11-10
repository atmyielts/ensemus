// Trusted operator commands only. A supplied actor reference is attribution, never authorization:
// every transaction also checks the effective database role. There is no web operator path.
import type { EnsemusDrizzle } from '@ensemus/database/operator';
import {
  incidents,
  incidentUpdates,
  drills,
  vulnerabilityReports,
  operatorActions,
  type Tx,
} from '@ensemus/database';
import {
  INCIDENT_SEVERITIES,
  INCIDENT_STATES,
  INCIDENT_ORIGINS,
  INCIDENT_ROLES,
  VULNERABILITY_STATES,
  type IncidentOrigin,
  type IncidentSeverity,
  type IncidentState,
  type VulnerabilityState,
} from '@ensemus/saas/operations';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError } from '../errors';
import { idSchema } from '../ids';

export type OperatorDb = EnsemusDrizzle;
const reference = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !/\p{Cc}/u.test(value));
const publicText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !value.includes('\0'));
const actor = { operatorRef: reference },
  roleFields = {
    securityLeadRef: reference.optional(),
    infrastructureLeadRef: reference.optional(),
    communicationsRef: reference.optional(),
    legalRef: reference.optional(),
  };
const roles = z.strictObject(
  Object.fromEntries(INCIDENT_ROLES.map((role) => [role, reference])) as Record<
    (typeof INCIDENT_ROLES)[number],
    typeof reference
  >,
);
const completeDrill = (value: {
  startedAt: Date;
  finishedAt: Date | null;
  outcome: 'passed' | 'failed' | null;
  evidenceRef: string | null;
}) =>
  value.finishedAt === null
    ? value.outcome === null && value.evidenceRef === null
    : value.finishedAt >= value.startedAt && value.outcome !== null && value.evidenceRef !== null;
export const incidentInputSchemas = {
  open: z.strictObject({
    ...actor,
    severity: z.enum(INCIDENT_SEVERITIES),
    origin: z.enum(INCIDENT_ORIGINS),
    providerKind: reference.nullable(),
    publicTitle: publicText(200),
    commanderRef: reference,
    isDrill: z.boolean(),
    startedAt: z.date(),
  }),
  roles: z
    .strictObject({ ...actor, incidentId: idSchema, ...roleFields })
    .refine((input) =>
      Object.keys(roleFields).some((key) => input[key as keyof typeof roleFields] !== undefined),
    ),
  update: z.strictObject({
    incidentId: idSchema,
    state: z.enum(INCIDENT_STATES),
    publicMessage: publicText(2000),
    authorRef: reference,
    publish: z.boolean(),
    origin: z.enum(INCIDENT_ORIGINS).optional(),
  }),
  resolve: z.strictObject({
    incidentId: idSchema,
    authorRef: reference,
    postmortemRef: reference.nullable(),
    message: publicText(2000),
  }),
  drill: z
    .strictObject({
      ...actor,
      kind: z.enum(['incident', 'restore', 'vulnerability_disclosure', 'failover']),
      scenarioRef: reference,
      roles,
      startedAt: z.date(),
      finishedAt: z.date().nullable(),
      outcome: z.enum(['passed', 'failed']).nullable(),
      evidenceRef: reference.nullable(),
    })
    .refine(completeDrill),
  vulnerability: z.strictObject({
    ...actor,
    channelRef: reference,
    detailsRef: reference,
    receivedAt: z.date(),
    isExercise: z.boolean(),
  }),
  move: z.strictObject({
    ...actor,
    reportId: idSchema,
    state: z.enum(VULNERABILITY_STATES),
    severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
    fixedInRef: reference.optional(),
    expectedVersion: z.int().positive(),
  }),
};
export const incidentWireDate = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value));
export const incidentCommandInputSchemas = {
  ...incidentInputSchemas,
  open: incidentInputSchemas.open.extend({ startedAt: incidentWireDate }),
  drill: z
    .strictObject({
      ...incidentInputSchemas.drill.shape,
      startedAt: incidentWireDate,
      finishedAt: incidentWireDate.nullable(),
    })
    .refine(completeDrill),
  vulnerability: incidentInputSchemas.vulnerability.extend({ receivedAt: incidentWireDate }),
};
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new AppError('INVALID_INPUT');
  return result.data;
}
async function operator(tx: Tx) {
  const result = await tx.execute(sql`select current_user as role`);
  if (result.rows[0]?.role !== 'ensemus_operator') throw new AppError('NOT_FOUND');
}
async function action(tx: Tx, operatorRef: string, name: string, kind: string, id: string) {
  await tx
    .insert(operatorActions)
    .values({ operatorRef, action: `operations.${name}`, targetRef: `${kind}:${id}` });
}
async function lockedIncident(tx: Tx, id: string) {
  const [row] = await tx.select().from(incidents).where(eq(incidents.id, id)).for('update');
  if (!row) throw new AppError('NOT_FOUND');
  return row;
}

export async function openIncident(
  db: OperatorDb,
  input: {
    operatorRef?: string;
    severity: IncidentSeverity;
    origin: IncidentOrigin;
    providerKind: string | null;
    publicTitle: string;
    commanderRef: string;
    isDrill: boolean;
    startedAt: Date;
  },
): Promise<{ incidentId: string }> {
  const value = parse(incidentInputSchemas.open, input);
  return db.transaction(async (tx) => {
    await operator(tx);
    const { operatorRef, ...fields } = value;
    const [row] = await tx.insert(incidents).values(fields).returning({ id: incidents.id });
    await action(tx, operatorRef, 'incident.opened', 'incident', row!.id);
    return { incidentId: row!.id };
  });
}
export async function assignIncidentRoles(
  db: OperatorDb,
  input: {
    operatorRef?: string;
    incidentId: string;
    securityLeadRef?: string;
    infrastructureLeadRef?: string;
    communicationsRef?: string;
    legalRef?: string;
  },
): Promise<void> {
  const value = parse(incidentInputSchemas.roles, input);
  await db.transaction(async (tx) => {
    await operator(tx);
    const row = await lockedIncident(tx, value.incidentId);
    if (row.state === 'resolved') throw new AppError('INVALID_STATE');
    const { operatorRef, incidentId, ...fields } = value;
    await tx
      .update(incidents)
      .set({ ...fields, version: row.version + 1, updatedAt: new Date() })
      .where(eq(incidents.id, incidentId));
    await action(tx, operatorRef, 'incident.roles_assigned', 'incident', incidentId);
  });
}
export async function updateIncident(
  db: OperatorDb,
  input: {
    incidentId: string;
    state: IncidentState;
    publicMessage: string;
    authorRef: string;
    publish: boolean;
    origin?: IncidentOrigin;
  },
): Promise<void> {
  const value = parse(incidentInputSchemas.update, input);
  await db.transaction(async (tx) => {
    await operator(tx);
    const row = await lockedIncident(tx, value.incidentId);
    // Resolution has its own evidence guard; this command cannot bypass it.
    if (row.state === 'resolved' || value.state === 'resolved' || (row.isDrill && value.publish))
      throw new AppError('INVALID_STATE');
    await tx.insert(incidentUpdates).values({
      incidentId: row.id,
      state: value.state,
      publicMessage: value.publicMessage,
      authorRef: value.authorRef,
    });
    await tx
      .update(incidents)
      .set({
        state: value.state,
        published: row.published || value.publish,
        ...(value.origin ? { origin: value.origin } : {}),
        version: row.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(incidents.id, row.id));
    await action(
      tx,
      value.authorRef,
      value.publish && !row.published ? 'incident.published' : 'incident.updated',
      'incident',
      row.id,
    );
  });
}
export async function resolveIncident(
  db: OperatorDb,
  input: { incidentId: string; authorRef: string; postmortemRef: string | null; message: string },
): Promise<void> {
  const value = parse(incidentInputSchemas.resolve, input);
  await db.transaction(async (tx) => {
    await operator(tx);
    const row = await lockedIncident(tx, value.incidentId);
    if (row.state === 'resolved') throw new AppError('INVALID_STATE');
    if (row.severity !== 'medium' && value.postmortemRef === null)
      throw new AppError('PREREQUISITES_INCOMPLETE');
    const now = new Date(Math.max(Date.now(), row.startedAt.getTime()));
    await tx.insert(incidentUpdates).values({
      incidentId: row.id,
      state: 'resolved',
      publicMessage: value.message,
      authorRef: value.authorRef,
      occurredAt: now,
    });
    await tx
      .update(incidents)
      .set({
        state: 'resolved',
        postmortemRef: value.postmortemRef,
        resolvedAt: now,
        version: row.version + 1,
        updatedAt: now,
      })
      .where(eq(incidents.id, row.id));
    await action(tx, value.authorRef, 'incident.resolved', 'incident', row.id);
  });
}
export async function recordDrill(
  db: OperatorDb,
  input: {
    operatorRef?: string;
    kind: 'incident' | 'restore' | 'vulnerability_disclosure' | 'failover';
    scenarioRef: string;
    roles: Readonly<Record<string, string>>;
    startedAt: Date;
    finishedAt: Date | null;
    outcome: 'passed' | 'failed' | null;
    evidenceRef: string | null;
  },
): Promise<{ drillId: string }> {
  const value = parse(incidentInputSchemas.drill, input);
  return db.transaction(async (tx) => {
    await operator(tx);
    const { operatorRef, ...fields } = value;
    const [row] = await tx.insert(drills).values(fields).returning({ id: drills.id });
    await action(tx, operatorRef, 'drill.recorded', 'drill', row!.id);
    return { drillId: row!.id };
  });
}
export async function recordVulnerabilityReport(
  db: OperatorDb,
  input: {
    operatorRef?: string;
    channelRef: string;
    detailsRef: string;
    receivedAt: Date;
    isExercise: boolean;
  },
): Promise<{ reportId: string }> {
  const value = parse(incidentInputSchemas.vulnerability, input);
  return db.transaction(async (tx) => {
    await operator(tx);
    const { operatorRef, ...fields } = value;
    const [row] = await tx
      .insert(vulnerabilityReports)
      .values(fields)
      .returning({ id: vulnerabilityReports.id });
    await action(tx, operatorRef, 'vulnerability.received', 'vulnerability', row!.id);
    return { reportId: row!.id };
  });
}
function mayMove(from: string, to: VulnerabilityState) {
  if (from === 'received') return to === 'triaged' || to === 'rejected';
  if (from === 'triaged') return to === 'fixing' || to === 'rejected';
  if (from === 'fixing') return to === 'fixed' || to === 'rejected';
  if (from === 'fixed') return to === 'disclosed' || to === 'fixing';
  return false;
}
export async function moveVulnerabilityReport(
  db: OperatorDb,
  input: {
    operatorRef?: string;
    reportId: string;
    state: VulnerabilityState;
    severity?: 'critical' | 'high' | 'medium' | 'low';
    fixedInRef?: string;
    expectedVersion: number;
  },
): Promise<void> {
  const value = parse(incidentInputSchemas.move, input);
  await db.transaction(async (tx) => {
    await operator(tx);
    const [row] = await tx
      .select()
      .from(vulnerabilityReports)
      .where(eq(vulnerabilityReports.id, value.reportId))
      .for('update');
    if (!row) throw new AppError('NOT_FOUND');
    if (row.version !== value.expectedVersion) throw new AppError('VERSION_CONFLICT');
    if (!mayMove(row.state, value.state)) throw new AppError('INVALID_TRANSITION');
    const severity = value.severity ?? row.severity,
      fixedInRef =
        row.state === 'fixed' && value.state === 'fixing'
          ? (value.fixedInRef ?? null)
          : (value.fixedInRef ?? row.fixedInRef);
    if (
      (value.state !== 'rejected' && !severity) ||
      ((value.state === 'fixed' || value.state === 'disclosed') && !fixedInRef)
    )
      throw new AppError('PREREQUISITES_INCOMPLETE');
    const now = new Date(Math.max(Date.now(), row.receivedAt.getTime()));
    await tx
      .update(vulnerabilityReports)
      .set({
        state: value.state,
        severity,
        fixedInRef,
        acknowledgedAt: row.acknowledgedAt ?? now,
        disclosedAt: value.state === 'disclosed' ? now : row.disclosedAt,
        version: row.version + 1,
        updatedAt: now,
      })
      .where(eq(vulnerabilityReports.id, row.id));
    await action(tx, value.operatorRef, `vulnerability.${value.state}`, 'vulnerability', row.id);
  });
}
