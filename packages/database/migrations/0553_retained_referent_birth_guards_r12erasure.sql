-- REVIEWED SECURITY SQL (ADR-032 D7). Changes here need human review, never agent approval.
-- FLAGGED FOR HUMAN SECURITY REVIEW (ADR-032 D7), not yet reviewed by a person
-- Written by an agent in CI repair round 12 (A-db-0553-retained-referent-birth-guards group, check
-- finding 1).
--
-- 0553 (r12 erasure retained referent birth guards): additive. 0552 is registered, pushed and applied in
-- CI, so it is not edited. Renumbered at merge if another 0553 lands first.
--
-- Check finding 1: 0552 dropped nineteen NO ACTION FKs from retained evidence (LIFE-04) into tables the
-- eraser empties, so that erasure can finish. With them went the only database check that such a row
-- names, at birth, a referent that exists in its own tenant: since 0552 a role that holds INSERT
-- (ensemus_agent on usage, reservations and egress; ensemus_app on budgets, kill switches and policy
-- bundles) can write any UUID there. 0553 restores that birth check, and not the lifetime claim the FK
-- also made:
--   * one BEFORE INSERT ... FOR EACH ROW trigger per dropped column. It refuses a non-null UUID that
--     names no row of the column's target table with the same organization_id at that moment:
--     RETAINED_REFERENT_MISSING, ERRCODE EN423, DETAIL the column (never a value). A row with no
--     organization_id (an operator's kill switch) that names a referent is refused too: no tenant row
--     can be named without its tenant.
--   * one BEFORE UPDATE OF <column>, organization_id trigger per column where the table can be updated
--     at all: budget_reservations, budgets, kill_switches and policy_bundles. usage_ledger and
--     egress_decisions refuse every UPDATE (0101's append-only statement triggers, re-checked by 0552),
--     so they get the INSERT trigger only. Of the updatable columns only
--     kill_switches.released_by_membership_id is granted to a runtime role (ensemus_app, 0101, the
--     release path); the others are reachable only by the table owner, and no guard refuses that
--     (0101's check_kill_switch_change does not cover engaged_by_membership_id). An UPDATE that keeps both
--     the referent and the organization as they were is not checked again, so a retained row whose
--     referent has since been erased can still have its other columns updated.
--   * nothing on DELETE, and nothing on the referenced tables. The eraser deletes runs, steps, jobs,
--     calls, profiles, rate cards, Work, agent versions and memberships exactly as since 0552, the
--     retained rows keep their historical UUIDs, and tenant erasure still finishes (leftOver [],
--     tests/integration/agent-delegated-offboarding.test.ts L6/L8b).
--
-- How the check reads the referent. The nine referenced tables are forced-RLS, and their tenant policies
-- are TO ensemus_app, so the check runs as their owner: lifecycle.require_retained_referent() is SECURITY
-- DEFINER, owned by ensemus_migrator (neither superuser nor BYPASSRLS), with search_path pinned to
-- pg_catalog, pg_temp and EXECUTE revoked from PUBLIC (a trigger needs no EXECUTE to fire). Under forced
-- RLS the owner sees only rows its own policies admit, so each referenced table gets one permissive
-- SELECT policy for ensemus_migrator, retained_referent_birth_probe, that admits exactly one row: the one
-- whose organization_id and id equal the transaction-local selectors lifecycle.retained_referent_org and
-- lifecycle.retained_referent_id, and only while a trigger runs (pg_trigger_depth()>0). The function sets
-- both, reads one EXISTS keyed by (organization_id,id) (unique on every target, as the dropped FK
-- required), and clears both; the SET clause of the function also restores every setting it changed at
-- exit. The policy compares text and never casts a selector, so a malformed selector cannot raise in
-- another reader's query. There is no UPDATE policy: the check takes no row lock.
--
-- Reviewer notes:
--   * Unlike the FK, the check takes no KEY SHARE lock, so it proves the referent at birth and not until
--     commit. A delete of the referent that commits between the check and the insert's commit leaves the
--     same historical UUID that erasure leaves by design (0552). Every writer runs READ COMMITTED.
--   * A session that sets both selectors itself makes one row, whose tenant and id it must already know,
--     visible to migrator-owned SECURITY DEFINER readers of those nine tables, and only inside a trigger.
--     Every such reader still applies its own predicates. Same shape as the selector-keyed migrator
--     policies of 0408, 0415 and 0419.
--   * pg_restore loads data before it creates triggers and policies (post-data), so a sovereign restore of
--     evidence whose referents were erased is not refused by these triggers.
--   * The trigger names start with aa_. PostgreSQL fires BEFORE ROW triggers in name order, so the
--     existence refusal comes before any other guard on these tables reads the referent (refusal-first).
--     The function has no other effect.
--   * setBudget (packages/application/src/ai/budget.ts) keeps its own agent-version check from 0552 as a
--     second guard; this trigger is now the primary one.
DO $prerequisite$
DECLARE reviewed record;
BEGIN
 IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND(rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'RETAINED_REFERENT_BIRTH_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 IF to_regprocedure('lifecycle.retained_table(text,text)') IS NULL
  OR to_regprocedure('lifecycle.require_retained_referent()') IS NOT NULL THEN
  RAISE EXCEPTION 'RETAINED_REFERENT_BIRTH_PREREQUISITE' USING ERRCODE='EN850',DETAIL='lifecycle.require_retained_referent()';END IF;
 -- The nineteen columns 0552 dropped an FK from, with the table each FK referenced (0552's reviewed list).
 FOR reviewed IN SELECT * FROM(VALUES
  ('platform.budget_reservations','run_id','ai.agent_runs'),
  ('platform.budget_reservations','step_id','ai.execution_steps'),
  ('platform.budget_reservations','model_job_id','ai.model_jobs'),
  ('platform.budget_reservations','model_call_id','ai.model_call_attempts'),
  ('platform.budgets','agent_version_id','ai.agent_versions'),
  ('platform.budgets','created_by_membership_id','org.memberships'),
  ('platform.usage_ledger','rate_card_id','ai.rate_cards'),
  ('platform.usage_ledger','work_unit_id','work.work_units'),
  ('platform.usage_ledger','run_id','ai.agent_runs'),
  ('platform.usage_ledger','step_id','ai.execution_steps'),
  ('platform.usage_ledger','profile_id','ai.model_profiles'),
  ('platform.usage_ledger','model_job_id','ai.model_jobs'),
  ('platform.usage_ledger','model_call_id','ai.model_call_attempts'),
  ('governance.egress_decisions','run_id','ai.agent_runs'),
  ('governance.egress_decisions','step_id','ai.execution_steps'),
  ('governance.egress_decisions','profile_id','ai.model_profiles'),
  ('governance.kill_switches','engaged_by_membership_id','org.memberships'),
  ('governance.kill_switches','released_by_membership_id','org.memberships'),
  ('governance.policy_bundles','created_by_membership_id','org.memberships')
 ) AS r(table_ref,column_name,target_ref) LOOP
  IF to_regclass(reviewed.table_ref) IS NULL OR to_regclass(reviewed.target_ref) IS NULL
   OR lifecycle.retained_table(split_part(reviewed.table_ref,'.',1),split_part(reviewed.table_ref,'.',2)) IS DISTINCT FROM true
   OR lifecycle.retained_table(split_part(reviewed.target_ref,'.',1),split_part(reviewed.target_ref,'.',2)) IS DISTINCT FROM false
   -- The historical column and the row's tenant, as 0552 left them.
   OR NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass(reviewed.table_ref) AND a.attname=reviewed.column_name
    AND NOT a.attisdropped AND a.atttypid='uuid'::regtype)
   OR NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass(reviewed.table_ref) AND a.attname='organization_id'
    AND NOT a.attisdropped AND a.atttypid='uuid'::regtype)
   -- 0552 applied: no FK from the retained table into the target remains.
   OR EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass(reviewed.table_ref) AND c.contype='f'
    AND c.confrelid=to_regclass(reviewed.target_ref))
   -- The target is keyed by (organization_id,id), as the dropped FK referenced it, so the probe names one row.
   OR NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=to_regclass(reviewed.target_ref) AND i.indisunique AND i.indisvalid
    AND i.indpred IS NULL AND i.indexprs IS NULL AND i.indnatts=2
    AND(SELECT array_agg(a.attname::text ORDER BY a.attname) FROM unnest(i.indkey::int2[]) k(attnum)
     JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum)=ARRAY['id','organization_id'])
   -- Owned by the migrator, so the probe policy below can be created and is the owner's own.
   OR NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass(reviewed.target_ref) AND c.relowner='ensemus_migrator'::regrole::oid)
   OR NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass(reviewed.table_ref) AND c.relowner='ensemus_migrator'::regrole::oid)
   OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=to_regclass(reviewed.target_ref) AND p.polname='retained_referent_birth_probe')
   OR EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass(reviewed.table_ref)
    AND t.tgname IN('aa_retained_referent_birth_'||reviewed.column_name,'aa_retained_referent_change_'||reviewed.column_name)) THEN
   RAISE EXCEPTION 'RETAINED_REFERENT_BIRTH_PREREQUISITE' USING ERRCODE='EN850',
    DETAIL=reviewed.table_ref||'.'||reviewed.column_name||' -> '||reviewed.target_ref;END IF;
 END LOOP;
END $prerequisite$;
--> statement-breakpoint
-- TG_ARGV: the column, then the target's schema and table. Refusal-first: a call outside a BEFORE ROW
-- INSERT or UPDATE trigger, or naming a column the row does not have, is refused before anything is read.
CREATE FUNCTION lifecycle.require_retained_referent() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp AS $guard$
DECLARE referent uuid;present boolean:=false;
BEGIN
 IF TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_OP NOT IN('INSERT','UPDATE') OR TG_NARGS<>3
  OR NOT(pg_catalog.to_jsonb(NEW) ? TG_ARGV[0]) THEN
  RAISE EXCEPTION 'RETAINED_REFERENT_GUARD_MISUSE' USING ERRCODE='42501';END IF;
 referent:=(pg_catalog.to_jsonb(NEW)->>TG_ARGV[0])::uuid;
 IF referent IS NULL THEN RETURN NEW;END IF;
 IF TG_OP='UPDATE' THEN
  IF referent IS NOT DISTINCT FROM (pg_catalog.to_jsonb(OLD)->>TG_ARGV[0])::uuid
   AND NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id THEN RETURN NEW;END IF;
 END IF;
 IF NEW.organization_id IS NOT NULL THEN
  PERFORM pg_catalog.set_config('lifecycle.retained_referent_org',NEW.organization_id::text,true);
  PERFORM pg_catalog.set_config('lifecycle.retained_referent_id',referent::text,true);
  EXECUTE pg_catalog.format('SELECT EXISTS(SELECT 1 FROM %I.%I r WHERE r.organization_id=$1 AND r.id=$2)',TG_ARGV[1],TG_ARGV[2])
   INTO present USING NEW.organization_id,referent;
  PERFORM pg_catalog.set_config('lifecycle.retained_referent_id','',true);
  PERFORM pg_catalog.set_config('lifecycle.retained_referent_org','',true);
 END IF;
 IF present IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'RETAINED_REFERENT_MISSING' USING ERRCODE='EN423',
   DETAIL=TG_TABLE_SCHEMA||'.'||TG_TABLE_NAME||'.'||TG_ARGV[0];END IF;
 RETURN NEW;
END $guard$;
REVOKE ALL ON FUNCTION lifecycle.require_retained_referent() FROM PUBLIC;
--> statement-breakpoint
-- One row, by its tenant and id, only while a trigger runs and both selectors name it.
CREATE POLICY retained_referent_birth_probe ON ai.agent_runs FOR SELECT TO ensemus_migrator USING(pg_catalog.pg_trigger_depth()>0
 AND organization_id::text=pg_catalog.current_setting('lifecycle.retained_referent_org',true) AND id::text=pg_catalog.current_setting('lifecycle.retained_referent_id',true));
CREATE POLICY retained_referent_birth_probe ON ai.execution_steps FOR SELECT TO ensemus_migrator USING(pg_catalog.pg_trigger_depth()>0
 AND organization_id::text=pg_catalog.current_setting('lifecycle.retained_referent_org',true) AND id::text=pg_catalog.current_setting('lifecycle.retained_referent_id',true));
CREATE POLICY retained_referent_birth_probe ON ai.model_jobs FOR SELECT TO ensemus_migrator USING(pg_catalog.pg_trigger_depth()>0
 AND organization_id::text=pg_catalog.current_setting('lifecycle.retained_referent_org',true) AND id::text=pg_catalog.current_setting('lifecycle.retained_referent_id',true));
CREATE POLICY retained_referent_birth_probe ON ai.model_call_attempts FOR SELECT TO ensemus_migrator USING(pg_catalog.pg_trigger_depth()>0
 AND organization_id::text=pg_catalog.current_setting('lifecycle.retained_referent_org',true) AND id::text=pg_catalog.current_setting('lifecycle.retained_referent_id',true));
CREATE POLICY retained_referent_birth_probe ON ai.agent_versions FOR SELECT TO ensemus_migrator USING(pg_catalog.pg_trigger_depth()>0
 AND organization_id::text=pg_catalog.current_setting('lifecycle.retained_referent_org',true) AND id::text=pg_catalog.current_setting('lifecycle.retained_referent_id',true));
CREATE POLICY retained_referent_birth_probe ON ai.rate_cards FOR SELECT TO ensemus_migrator USING(pg_catalog.pg_trigger_depth()>0
 AND organization_id::text=pg_catalog.current_setting('lifecycle.retained_referent_org',true) AND id::text=pg_catalog.current_setting('lifecycle.retained_referent_id',true));
CREATE POLICY retained_referent_birth_probe ON ai.model_profiles FOR SELECT TO ensemus_migrator USING(pg_catalog.pg_trigger_depth()>0
 AND organization_id::text=pg_catalog.current_setting('lifecycle.retained_referent_org',true) AND id::text=pg_catalog.current_setting('lifecycle.retained_referent_id',true));
CREATE POLICY retained_referent_birth_probe ON work.work_units FOR SELECT TO ensemus_migrator USING(pg_catalog.pg_trigger_depth()>0
 AND organization_id::text=pg_catalog.current_setting('lifecycle.retained_referent_org',true) AND id::text=pg_catalog.current_setting('lifecycle.retained_referent_id',true));
CREATE POLICY retained_referent_birth_probe ON org.memberships FOR SELECT TO ensemus_migrator USING(pg_catalog.pg_trigger_depth()>0
 AND organization_id::text=pg_catalog.current_setting('lifecycle.retained_referent_org',true) AND id::text=pg_catalog.current_setting('lifecycle.retained_referent_id',true));
--> statement-breakpoint
-- Birth: every one of the nineteen columns.
CREATE TRIGGER aa_retained_referent_birth_run_id BEFORE INSERT ON platform.budget_reservations FOR EACH ROW EXECUTE FUNCTION lifecycle.require_retained_referent('run_id','ai','agent_runs');
CREATE TRIGGER aa_retained_referent_birth_step_id BEFORE INSERT ON platform.budget_reservations FOR EACH ROW EXECUTE FUNCTION lifecycle.require_retained_referent('step_id','ai','execution_steps');
CREATE TRIGGER aa_retained_referent_birth_model_job_id BEFORE INSERT ON platform.budget_reservations FOR EACH ROW EXECUTE FUNCTION lifecycle.require_retained_referent('model_job_id','ai','model_jobs');
CREATE TRIGGER aa_retained_referent_birth_model_call_id BEFORE INSERT ON platform.budget_reservations FOR EACH ROW EXECUTE FUNCTION lifecycle.require_retained_referent('model_call_id','ai','model_call_attempts');
CREATE TRIGGER aa_retained_referent_birth_agent_version_id BEFORE INSERT ON platform.budgets FOR EACH ROW EXECUTE FUNCTION lifecycle.require_retained_referent('agent_version_id','ai','agent_versions');
CREATE TRIGGER aa_retained_referent_birth_created_by_membership_id BEFORE INSERT ON platform.budgets FOR EACH ROW EXECUTE FUNCTION lifecycle.require_retained_referent('created_by_membership_id','org','memberships');
CREATE TRIGGER aa_retained_referent_birth_rate_card_id BEFORE INSERT ON platform.usage_ledger FOR EACH ROW EXECUTE FUNCTION lifecycle.require_retained_referent('rate_card_id','ai','rate_cards');
CREATE TRIGGER aa_retained_referent_birth_work_unit_id BEFORE INSERT ON platform.usage_ledger FOR EACH ROW EXECUTE FUNCTION lifecycle.require_retained_referent('work_unit_id','work','work_units');
CREATE TRIGGER aa_retained_referent_birth_run_id BEFORE INSERT ON platform.usage_ledger FOR EACH ROW EXECUTE FUNCTION lifecycle.require_retained_referent('run_id','ai','agent_runs');
CREATE TRIGGER aa_retained_referent_birth_step_id BEFORE INSERT ON platform.usage_ledger FOR EACH ROW EXECUTE FUNCTION lifecycle.require_retained_referent('step_id','ai','execution_steps');
CREATE TRIGGER aa_retained_referent_birth_profile_id BEFORE INSERT ON platform.usage_ledger FOR EACH ROW EXECUTE FUNCTION lifecycle.require_retained_referent('profile_id','ai','model_profiles');
CREATE TRIGGER aa_retained_referent_birth_model_job_id BEFORE INSERT ON platform.usage_ledger FOR EACH ROW EXECUTE FUNCTION lifecycle.require_retained_referent('model_job_id','ai','model_jobs');
CREATE TRIGGER aa_retained_referent_birth_model_call_id BEFORE INSERT ON platform.usage_ledger FOR EACH ROW EXECUTE FUNCTION lifecycle.require_retained_referent('model_call_id','ai','model_call_attempts');
CREATE TRIGGER aa_retained_referent_birth_run_id BEFORE INSERT ON governance.egress_decisions FOR EACH ROW EXECUTE FUNCTION lifecycle.require_retained_referent('run_id','ai','agent_runs');
CREATE TRIGGER aa_retained_referent_birth_step_id BEFORE INSERT ON governance.egress_decisions FOR EACH ROW EXECUTE FUNCTION lifecycle.require_retained_referent('step_id','ai','execution_steps');
CREATE TRIGGER aa_retained_referent_birth_profile_id BEFORE INSERT ON governance.egress_decisions FOR EACH ROW EXECUTE FUNCTION lifecycle.require_retained_referent('profile_id','ai','model_profiles');
CREATE TRIGGER aa_retained_referent_birth_engaged_by_membership_id BEFORE INSERT ON governance.kill_switches FOR EACH ROW EXECUTE FUNCTION lifecycle.require_retained_referent('engaged_by_membership_id','org','memberships');
CREATE TRIGGER aa_retained_referent_birth_released_by_membership_id BEFORE INSERT ON governance.kill_switches FOR EACH ROW EXECUTE FUNCTION lifecycle.require_retained_referent('released_by_membership_id','org','memberships');
CREATE TRIGGER aa_retained_referent_birth_created_by_membership_id BEFORE INSERT ON governance.policy_bundles FOR EACH ROW EXECUTE FUNCTION lifecycle.require_retained_referent('created_by_membership_id','org','memberships');
-- A changed referent, or a changed tenant, on the four tables that can be updated at all.
CREATE TRIGGER aa_retained_referent_change_run_id BEFORE UPDATE OF run_id,organization_id ON platform.budget_reservations FOR EACH ROW EXECUTE FUNCTION lifecycle.require_retained_referent('run_id','ai','agent_runs');
CREATE TRIGGER aa_retained_referent_change_step_id BEFORE UPDATE OF step_id,organization_id ON platform.budget_reservations FOR EACH ROW EXECUTE FUNCTION lifecycle.require_retained_referent('step_id','ai','execution_steps');
CREATE TRIGGER aa_retained_referent_change_model_job_id BEFORE UPDATE OF model_job_id,organization_id ON platform.budget_reservations FOR EACH ROW EXECUTE FUNCTION lifecycle.require_retained_referent('model_job_id','ai','model_jobs');
CREATE TRIGGER aa_retained_referent_change_model_call_id BEFORE UPDATE OF model_call_id,organization_id ON platform.budget_reservations FOR EACH ROW EXECUTE FUNCTION lifecycle.require_retained_referent('model_call_id','ai','model_call_attempts');
CREATE TRIGGER aa_retained_referent_change_agent_version_id BEFORE UPDATE OF agent_version_id,organization_id ON platform.budgets FOR EACH ROW EXECUTE FUNCTION lifecycle.require_retained_referent('agent_version_id','ai','agent_versions');
CREATE TRIGGER aa_retained_referent_change_created_by_membership_id BEFORE UPDATE OF created_by_membership_id,organization_id ON platform.budgets FOR EACH ROW EXECUTE FUNCTION lifecycle.require_retained_referent('created_by_membership_id','org','memberships');
CREATE TRIGGER aa_retained_referent_change_engaged_by_membership_id BEFORE UPDATE OF engaged_by_membership_id,organization_id ON governance.kill_switches FOR EACH ROW EXECUTE FUNCTION lifecycle.require_retained_referent('engaged_by_membership_id','org','memberships');
CREATE TRIGGER aa_retained_referent_change_released_by_membership_id BEFORE UPDATE OF released_by_membership_id,organization_id ON governance.kill_switches FOR EACH ROW EXECUTE FUNCTION lifecycle.require_retained_referent('released_by_membership_id','org','memberships');
CREATE TRIGGER aa_retained_referent_change_created_by_membership_id BEFORE UPDATE OF created_by_membership_id,organization_id ON governance.policy_bundles FOR EACH ROW EXECUTE FUNCTION lifecycle.require_retained_referent('created_by_membership_id','org','memberships');
--> statement-breakpoint
-- Postconditions. Every one of the nineteen columns has its enabled BEFORE INSERT ROW trigger, with no
-- WHEN clause and no DELETE, UPDATE or TRUNCATE event, on the reviewed function with the reviewed
-- arguments; the nine updatable ones also have their BEFORE UPDATE OF trigger; the function has no other
-- trigger anywhere; it is SECURITY DEFINER, owned by the migrator (still neither superuser nor BYPASSRLS),
-- with search_path pinned to pg_catalog, pg_temp and no EXECUTE for anyone but its owner; each referenced
-- table has the one-row probe policy and nothing broader under that name; and the retained and erasable
-- sides are as 0552 left them. The DETAIL names only what failed, never a tenant or a value.
DO $review$
DECLARE expected record;guard oid:=to_regprocedure('lifecycle.require_retained_referent()');qual text;
BEGIN
 IF guard IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
   WHERE p.oid=guard AND l.lanname='plpgsql' AND p.prosecdef AND p.provolatile='v' AND p.pronargs=0
    AND p.prorettype='trigger'::regtype AND p.proowner='ensemus_migrator'::regrole::oid
    AND cardinality(p.proconfig)=1 AND replace(p.proconfig[1],' ','')='search_path=pg_catalog,pg_temp')
  OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   WHERE p.oid=guard AND a.grantee<>p.proowner)
  OR EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname='ensemus_migrator' AND(r.rolsuper OR r.rolbypassrls)) THEN
  RAISE EXCEPTION 'RETAINED_REFERENT_BIRTH_POSTCONDITION' USING ERRCODE='EN850',DETAIL='lifecycle.require_retained_referent()';END IF;
 FOR expected IN SELECT * FROM(VALUES
  ('platform.budget_reservations','run_id','ai','agent_runs',true),
  ('platform.budget_reservations','step_id','ai','execution_steps',true),
  ('platform.budget_reservations','model_job_id','ai','model_jobs',true),
  ('platform.budget_reservations','model_call_id','ai','model_call_attempts',true),
  ('platform.budgets','agent_version_id','ai','agent_versions',true),
  ('platform.budgets','created_by_membership_id','org','memberships',true),
  ('platform.usage_ledger','rate_card_id','ai','rate_cards',false),
  ('platform.usage_ledger','work_unit_id','work','work_units',false),
  ('platform.usage_ledger','run_id','ai','agent_runs',false),
  ('platform.usage_ledger','step_id','ai','execution_steps',false),
  ('platform.usage_ledger','profile_id','ai','model_profiles',false),
  ('platform.usage_ledger','model_job_id','ai','model_jobs',false),
  ('platform.usage_ledger','model_call_id','ai','model_call_attempts',false),
  ('governance.egress_decisions','run_id','ai','agent_runs',false),
  ('governance.egress_decisions','step_id','ai','execution_steps',false),
  ('governance.egress_decisions','profile_id','ai','model_profiles',false),
  ('governance.kill_switches','engaged_by_membership_id','org','memberships',true),
  ('governance.kill_switches','released_by_membership_id','org','memberships',true),
  ('governance.policy_bundles','created_by_membership_id','org','memberships',true)
 ) AS r(table_ref,column_name,target_schema,target_table,updatable) LOOP
  IF lifecycle.retained_table(split_part(expected.table_ref,'.',1),split_part(expected.table_ref,'.',2)) IS DISTINCT FROM true
   OR lifecycle.retained_table(expected.target_schema,expected.target_table) IS DISTINCT FROM false
   OR NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass(expected.table_ref)
    AND t.tgname='aa_retained_referent_birth_'||expected.column_name AND t.tgfoid=guard
    AND t.tgenabled IN('O','A') AND NOT t.tgisinternal AND t.tgqual IS NULL AND cardinality(t.tgattr::int2[])=0
    -- ROW (1), BEFORE (2) and INSERT (4) only: not DELETE (8), UPDATE (16), TRUNCATE (32) or INSTEAD (64).
    AND (t.tgtype::integer&127)=(1|2|4)
    AND t.tgnargs=3 AND t.tgargs=convert_to(expected.column_name,'UTF8')||decode('00','hex')
     ||convert_to(expected.target_schema,'UTF8')||decode('00','hex')||convert_to(expected.target_table,'UTF8')||decode('00','hex')) THEN
   RAISE EXCEPTION 'RETAINED_REFERENT_BIRTH_POSTCONDITION' USING ERRCODE='EN850',
    DETAIL=expected.table_ref||' aa_retained_referent_birth_'||expected.column_name;END IF;
  IF expected.updatable AND NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass(expected.table_ref)
    AND t.tgname='aa_retained_referent_change_'||expected.column_name AND t.tgfoid=guard
    AND t.tgenabled IN('O','A') AND NOT t.tgisinternal AND t.tgqual IS NULL
    -- ROW (1), BEFORE (2) and UPDATE (16) only, OF exactly the column and organization_id.
    AND (t.tgtype::integer&127)=(1|2|16)
    AND(SELECT array_agg(a.attname::text ORDER BY a.attname) FROM unnest(t.tgattr::int2[]) k(attnum)
     JOIN pg_attribute a ON a.attrelid=t.tgrelid AND a.attnum=k.attnum)
     =(SELECT array_agg(n ORDER BY n) FROM unnest(ARRAY[expected.column_name,'organization_id']) n)
    AND t.tgnargs=3 AND t.tgargs=convert_to(expected.column_name,'UTF8')||decode('00','hex')
     ||convert_to(expected.target_schema,'UTF8')||decode('00','hex')||convert_to(expected.target_table,'UTF8')||decode('00','hex')) THEN
   RAISE EXCEPTION 'RETAINED_REFERENT_BIRTH_POSTCONDITION' USING ERRCODE='EN850',
    DETAIL=expected.table_ref||' aa_retained_referent_change_'||expected.column_name;END IF;
  -- The probe: SELECT only, for the migrator only, and the one-row predicate with nothing ORed into it.
  SELECT pg_get_expr(p.polqual,p.polrelid) INTO qual FROM pg_policy p
   WHERE p.polrelid=to_regclass(expected.target_schema||'.'||expected.target_table) AND p.polname='retained_referent_birth_probe'
    AND p.polcmd='r' AND p.polpermissive AND p.polroles=ARRAY['ensemus_migrator'::regrole::oid] AND p.polwithcheck IS NULL;
  IF qual IS NULL OR qual~*'\mOR\M' OR strpos(qual,'pg_trigger_depth() > 0')=0
   OR strpos(qual,'current_setting(''lifecycle.retained_referent_org''')=0
   OR strpos(qual,'current_setting(''lifecycle.retained_referent_id''')=0 THEN
   RAISE EXCEPTION 'RETAINED_REFERENT_BIRTH_POSTCONDITION' USING ERRCODE='EN850',
    DETAIL=expected.target_schema||'.'||expected.target_table||' retained_referent_birth_probe';END IF;
 END LOOP;
 -- Nineteen birth triggers and nine change triggers, and none anywhere else (no DELETE path at all).
 IF(SELECT count(*) FROM pg_trigger t WHERE t.tgfoid=guard)<>28 THEN
  RAISE EXCEPTION 'RETAINED_REFERENT_BIRTH_POSTCONDITION' USING ERRCODE='EN850',DETAIL='lifecycle.require_retained_referent() triggers';END IF;
END $review$;
