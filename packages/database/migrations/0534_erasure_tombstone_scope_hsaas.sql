-- REVIEWED SECURITY SQL (ADR-032 D7). Changes here need human review, never agent approval.
-- 0534 (harden-saas): additive repair for registered 0508 and 0531, which are pushed, so not edited.
--
-- 0531's erasure_artifact_tombstone_birth admits an INSERT on platform.tombstones by
-- ensemus_migrator from anywhere the other conditions hold: any migrator-owned SECURITY DEFINER
-- function an application service actor can call during an open erasure could write a
-- TENANT_ERASURE artifact tombstone through it. 0407's object_trigger_tombstone scopes its migrator
-- INSERT to a trigger (pg_trigger_depth). lifecycle.prepare_erasure_artifacts is a function, not a
-- trigger, so this scopes the policy to a function-set GUC instead, the same shape as 0508's
-- lifecycle.erasure_count_org: the function binds lifecycle.erasure_tombstone_org to the current
-- tenant around its own INSERT only, and restores the previous value right after it. On an error the
-- statement's (sub)transaction rollback discards the binding as well.
--
-- The replacement keeps 0508's body otherwise byte for byte, and keeps SECURITY DEFINER,
-- search_path=pg_catalog, the PUBLIC revoke and the ensemus_app EXECUTE grant (checked below).
-- Every other condition of the 0531 policy is unchanged. No role gains a grant.
DO $$ BEGIN
 IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND(rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'ERASURE_TOMBSTONE_SCOPE_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 IF to_regprocedure('lifecycle.prepare_erasure_artifacts(uuid,integer)') IS NULL OR to_regclass('platform.tombstones') IS NULL
  OR NOT EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid='platform.tombstones'::regclass
   AND p.polname='erasure_artifact_tombstone_birth' AND p.polcmd='a') THEN
  RAISE EXCEPTION 'ERASURE_TOMBSTONE_SCOPE_SOURCE_REQUIRED' USING ERRCODE='EN850';END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION lifecycle.prepare_erasure_artifacts(p_intent uuid,p_limit integer)
 RETURNS TABLE(artifact_id uuid,classification text,added boolean) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE item record;inserted integer;prior_scope text;
BEGIN
 PERFORM lifecycle.lock_delete_tenant();
 IF NOT knowledge.is_service_actor() OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
  OR NOT lifecycle.admitted_offboarding(p_intent) OR NOT EXISTS(SELECT 1 FROM lifecycle.offboardings o
   WHERE o.organization_id=app.current_organization_id() AND o.id=p_intent AND o.state='erasing')
  OR lifecycle.erasure_open(app.current_organization_id()) IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'ERASURE_METADATA_INTENT_REQUIRED' USING ERRCODE='EN850';END IF;
 FOR item IN SELECT a.artifact_id,a.classification FROM knowledge.artifact_acl_catalog a
  WHERE a.organization_id=app.current_organization_id() AND(
   NOT EXISTS(SELECT 1 FROM platform.tombstones t WHERE t.organization_id=a.organization_id AND t.target_type='artifact' AND t.target_id=a.artifact_id)
   OR NOT EXISTS(SELECT 1 FROM platform.blob_lifecycle b WHERE b.organization_id=a.organization_id AND b.artifact_id=a.artifact_id)
   OR NOT EXISTS(SELECT 1 FROM platform.domain_events e WHERE e.organization_id=a.organization_id AND e.aggregate_type='artifact'
    AND e.aggregate_id=a.artifact_id AND e.event_type='tombstone.recorded')) ORDER BY a.artifact_id LIMIT p_limit LOOP
  -- 0534: the only place erasure_artifact_tombstone_birth admits a migrator tombstone INSERT.
  prior_scope:=current_setting('lifecycle.erasure_tombstone_org',true);
  PERFORM set_config('lifecycle.erasure_tombstone_org',app.current_organization_id()::text,true);
  INSERT INTO platform.tombstones(organization_id,target_type,target_id,reason_code)
   VALUES(app.current_organization_id(),'artifact',item.artifact_id,'TENANT_ERASURE') ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted=ROW_COUNT;
  PERFORM set_config('lifecycle.erasure_tombstone_org',coalesce(prior_scope,''),true);
  INSERT INTO platform.blob_lifecycle(organization_id,artifact_id,object_key,state,purge_after)
   VALUES(app.current_organization_id(),item.artifact_id,app.current_organization_id()::text||'/artifacts/'||item.artifact_id::text,'deleting',clock_timestamp()) ON CONFLICT DO NOTHING;
  UPDATE knowledge.artifact_lineage l SET state='blocked' WHERE l.organization_id=app.current_organization_id()
   AND l.artifact_id=item.artifact_id AND l.state<>'blocked';
  RETURN QUERY SELECT item.artifact_id::uuid,item.classification::text,inserted>0;
 END LOOP;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION lifecycle.prepare_erasure_artifacts(uuid,integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION lifecycle.prepare_erasure_artifacts(uuid,integer) TO ensemus_app;
--> statement-breakpoint
ALTER POLICY erasure_artifact_tombstone_birth ON platform.tombstones
 WITH CHECK(organization_id=app.current_organization_id()
  AND organization_id::text=pg_catalog.current_setting('lifecycle.erasure_tombstone_org',true)
  AND target_type='artifact' AND reason_code='TENANT_ERASURE'
  AND session_user='ensemus_app' AND knowledge.is_service_actor() AND lifecycle.erasure_open(organization_id) IS TRUE);
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='lifecycle.prepare_erasure_artifacts(uuid,integer)'::regprocedure
   AND p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog'])
  OR has_function_privilege('public','lifecycle.prepare_erasure_artifacts(uuid,integer)','EXECUTE')
  OR NOT has_function_privilege('ensemus_app','lifecycle.prepare_erasure_artifacts(uuid,integer)','EXECUTE')
  OR NOT EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid='platform.tombstones'::regclass
   AND p.polname='erasure_artifact_tombstone_birth' AND p.polcmd='a' AND p.polpermissive
   AND p.polroles=ARRAY['ensemus_migrator'::regrole::oid]
   AND pg_get_expr(p.polwithcheck,p.polrelid) LIKE '%lifecycle.erasure_tombstone_org%') THEN
  RAISE EXCEPTION 'ERASURE_TOMBSTONE_SCOPE_POSTCONDITION' USING ERRCODE='EN850';END IF;
END $$;
