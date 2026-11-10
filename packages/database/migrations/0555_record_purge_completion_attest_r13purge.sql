-- REVIEWED SECURITY SQL (ADR-032 D7). Changes here need human review, never agent approval.
-- FLAGGED FOR HUMAN SECURITY REVIEW (ADR-032 D7), not yet reviewed by a person
-- Written by an agent in CI repair round 13 (A-db-0555-record-purge-completion-attest group, check finding 1).
--
-- 0555 (r13 record purge completion attestation): additive and read-only. 0554 is registered and pushed,
-- so it is not edited; this file re-asserts, as a postcondition of its own, what 0554's postcondition
-- left unchecked. It creates, alters, grants and revokes nothing. Renumbered at merge if another 0555
-- lands first.
--
-- Why it exists. 0554 lets ensemus_app write ai.record_purge_jobs.completed_restore_generation through one
-- permissive UPDATE policy, record_purge_completion_attest, and one column privilege. 0554's postcondition
-- (0554:216-218) checks that policy only by polname, polpermissive, polcmd='w' and polroles, so a later
-- ALTER POLICY ... USING(true) or WITH CHECK(true) (any tenant, any login, any actor) would still pass,
-- as would a second permissive UPDATE or ALL policy that reaches ensemus_app or ensemus_agent another way.
-- Its privilege checks use has_column_privilege, which counts inherited privileges: ensemus_agent is IN
-- ROLE ensemus_app, so has_column_privilege('ensemus_agent',...,'completed_restore_generation','UPDATE') is
-- always true and cannot tell a direct grant to the agent from the inherited one. This postcondition reads
-- the catalogue directly instead:
--   1. record_purge_completion_attest is the only policy of that name, on ai.record_purge_jobs, permissive,
--      FOR UPDATE, TO ensemus_app alone, and its USING and WITH CHECK are exactly the expressions 0554:85-86
--      created, as PostgreSQL deparses them (pg_get_expr, with search_path pinned to pg_catalog so the
--      function names print schema-qualified whatever the caller's search_path is).
--   2. The only other permissive UPDATE or ALL policy that applies to ensemus_app or ensemus_agent (a
--      policy TO PUBLIC, or TO any role either of them is a member of) is 0419's record_purge_worker, TO
--      ensemus_agent alone, with exactly 0419's expressions (0419:2028-2029). The agent's writes through
--      it meet 0419's guard, which 0554 made clear the completion. A restrictive policy only narrows.
--   3. Direct grants (aclexplode over pg_attribute.attacl and pg_class.relacl): completed_restore_generation
--      carries exactly one column grant, UPDATE to ensemus_app, without GRANT OPTION; completed_at carries
--      none; and no role but the table owner holds table-level UPDATE, which would imply both columns.
-- A refusal raises EN850 with a DETAIL that names only an object, never a tenant or a value.
DO $$ DECLARE previous_search_path text:=current_setting('search_path');
 attest_expr text:=$e$((organization_id = app.current_organization_id()) AND (CURRENT_USER = 'ensemus_app'::name) AND (SESSION_USER = 'ensemus_app'::name) AND (app.current_actor_type() = 'service'::text))$e$;
 worker_expr text:=$e$((organization_id = app.current_organization_id()) AND (CURRENT_USER = 'ensemus_agent'::name) AND (SESSION_USER = 'ensemus_agent'::name) AND (app.current_actor_type() = 'service'::text))$e$;
 jobs oid;app_role oid;agent_role oid;owner_role oid;
 attest_qual text;attest_check text;worker_qual text;worker_check text;
BEGIN
 jobs:=to_regclass('ai.record_purge_jobs');app_role:=to_regrole('ensemus_app');agent_role:=to_regrole('ensemus_agent');
 IF jobs IS NULL OR app_role IS NULL OR agent_role IS NULL THEN
  RAISE EXCEPTION 'RECORD_PURGE_COMPLETION_ATTEST_POSTCONDITION' USING ERRCODE='EN850',DETAIL='ai.record_purge_jobs';END IF;
 SELECT c.relowner INTO owner_role FROM pg_catalog.pg_class c WHERE c.oid=jobs;
 -- pg_get_expr qualifies a function name only when it is not visible on the search_path, so the
 -- expressions are read with the path pinned, and the caller's path is put back before any refusal.
 PERFORM pg_catalog.set_config('search_path','pg_catalog',true);
 SELECT pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid) INTO attest_qual,attest_check
  FROM pg_policy p WHERE p.polrelid=jobs AND p.polname='record_purge_completion_attest';
 SELECT pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid) INTO worker_qual,worker_check
  FROM pg_policy p WHERE p.polrelid=jobs AND p.polname='record_purge_worker';
 PERFORM pg_catalog.set_config('search_path',previous_search_path,true);
 -- 1. The attestation policy: one, here, permissive, UPDATE, ensemus_app alone, 0554's exact expressions.
 IF (SELECT count(*) FROM pg_catalog.pg_policy p WHERE p.polname='record_purge_completion_attest')<>1
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=jobs AND p.polname='record_purge_completion_attest'
   AND p.polpermissive AND p.polcmd='w' AND p.polroles=ARRAY[app_role])
  OR attest_qual IS DISTINCT FROM attest_expr OR attest_check IS DISTINCT FROM attest_expr THEN
  RAISE EXCEPTION 'RECORD_PURGE_COMPLETION_ATTEST_POSTCONDITION' USING ERRCODE='EN850',
   DETAIL='ai.record_purge_jobs record_purge_completion_attest';END IF;
 -- 2. 0419's agent policy, unchanged: permissive, ALL, ensemus_agent alone, 0419's exact expressions.
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=jobs AND p.polname='record_purge_worker'
   AND p.polpermissive AND p.polcmd='*' AND p.polroles=ARRAY[agent_role])
  OR worker_qual IS DISTINCT FROM worker_expr OR worker_check IS DISTINCT FROM worker_expr THEN
  RAISE EXCEPTION 'RECORD_PURGE_COMPLETION_ATTEST_POSTCONDITION' USING ERRCODE='EN850',
   DETAIL='ai.record_purge_jobs record_purge_worker';END IF;
 --    No other permissive UPDATE or ALL policy reaches either runtime role (PUBLIC is role 0).
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=jobs AND p.polpermissive AND p.polcmd IN('w','*')
   AND p.polname NOT IN('record_purge_completion_attest','record_purge_worker')
   AND EXISTS(SELECT 1 FROM unnest(p.polroles) r(role_oid) WHERE CASE WHEN r.role_oid=0 THEN true
    ELSE pg_catalog.pg_has_role(app_role,r.role_oid,'MEMBER') OR pg_catalog.pg_has_role(agent_role,r.role_oid,'MEMBER') END)) THEN
  RAISE EXCEPTION 'RECORD_PURGE_COMPLETION_ATTEST_POSTCONDITION' USING ERRCODE='EN850',
   DETAIL='ai.record_purge_jobs update policies';END IF;
 -- 3. Direct grants. Exactly one column grant on the completion: UPDATE(completed_restore_generation) to
 --    ensemus_app, not grantable; nothing on completed_at; no table-level UPDATE but the owner's.
 IF (SELECT count(*) FROM pg_catalog.pg_attribute a WHERE a.attrelid=jobs AND NOT a.attisdropped
    AND a.attname IN('completed_restore_generation','completed_at'))<>2
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) x
   WHERE a.attrelid=jobs AND a.attname IN('completed_restore_generation','completed_at')
    AND NOT(a.attname='completed_restore_generation' AND x.grantee=app_role AND x.privilege_type='UPDATE' AND NOT x.is_grantable))
  OR(SELECT count(*) FROM pg_catalog.pg_attribute a CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) x
   WHERE a.attrelid=jobs AND a.attname='completed_restore_generation'
    AND x.grantee=app_role AND x.privilege_type='UPDATE' AND NOT x.is_grantable)<>1
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) x
   WHERE c.oid=jobs AND x.privilege_type='UPDATE' AND x.grantee<>owner_role) THEN
  RAISE EXCEPTION 'RECORD_PURGE_COMPLETION_ATTEST_POSTCONDITION' USING ERRCODE='EN850',
   DETAIL='ai.record_purge_jobs completion grants';END IF;
END $$;
