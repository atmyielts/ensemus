-- REVIEWED SECURITY SQL (ADR-032 D7). Changes here need human review, never agent approval.
-- FLAGGED FOR HUMAN SECURITY REVIEW (ADR-032 D7), not yet reviewed by a person
-- Written by an agent in CI repair round 11 (erasure-retained-fks-0552 group, findings 1 and 10).
--
-- 0552 (r11 erasure retained referents): additive. 0100, 0101, 0216, 0501, 0508, 0511, 0516, 0518 and
-- 0548-0551 are registered and pushed, so none of them is edited. Renumbered at merge if another 0552
-- lands first.
--
-- Finding 1 (product bug, reproduced by tests/integration/agent-delegated-offboarding.test.ts, L6/L8b):
-- lifecycle.retained_table (0501, wrapped by 0516) keeps every platform table except notifications and
-- idempotency_keys, and all of governance, through erasure (LIFE-04: billing, usage and audit evidence
-- survive the tenant). Nineteen NO ACTION foreign keys from those retained tables point INTO tables the
-- eraser must empty (ai, org, work). The eraser (packages/database/src/eraser.ts) treats 23503 as
-- "try again next pass", so a tenant whose agent reserved and spent budget could never be erased: the
-- retained usage_ledger/budget_reservations/egress_decisions rows pinned ai.agent_runs, ai.execution_steps,
-- ai.model_profiles and ai.rate_cards; platform.budgets pinned ai.agent_versions and org.memberships;
-- governance.kill_switches and governance.policy_bundles pinned org.memberships; and through those
-- rows ai.agent_definitions, org.service_identities, work.work_units and (still alive)
-- knowledge.structured_record_catalog stayed too. The report then held ROWS_REMAIN and never verified.
--
-- A retained row references its run, step, profile, rate card, work, agent version and people AT
-- BIRTH, as historical attribution; it is not a lifetime claim on their bodies. This is the 0518 rule
-- for historical payment referents applied to usage evidence. 0552 drops exactly the nineteen FKs
-- below, enumerated from pg_constraint as every FK whose table is retained and whose referenced table
-- is a tenant table the eraser empties. It keeps:
--   * every historical UUID column and value (nothing is rewritten, nulled or deleted);
--   * every FK between retained tables (budget_reservations->budgets, usage_ledger->budget_reservations,
--     usage_ledger.corrects_id->usage_ledger, lifecycle stops->kill_switches, billing among itself);
--   * every FK to org.organizations;
--   * every native or append-only guard on these tables (checked below), every grant and policy.
-- No retained->erasable FK is needed: none is read by a guard as proof of anything after birth. At
-- birth the writers are the native paths that already hold the referent: the agent's own run/step under
-- 0214/0414/0417/0216 admission guards (which read the run, call, budget and rate card themselves), and
-- for platform.budgets the application now checks the agent version under RLS before inserting, as
-- engageKillSwitch already did (packages/application/src/ai/budget.ts). Reviewer note: a direct INSERT by
-- a role that holds INSERT on these tables can now name a UUID that has no live row in its own tenant;
-- RLS still confines it to its own tenant and no authority is derived from such a UUID.
--
-- Finding 10: 0551's postcondition no longer re-checked 0550's lifecycle.raw_active_source_requalifications.
-- The last statement re-checks it here: forced RLS, the single migrator policy, no runtime-role table or
-- column privilege of any kind and no PUBLIC grant, retained (not erasable), and its append-only trigger.
DO $review$
DECLARE reviewed record;keys text[]:='{}';unreviewed text;
BEGIN
 IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND(rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'RETAINED_REFERENT_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 FOR reviewed IN SELECT * FROM(VALUES
  ('platform.budget_reservations','budget_reservations_organization_id_run_id_agent_runs_organizat','ai.agent_runs','{organization_id,run_id}'),
  ('platform.budget_reservations','budget_reservations_organization_id_step_id_execution_steps_org','ai.execution_steps','{organization_id,step_id}'),
  ('platform.budget_reservations','budget_reservations_model_job_fk','ai.model_jobs','{organization_id,model_job_id}'),
  ('platform.budget_reservations','budget_reservations_model_call_fk','ai.model_call_attempts','{organization_id,model_call_id}'),
  ('platform.budgets','budgets_organization_id_agent_version_id_agent_versions_organiz','ai.agent_versions','{organization_id,agent_version_id}'),
  ('platform.budgets','budgets_organization_id_created_by_membership_id_memberships_or','org.memberships','{organization_id,created_by_membership_id}'),
  ('platform.usage_ledger','usage_ledger_organization_id_rate_card_id_rate_cards_organizati','ai.rate_cards','{organization_id,rate_card_id}'),
  ('platform.usage_ledger','usage_ledger_organization_id_work_unit_id_work_units_organizati','work.work_units','{organization_id,work_unit_id}'),
  ('platform.usage_ledger','usage_ledger_organization_id_run_id_agent_runs_organization_id_','ai.agent_runs','{organization_id,run_id}'),
  ('platform.usage_ledger','usage_ledger_organization_id_step_id_execution_steps_organizati','ai.execution_steps','{organization_id,step_id}'),
  ('platform.usage_ledger','usage_ledger_organization_id_profile_id_model_profiles_organiza','ai.model_profiles','{organization_id,profile_id}'),
  ('platform.usage_ledger','usage_ledger_model_job_fk','ai.model_jobs','{organization_id,model_job_id}'),
  ('platform.usage_ledger','usage_ledger_model_call_fk','ai.model_call_attempts','{organization_id,model_call_id}'),
  ('governance.egress_decisions','egress_decisions_organization_id_run_id_agent_runs_organization','ai.agent_runs','{organization_id,run_id}'),
  ('governance.egress_decisions','egress_decisions_organization_id_step_id_execution_steps_organi','ai.execution_steps','{organization_id,step_id}'),
  ('governance.egress_decisions','egress_decisions_organization_id_profile_id_model_profiles_orga','ai.model_profiles','{organization_id,profile_id}'),
  ('governance.kill_switches','kill_switches_organization_id_engaged_by_membership_id_membersh','org.memberships','{organization_id,engaged_by_membership_id}'),
  ('governance.kill_switches','kill_switches_organization_id_released_by_membership_id_members','org.memberships','{organization_id,released_by_membership_id}'),
  ('governance.policy_bundles','policy_bundles_organization_id_created_by_membership_id_members','org.memberships','{organization_id,created_by_membership_id}')
 ) AS r(table_ref,constraint_name,target_ref,columns) LOOP
  IF to_regclass(reviewed.table_ref) IS NULL OR to_regclass(reviewed.target_ref) IS NULL
   OR lifecycle.retained_table(split_part(reviewed.table_ref,'.',1),split_part(reviewed.table_ref,'.',2)) IS DISTINCT FROM true
   OR lifecycle.retained_table(split_part(reviewed.target_ref,'.',1),split_part(reviewed.target_ref,'.',2)) IS DISTINCT FROM false
   OR NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conname=reviewed.constraint_name AND c.contype='f'
    AND c.conrelid=to_regclass(reviewed.table_ref) AND c.confrelid=to_regclass(reviewed.target_ref)
    AND(SELECT array_agg(a.attname::text ORDER BY k.n) FROM unnest(c.conkey) WITH ORDINALITY k(attnum,n)
     JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum)=reviewed.columns::text[]) THEN
   RAISE EXCEPTION 'RETAINED_REFERENT_SCHEMA_UNREVIEWED' USING ERRCODE='EN850',
    DETAIL=reviewed.table_ref||' '||reviewed.constraint_name||' -> '||reviewed.target_ref;END IF;
  keys:=keys||(reviewed.table_ref||' '||reviewed.constraint_name);
 END LOOP;
 -- Exactly these: an unreviewed retained->erasable FK refuses the composition instead of being dropped.
 SELECT string_agg(f.key,', ' ORDER BY f.key) INTO unreviewed FROM(
  SELECT sn.nspname||'.'||s.relname||' '||c.conname AS key
   FROM pg_constraint c JOIN pg_class s ON s.oid=c.conrelid JOIN pg_namespace sn ON sn.oid=s.relnamespace
   JOIN pg_class d ON d.oid=c.confrelid JOIN pg_namespace dn ON dn.oid=d.relnamespace
   WHERE c.contype='f' AND sn.nspname NOT LIKE 'pg_%' AND sn.nspname<>'information_schema'
    AND lifecycle.retained_table(sn.nspname::text,s.relname::text)
    AND d.relkind IN('r','p') AND NOT d.relispartition AND dn.nspname NOT LIKE 'pg_%' AND dn.nspname<>'information_schema'
    AND NOT lifecycle.retained_table(dn.nspname::text,d.relname::text)
    AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=d.oid AND a.attname='organization_id' AND NOT a.attisdropped)
 ) f WHERE f.key<>ALL(keys);
 IF unreviewed IS NOT NULL OR cardinality(keys)<>19 THEN
  RAISE EXCEPTION 'RETAINED_REFERENT_SCHEMA_UNREVIEWED' USING ERRCODE='EN850',DETAIL=coalesce(unreviewed,'reviewed list');END IF;
END $review$;
--> statement-breakpoint
ALTER TABLE platform.budget_reservations
 DROP CONSTRAINT budget_reservations_organization_id_run_id_agent_runs_organizat,
 DROP CONSTRAINT budget_reservations_organization_id_step_id_execution_steps_org,
 DROP CONSTRAINT budget_reservations_model_job_fk,
 DROP CONSTRAINT budget_reservations_model_call_fk;
ALTER TABLE platform.budgets
 DROP CONSTRAINT budgets_organization_id_agent_version_id_agent_versions_organiz,
 DROP CONSTRAINT budgets_organization_id_created_by_membership_id_memberships_or;
ALTER TABLE platform.usage_ledger
 DROP CONSTRAINT usage_ledger_organization_id_rate_card_id_rate_cards_organizati,
 DROP CONSTRAINT usage_ledger_organization_id_work_unit_id_work_units_organizati,
 DROP CONSTRAINT usage_ledger_organization_id_run_id_agent_runs_organization_id_,
 DROP CONSTRAINT usage_ledger_organization_id_step_id_execution_steps_organizati,
 DROP CONSTRAINT usage_ledger_organization_id_profile_id_model_profiles_organiza,
 DROP CONSTRAINT usage_ledger_model_job_fk,
 DROP CONSTRAINT usage_ledger_model_call_fk;
ALTER TABLE governance.egress_decisions
 DROP CONSTRAINT egress_decisions_organization_id_run_id_agent_runs_organization,
 DROP CONSTRAINT egress_decisions_organization_id_step_id_execution_steps_organi,
 DROP CONSTRAINT egress_decisions_organization_id_profile_id_model_profiles_orga;
ALTER TABLE governance.kill_switches
 DROP CONSTRAINT kill_switches_organization_id_engaged_by_membership_id_membersh,
 DROP CONSTRAINT kill_switches_organization_id_released_by_membership_id_members;
ALTER TABLE governance.policy_bundles
 DROP CONSTRAINT policy_bundles_organization_id_created_by_membership_id_members;
--> statement-breakpoint
-- Postconditions. No retained->erasable FK remains; the dropped ones are gone while their historical
-- columns stay; the retained->retained and organization FKs stay; every native and append-only guard
-- on the six tables is still installed and enabled; the eraser still cannot reach them.
DO $review$
DECLARE remaining text;expected record;runtime_role text;
BEGIN
 SELECT string_agg(sn.nspname||'.'||s.relname||' '||c.conname,', ' ORDER BY sn.nspname,s.relname,c.conname) INTO remaining
  FROM pg_constraint c JOIN pg_class s ON s.oid=c.conrelid JOIN pg_namespace sn ON sn.oid=s.relnamespace
  JOIN pg_class d ON d.oid=c.confrelid JOIN pg_namespace dn ON dn.oid=d.relnamespace
  WHERE c.contype='f' AND sn.nspname NOT LIKE 'pg_%' AND sn.nspname<>'information_schema'
   AND lifecycle.retained_table(sn.nspname::text,s.relname::text)
   AND d.relkind IN('r','p') AND NOT d.relispartition AND dn.nspname NOT LIKE 'pg_%' AND dn.nspname<>'information_schema'
   AND NOT lifecycle.retained_table(dn.nspname::text,d.relname::text)
   AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=d.oid AND a.attname='organization_id' AND NOT a.attisdropped);
 IF remaining IS NOT NULL THEN
  RAISE EXCEPTION 'RETAINED_REFERENT_POSTCONDITION' USING ERRCODE='EN850',DETAIL=remaining;END IF;
 FOR expected IN SELECT * FROM(VALUES
  ('platform.budget_reservations','budget_reservations_organization_id_run_id_agent_runs_organizat','{run_id}'),
  ('platform.budget_reservations','budget_reservations_organization_id_step_id_execution_steps_org','{step_id}'),
  ('platform.budget_reservations','budget_reservations_model_job_fk','{model_job_id}'),
  ('platform.budget_reservations','budget_reservations_model_call_fk','{model_call_id}'),
  ('platform.budgets','budgets_organization_id_agent_version_id_agent_versions_organiz','{agent_version_id}'),
  ('platform.budgets','budgets_organization_id_created_by_membership_id_memberships_or','{created_by_membership_id}'),
  ('platform.usage_ledger','usage_ledger_organization_id_rate_card_id_rate_cards_organizati','{rate_card_id}'),
  ('platform.usage_ledger','usage_ledger_organization_id_work_unit_id_work_units_organizati','{work_unit_id}'),
  ('platform.usage_ledger','usage_ledger_organization_id_run_id_agent_runs_organization_id_','{run_id}'),
  ('platform.usage_ledger','usage_ledger_organization_id_step_id_execution_steps_organizati','{step_id}'),
  ('platform.usage_ledger','usage_ledger_organization_id_profile_id_model_profiles_organiza','{profile_id}'),
  ('platform.usage_ledger','usage_ledger_model_job_fk','{model_job_id}'),
  ('platform.usage_ledger','usage_ledger_model_call_fk','{model_call_id}'),
  ('governance.egress_decisions','egress_decisions_organization_id_run_id_agent_runs_organization','{run_id}'),
  ('governance.egress_decisions','egress_decisions_organization_id_step_id_execution_steps_organi','{step_id}'),
  ('governance.egress_decisions','egress_decisions_organization_id_profile_id_model_profiles_orga','{profile_id}'),
  ('governance.kill_switches','kill_switches_organization_id_engaged_by_membership_id_membersh','{engaged_by_membership_id}'),
  ('governance.kill_switches','kill_switches_organization_id_released_by_membership_id_members','{released_by_membership_id}'),
  ('governance.policy_bundles','policy_bundles_organization_id_created_by_membership_id_members','{created_by_membership_id}')
 ) AS r(table_ref,constraint_name,columns) LOOP
  IF EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass(expected.table_ref) AND c.conname=expected.constraint_name)
   OR(SELECT count(*) FROM pg_attribute a WHERE a.attrelid=to_regclass(expected.table_ref) AND NOT a.attisdropped
    AND a.atttypid='uuid'::regtype::oid AND a.attname::text=ANY(expected.columns::text[]))<>cardinality(expected.columns::text[]) THEN
   RAISE EXCEPTION 'RETAINED_REFERENT_POSTCONDITION' USING ERRCODE='EN850',DETAIL=expected.table_ref||' '||expected.constraint_name;END IF;
 END LOOP;
 FOR expected IN SELECT * FROM(VALUES
  ('platform.budget_reservations','budget_reservations_organization_id_budget_id_budgets_organizat','platform.budgets'),
  ('platform.usage_ledger','usage_ledger_organization_id_reservation_id_budget_reservations','platform.budget_reservations'),
  ('platform.usage_ledger','usage_ledger_organization_id_corrects_id_usage_ledger_organizat','platform.usage_ledger'),
  ('platform.budget_reservations','budget_reservations_organization_id_organizations_id_fk','org.organizations'),
  ('platform.budgets','budgets_organization_id_organizations_id_fk','org.organizations'),
  ('platform.usage_ledger','usage_ledger_organization_id_organizations_id_fk','org.organizations'),
  ('governance.egress_decisions','egress_decisions_organization_id_organizations_id_fk','org.organizations'),
  ('governance.kill_switches','kill_switches_organization_id_organizations_id_fk','org.organizations'),
  ('governance.policy_bundles','policy_bundles_organization_id_organizations_id_fk','org.organizations'),
  ('lifecycle.standing_stop_receipts','standing_stop_switch','governance.kill_switches')
 ) AS r(table_ref,constraint_name,target_ref) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass(expected.table_ref) AND c.conname=expected.constraint_name
   AND c.contype='f' AND c.convalidated AND c.confrelid=to_regclass(expected.target_ref)) THEN
   RAISE EXCEPTION 'RETAINED_REFERENT_POSTCONDITION' USING ERRCODE='EN850',DETAIL=expected.table_ref||' '||expected.constraint_name;END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid='lifecycle.offboarding_agent_stops'::regclass AND c.contype='f'
  AND c.convalidated AND c.confrelid='governance.kill_switches'::regclass) THEN
  RAISE EXCEPTION 'RETAINED_REFERENT_POSTCONDITION' USING ERRCODE='EN850',DETAIL='lifecycle.offboarding_agent_stops -> governance.kill_switches';END IF;
 FOR expected IN SELECT * FROM(VALUES
  ('platform.usage_ledger','usage_ledger_append_only','app.reject_change()'),
  ('platform.usage_ledger','model_usage_principal','ai.guard_model_money_principal()'),
  ('platform.budget_reservations','model_reservation_principal','ai.guard_model_money_principal()'),
  ('platform.budget_reservations','scoped_model_reservation','ai.guard_scoped_model_write()'),
  ('platform.budget_reservations','authority_reservation_write','ai.guard_authority_protocol_write()'),
  ('governance.egress_decisions','egress_decisions_append_only','app.reject_change()'),
  ('governance.egress_decisions','egress_run_input_protocol','ai.guard_run_content_write()'),
  ('governance.egress_decisions','authority_egress_write','ai.guard_authority_protocol_write()'),
  ('governance.kill_switches','kill_switches_keep','app.reject_change()'),
  ('governance.kill_switches','kill_switches_check_change','governance.check_kill_switch_change()'),
  ('governance.kill_switches','kill_switch_offboarding_release','lifecycle.protect_offboarding_stop()'),
  ('governance.kill_switches','kill_switch_standing_release','lifecycle.protect_standing_stop()')
 ) AS r(table_ref,trigger_name,function_ref) LOOP
  IF to_regprocedure(expected.function_ref) IS NULL OR NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass(expected.table_ref)
   AND t.tgname=expected.trigger_name AND t.tgfoid=to_regprocedure(expected.function_ref)
   AND t.tgenabled IN('O','A') AND NOT t.tgisinternal) THEN
   RAISE EXCEPTION 'RETAINED_REFERENT_POSTCONDITION' USING ERRCODE='EN850',DETAIL=expected.table_ref||' '||expected.trigger_name;END IF;
 END LOOP;
 FOR expected IN SELECT * FROM(VALUES('platform','budget_reservations'),('platform','budgets'),('platform','usage_ledger'),
  ('governance','egress_decisions'),('governance','kill_switches'),('governance','policy_bundles')) AS r(schema_name,table_name) LOOP
  IF lifecycle.retained_table(expected.schema_name,expected.table_name) IS DISTINCT FROM true
   OR has_table_privilege('ensemus_eraser',format('%I.%I',expected.schema_name,expected.table_name),'DELETE')
   OR has_table_privilege('ensemus_eraser',format('%I.%I',expected.schema_name,expected.table_name),'TRUNCATE') THEN
   RAISE EXCEPTION 'RETAINED_REFERENT_POSTCONDITION' USING ERRCODE='EN850',DETAIL=expected.schema_name||'.'||expected.table_name;END IF;
 END LOOP;
 -- Finding 10: 0550's requalification evidence, as 0550 created it.
 IF to_regclass('lifecycle.raw_active_source_requalifications') IS NULL
  OR lifecycle.retained_table('lifecycle','raw_active_source_requalifications') IS DISTINCT FROM true
  OR NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='lifecycle.raw_active_source_requalifications'::regclass
   AND c.relrowsecurity AND c.relforcerowsecurity AND c.relowner='ensemus_migrator'::regrole::oid)
  OR(SELECT count(*) FROM pg_policy p WHERE p.polrelid='lifecycle.raw_active_source_requalifications'::regclass)<>1
  OR NOT EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid='lifecycle.raw_active_source_requalifications'::regclass
   AND p.polname='raw_active_source_requalification_owner' AND p.polpermissive AND p.polcmd='*'
   AND p.polroles=ARRAY['ensemus_migrator'::regrole::oid])
  OR EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
   WHERE c.oid='lifecycle.raw_active_source_requalifications'::regclass AND a.grantee<>c.relowner)
  OR EXISTS(SELECT 1 FROM pg_attribute att
   WHERE att.attrelid='lifecycle.raw_active_source_requalifications'::regclass AND att.attacl IS NOT NULL)
  OR NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='lifecycle.raw_active_source_requalifications'::regclass
   AND t.tgname='raw_active_source_requalification_keep' AND t.tgfoid='app.reject_change()'::regprocedure
   AND t.tgenabled IN('O','A') AND NOT t.tgisinternal
   -- BEFORE (2), DELETE (8), UPDATE (16) and TRUNCATE (32), once per statement (no ROW bit 1).
   AND (t.tgtype::integer&(1|2|8|16|32))=(2|8|16|32)) THEN
  RAISE EXCEPTION 'RETAINED_REFERENT_POSTCONDITION' USING ERRCODE='EN850',DETAIL='lifecycle.raw_active_source_requalifications';END IF;
 FOREACH runtime_role IN ARRAY ARRAY['ensemus_app','ensemus_agent','ensemus_auth','ensemus_secrets','ensemus_dispatcher',
  'ensemus_eraser','ensemus_operator','ensemus_support'] LOOP
  IF to_regrole(runtime_role) IS NOT NULL AND(
   has_table_privilege(runtime_role::name,'lifecycle.raw_active_source_requalifications','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
   OR has_any_column_privilege(runtime_role::name,'lifecycle.raw_active_source_requalifications','SELECT,INSERT,UPDATE,REFERENCES')) THEN
   RAISE EXCEPTION 'RETAINED_REFERENT_POSTCONDITION' USING ERRCODE='EN850',DETAIL='lifecycle.raw_active_source_requalifications '||runtime_role;END IF;
 END LOOP;
END $review$;
