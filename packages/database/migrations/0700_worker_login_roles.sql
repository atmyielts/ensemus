-- FLAGGED FOR HUMAN SECURITY REVIEW
-- REVIEWED SECURITY SQL (ADR-039 D1, TR-028, ADR-038 "Known gaps"). Changes here need human review, never
-- agent approval. Not yet reviewed by a person, and not yet run.
--
-- The workers stop sharing the web tier's login. ensemus_worker (the platform worker, and the operator
-- commands that run in its image), ensemus_connector (the connector worker) and ensemus_knowledge (the
-- knowledge worker) each log in as themselves, as ensemus_agent already does. Each is a member of
-- ensemus_app and nothing else, so every grant and row-level policy `TO ensemus_app` reaches it unchanged.
-- The provisioning job creates them (infrastructure/compose/postgres/upgrade-roles-workers.sql), because the
-- migrator cannot create a role.
--
-- This migration changes no rule. Every installed function and policy that names ensemus_app and asks
-- session_user or current_user is rewritten to ask app.tier_session_user() or app.tier_current_user()
-- instead. Those answer 'ensemus_app' for the three worker logins and the real name for everyone else. So a
-- check that admitted or refused ensemus_app admits or refuses the workers exactly as before, and none of
-- them can slip through a branch meant for some other trusted role (`IF current_user NOT IN
-- ('ensemus_app','ensemus_agent') THEN RETURN NEW`). A check that never names ensemus_app already treats a
-- worker login as it treats ensemus_app: as some role other than the one it names. 0701 then narrows the
-- rules that only one worker should pass, using the real session_user.
--
-- A migration after this one must use app.tier_session_user() and app.tier_current_user() wherever it
-- compares with 'ensemus_app'. tests/unit/worker-login-roles.test.ts refuses one that does not.

-- 1. The three logins exist, are ordinary, and belong to ensemus_app alone.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['ensemus_worker','ensemus_connector','ensemus_knowledge'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=r) THEN
      RAISE EXCEPTION 'WORKER_ROLE_MISSING: %', r USING ERRCODE='42704',
        HINT='Run the provision-roles job (upgrade-roles-workers.sql) before this migration.';
    END IF;
    IF (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolreplication OR NOT rolinherit
          FROM pg_roles WHERE rolname=r) THEN
      RAISE EXCEPTION 'ROLE_UNSAFE: % has an elevated attribute or does not inherit', r USING ERRCODE='42501';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_auth_members m JOIN pg_roles p ON p.oid=m.roleid JOIN pg_roles c ON c.oid=m.member
         WHERE c.rolname=r AND p.rolname='ensemus_app')
      OR EXISTS (
        SELECT 1 FROM pg_auth_members m JOIN pg_roles p ON p.oid=m.roleid JOIN pg_roles c ON c.oid=m.member
         WHERE c.rolname=r AND p.rolname<>'ensemus_app')
      OR EXISTS (
        SELECT 1 FROM pg_auth_members m JOIN pg_roles p ON p.oid=m.roleid WHERE p.rolname=r) THEN
      RAISE EXCEPTION 'ROLE_UNSAFE: % must belong to ensemus_app alone, and nobody to it', r
        USING ERRCODE='42501';
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint

-- 2. The application tier as the existing rules know it. Plain SQL, so a policy inlines it.
CREATE FUNCTION app.tier_session_user() RETURNS name
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT CASE WHEN session_user IN ('ensemus_worker','ensemus_connector','ensemus_knowledge')
    THEN 'ensemus_app'::name ELSE session_user END $$;
--> statement-breakpoint
CREATE FUNCTION app.tier_current_user() RETURNS name
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT CASE WHEN current_user IN ('ensemus_worker','ensemus_connector','ensemus_knowledge')
    THEN 'ensemus_app'::name ELSE current_user END $$;
--> statement-breakpoint
-- They say only who is calling, which the caller knows. Every role that runs a rule needs them.
GRANT EXECUTE ON FUNCTION app.tier_session_user(), app.tier_current_user() TO PUBLIC;
--> statement-breakpoint

-- 3. Every installed function that names ensemus_app and asks who is calling. Each is its own text with
-- only those two words replaced, re-created by its owner, so its grants, settings and triggers stay. A
-- function the migrator does not own stops the migration rather than being skipped.
DO $$
DECLARE
  f record;
  definition text;
  rewritten integer := 0;
BEGIN
  FOR f IN
    SELECT p.oid, p.oid::regprocedure::text AS signature, pg_get_userbyid(p.proowner) AS owner
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_'
       AND p.prokind IN ('f','p')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d
                        WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
       AND p.oid NOT IN ('app.tier_session_user()'::regprocedure, 'app.tier_current_user()'::regprocedure)
  LOOP
    definition := pg_get_functiondef(f.oid);
    CONTINUE WHEN strpos(definition, 'ensemus_app')=0
      OR definition !~* '\m(session_user|current_user)\M';
    IF f.owner<>current_user THEN
      RAISE EXCEPTION 'TIER_REWRITE_NOT_OWNER: %', f.signature USING ERRCODE='42501';
    END IF;
    definition := regexp_replace(definition, '\msession_user\M', 'app.tier_session_user()', 'gi');
    definition := regexp_replace(definition, '\mcurrent_user\M', 'app.tier_current_user()', 'gi');
    EXECUTE definition;
    rewritten := rewritten+1;
  END LOOP;
  IF rewritten=0 THEN RAISE EXCEPTION 'TIER_REWRITE_FOUND_NOTHING' USING ERRCODE='EN850'; END IF;
END $$;
--> statement-breakpoint

-- 4. The same for row-level policies, from their stored expressions.
DO $$
DECLARE
  p record;
  q text;
  w text;
BEGIN
  FOR p IN
    SELECT pol.polname, n.nspname, c.relname,
           pg_get_expr(pol.polqual, pol.polrelid) AS qual,
           pg_get_expr(pol.polwithcheck, pol.polrelid) AS checked
      FROM pg_policy pol JOIN pg_class c ON c.oid=pol.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  LOOP
    CONTINUE WHEN strpos(coalesce(p.qual,'')||' '||coalesce(p.checked,''), 'ensemus_app')=0
      OR (coalesce(p.qual,'')||' '||coalesce(p.checked,'')) !~* '\m(session_user|current_user)\M';
    q := regexp_replace(regexp_replace(p.qual, '\msession_user\M', 'app.tier_session_user()', 'gi'),
      '\mcurrent_user\M', 'app.tier_current_user()', 'gi');
    w := regexp_replace(regexp_replace(p.checked, '\msession_user\M', 'app.tier_session_user()', 'gi'),
      '\mcurrent_user\M', 'app.tier_current_user()', 'gi');
    IF q IS NOT NULL THEN
      EXECUTE format('ALTER POLICY %I ON %I.%I USING (%s)', p.polname, p.nspname, p.relname, q);
    END IF;
    IF w IS NOT NULL THEN
      EXECUTE format('ALTER POLICY %I ON %I.%I WITH CHECK (%s)', p.polname, p.nspname, p.relname, w);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint

-- 5. Postcondition. Nothing installed still tells ensemus_app apart by the raw name: no function, no
-- policy, and no view, trigger condition, check constraint or column default, which this migration does
-- not rewrite and so must find none of.
DO $$
DECLARE found text;
BEGIN
  SELECT string_agg(x, ', ') INTO found FROM (
    SELECT p.oid::regprocedure::text AS x
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_'
       AND p.prokind IN ('f','p')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d
                        WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
       AND p.oid NOT IN ('app.tier_session_user()'::regprocedure, 'app.tier_current_user()'::regprocedure)
       AND strpos(pg_get_functiondef(p.oid), 'ensemus_app')<>0
       AND pg_get_functiondef(p.oid) ~* '\m(session_user|current_user)\M'
    UNION ALL
    SELECT 'policy '||pol.polname FROM pg_policy pol
     WHERE strpos(coalesce(pg_get_expr(pol.polqual,pol.polrelid),'')||coalesce(pg_get_expr(pol.polwithcheck,pol.polrelid),''), 'ensemus_app')<>0
       AND (coalesce(pg_get_expr(pol.polqual,pol.polrelid),'')||' '||coalesce(pg_get_expr(pol.polwithcheck,pol.polrelid),'')) ~* '\m(session_user|current_user)\M'
    UNION ALL
    SELECT 'view '||schemaname||'.'||viewname FROM pg_views
     WHERE schemaname NOT IN ('pg_catalog','information_schema')
       AND strpos(definition, 'ensemus_app')<>0 AND definition ~* '\m(session_user|current_user)\M'
    UNION ALL
    SELECT 'trigger '||t.tgname FROM pg_trigger t
     WHERE NOT t.tgisinternal AND strpos(pg_get_triggerdef(t.oid), 'ensemus_app')<>0
       AND pg_get_triggerdef(t.oid) ~* '\m(session_user|current_user)\M'
    UNION ALL
    SELECT 'constraint '||c.conname FROM pg_constraint c
     WHERE c.contype='c' AND strpos(pg_get_constraintdef(c.oid), 'ensemus_app')<>0
       AND pg_get_constraintdef(c.oid) ~* '\m(session_user|current_user)\M'
    UNION ALL
    SELECT 'default '||a.adrelid::regclass::text FROM pg_attrdef a
     WHERE strpos(pg_get_expr(a.adbin, a.adrelid), 'ensemus_app')<>0
       AND pg_get_expr(a.adbin, a.adrelid) ~* '\m(session_user|current_user)\M'
  ) left_over;
  IF found IS NOT NULL THEN
    RAISE EXCEPTION 'TIER_REWRITE_INCOMPLETE: %', found USING ERRCODE='EN850';
  END IF;
END $$;
