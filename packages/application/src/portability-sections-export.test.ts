import { describe, expect, it } from 'vitest';
import { portableAuditTarget } from './portability-sections-export';

const tenant = '90000000-0000-4000-8000-000000000001';

describe('an exported audit target names no tenant (ADR-030 D7)', () => {
  it('turns the organization itself into plain organization', () => {
    expect(portableAuditTarget(`organization:${tenant}`, tenant)).toBe('organization');
    expect(portableAuditTarget(`organization:${tenant.toUpperCase()}`, tenant)).toBe(
      'organization',
    );
  });
  it('keeps only the type of any other target that carries the tenant', () => {
    expect(portableAuditTarget(`object:${tenant}/artifacts/x`, tenant)).toBe('object');
    expect(portableAuditTarget(`${tenant}`, tenant)).toBe('redacted');
  });
  it('leaves every other target exactly as it was', () => {
    const work = 'work_unit:90000000-0000-4000-8000-000000000002';
    expect(portableAuditTarget(work, tenant)).toBe(work);
    expect(portableAuditTarget('invitation:90000000-0000-4000-8000-000000000003', tenant)).toBe(
      'invitation:90000000-0000-4000-8000-000000000003',
    );
  });
});
