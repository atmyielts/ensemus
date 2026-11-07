import { describe, expect, it } from 'vitest';
import {
  connectionRecordSchema,
  coreRecordSchema,
  personRecordSchema,
} from './portability-records';

const ID = '6f1c2c6e-1111-4111-8111-111111111111';
const AT = '2027-01-01T00:00:00.000Z';

const workUnit = {
  kind: 'work_unit',
  id: ID,
  project_id: null,
  parent_id: null,
  owner_membership_id: ID,
  created_by_membership_id: null,
  title: 'A title',
  objective: null,
  status: 'queued',
  completion_criteria: [],
  execution_plan: null,
  classification: 'internal',
  due_at: null,
  created_at: AT,
  updated_at: AT,
};

describe('a record in an archive', () => {
  it('reads what export writes', () => {
    expect(coreRecordSchema.safeParse(workUnit).success).toBe(true);
  });

  it('refuses restricted work, at either end (ADR-030 D10)', () => {
    expect(coreRecordSchema.safeParse({ ...workUnit, classification: 'restricted' }).success).toBe(
      false,
    );
  });

  it('has nowhere to name a tenant', () => {
    expect(coreRecordSchema.safeParse({ ...workUnit, organization_id: ID }).success).toBe(false);
  });

  it('has nowhere to put which run held the work', () => {
    expect(coreRecordSchema.safeParse({ ...workUnit, run_id: 'x' }).success).toBe(false);
  });

  it('has nowhere for a credential on a connection (QA-024)', () => {
    const connection = {
      kind: 'connection',
      id: ID,
      connector_type: 'email_smtp',
      display_name: 'Mail',
      granted_scopes: [],
      created_at: AT,
    };
    expect(connectionRecordSchema.safeParse(connection).success).toBe(true);
    for (const field of ['credential_secret_id', 'credential', 'config', 'signing_secret']) {
      expect(connectionRecordSchema.safeParse({ ...connection, [field]: 'x' }).success).toBe(false);
    }
  });

  it('has nowhere for a password or session on a person', () => {
    const person = {
      kind: 'person',
      membership_id: ID,
      display_name: 'Someone',
      email: 'someone@example.invalid',
      role: 'member',
      status: 'active',
      created_at: AT,
    };
    expect(personRecordSchema.safeParse(person).success).toBe(true);
    expect(personRecordSchema.safeParse({ ...person, password: 'x' }).success).toBe(false);
    expect(personRecordSchema.safeParse({ ...person, role: 'root' }).success).toBe(false);
  });

  it('refuses a kind it does not know', () => {
    expect(coreRecordSchema.safeParse({ kind: 'secret', id: ID }).success).toBe(false);
  });
});
