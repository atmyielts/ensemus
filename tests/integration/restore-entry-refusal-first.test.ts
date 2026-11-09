// 0548 (check finding 1): each service-only restore entry point of 0545 and 0547 must OPEN with its
// session_user refusal, not merely contain it. FLAGGED FOR HUMAN SECURITY REVIEW, not yet reviewed by a
// person. Every redefinition here runs as the migrator inside a transaction that is rolled back, and
// 0548's own statements, read from the migration file, are what judge it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot, urls } from '../helpers/stack';

const migration = readFileSync(
  join(repoRoot, 'packages/database/migrations/0548_restore_entry_refusal_first_r8restore.sql'),
  'utf8',
).split('--> statement-breakpoint');

const ENTRY_POINTS = [
  'lifecycle.requalify_archive_restore_debt(uuid,uuid,text)',
  'lifecycle.archive_restore_requalification_key(uuid,uuid)',
  'lifecycle.requalify_raw_restore_org()',
  'lifecycle.raw_restore_survivor_delete_target(uuid,uuid)',
] as const;

describe('restore entry points open with their refusal (0548)', () => {
  let migrator: pg.Client;
  beforeAll(async () => {
    migrator = new pg.Client({ connectionString: urls.migrator() });
    await migrator.connect();
  });
  afterAll(async () => {
    await migrator?.end();
  });

  /**
   * Redefines one entry point with `change` applied to its current definition, then runs 0548, all in
   * one transaction that is rolled back. Answers what 0548 raised, or null when it passed.
   */
  const check = async (signature: string, change?: (definition: string) => string) => {
    await migrator.query('begin');
    try {
      if (change) {
        const { rows } = await migrator.query<{ definition: string }>(
          'select pg_get_functiondef($1::regprocedure) definition',
          [signature],
        );
        const changed = change(rows[0]!.definition);
        expect(changed).not.toBe(rows[0]!.definition);
        await migrator.query(changed);
      }
      for (const statement of migration) await migrator.query(statement);
      return null;
    } catch (error) {
      const { code, message, detail } = error as {
        code?: string;
        message?: string;
        detail?: string;
      };
      return { code, message, detail };
    } finally {
      await migrator.query('rollback');
    }
  };
  const refused = (signature: string) => ({
    code: 'EN850',
    message: 'RESTORE_ENTRY_REFUSAL_FIRST_POSTCONDITION',
    detail: signature,
  });

  it('passes on the migrated database, where every entry point opens with its refusal', async () => {
    expect(await check(ENTRY_POINTS[0])).toBeNull();
  });

  it.each(ENTRY_POINTS)('fails when %s runs a statement before its refusal', async (signature) => {
    expect(
      await check(signature, (definition) =>
        definition.replace(/\r?\nBEGIN\r?\n/, '\nBEGIN\n PERFORM 1;\n'),
      ),
    ).toEqual(refused(signature));
  });

  it('still passes when only the layout around the refusal changes', async () => {
    expect(
      await check(ENTRY_POINTS[2], (definition) =>
        definition.replace(/\r?\nBEGIN\r?\n/, '\nBEGIN\n\n  '),
      ),
    ).toBeNull();
  });

  it.each([
    [
      'a DECLARE initializer with an effect',
      (definition: string) =>
        definition.replace(
          'tenant uuid:=app.current_organization_id();',
          "tenant uuid:=app.current_organization_id();probe text:=set_config('app.generated_probe','1',true);",
        ),
    ],
    [
      'a refusal raised with another code',
      (definition: string) =>
        definition.replace("USING ERRCODE='42501';END IF;", "USING ERRCODE='EN850';END IF;"),
    ],
    [
      'a refusal that no longer requires the service actor',
      (definition: string) => definition.replace(' OR NOT knowledge.is_service_actor()', ''),
    ],
    [
      'a refusal widened by another condition',
      (definition: string) =>
        definition.replace(' OR tenant IS NULL', ' OR tenant IS NULL OR random()<0'),
    ],
    [
      'a function that is no longer SECURITY DEFINER',
      (definition: string) => definition.replace('SECURITY DEFINER', 'SECURITY INVOKER'),
    ],
  ])('fails on %s', async (_name, change) => {
    expect(await check(ENTRY_POINTS[3], change)).toEqual(refused(ENTRY_POINTS[3]));
  });
});
