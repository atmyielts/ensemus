-- REVIEWED SECURITY SQL (ADR-032 D7). Changes here need human review, never agent approval.
-- 0541 (r4-saas): additive repairs for registered 0512 and 0534, which are pushed, so not edited.
--
-- 1. Erasure tombstone scope (check finding 3). 0534 scoped erasure_artifact_tombstone_birth to the
--    custom GUC lifecycle.erasure_tombstone_org, which lifecycle.prepare_erasure_artifacts set around
--    its own INSERT. Any session may call set_config on a custom GUC, so a service actor could set it
--    to its own tenant and then reach any other migrator-owned SECURITY DEFINER function that writes a
--    TENANT_ERASURE artifact tombstone: the scope was forgeable. The policy now requires a
--    transaction-local grant that only prepare_erasure_artifacts mints: a row in an owner-only table,
--    bound to the tenant and to this transaction's ID, holding the SHA-256 of a fresh random token.
--    The function puts the token in lifecycle.erasure_tombstone_token for its own INSERT only, then
--    restores the GUC and deletes the grant. No runtime role can read or write the grant table, so a
--    session can set the GUC to anything and still match no grant. The table has no organization_id
--    column on purpose: it never holds a row past the function's own statement, so it is not tenant
--    content and stays outside the eraser and export classification. Every other condition of the
--    0531/0534 policy, and the function's body, checks and grants, are unchanged.
--
-- 2. Payment webhook inbox conflict (saas-payment-events CI, run 42608913914). M3's inbox row dedupes a
--    delivery by endpoint and provider event ID, and 0512's payment attestation checks the signed fact
--    only when that inbox row is born. A second, validly signed delivery of the same provider event ID
--    with a CHANGED fact, on an endpoint whose inbox row already exists (a rotated endpoint after an
--    exact replay, or the original endpoint), was therefore marked `duplicate`: the conflict was
--    silently swallowed instead of refused. A BEFORE INSERT trigger on platform.inbox_events now
--    compares the attestation being consumed with the attestation that birthed the existing inbox row,
--    and refuses a different provider event, processor, namespace or, for the same observed execution
--    identity, a different signed fact. An exact repeat (same fact, any body bytes) is still a
--    duplicate. An attestation that does not match its own inbox key is refused here as 0512's AFTER
--    trigger refuses it on birth. A payment-token insert serializes per inbox key, so two concurrent
--    deliveries cannot both skip the comparison.
DO $$ BEGIN
 IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND(rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'R4_SAAS_GUARD_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 IF to_regprocedure('lifecycle.prepare_erasure_artifacts(uuid,integer)') IS NULL OR to_regclass('platform.tombstones') IS NULL
  OR NOT EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid='platform.tombstones'::regclass
   AND p.polname='erasure_artifact_tombstone_birth' AND p.polcmd='a')
  OR to_regclass('billing.payment_webhook_attestations') IS NULL OR to_regclass('platform.inbox_events') IS NULL
  OR NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='platform.inbox_events'::regclass AND t.tgname='payment_webhook_inbox_birth') THEN
  RAISE EXCEPTION 'R4_SAAS_GUARD_SOURCE_REQUIRED' USING ERRCODE='EN850';END IF;
END $$;
--> statement-breakpoint
CREATE TABLE lifecycle.erasure_tombstone_grants(
 tenant_id uuid NOT NULL,xact text NOT NULL,token_sha256 text NOT NULL,
 CONSTRAINT erasure_tombstone_grants_pk PRIMARY KEY(tenant_id,xact,token_sha256),
 CONSTRAINT erasure_tombstone_grants_hash CHECK(token_sha256 ~ '^[0-9a-f]{64}$' AND xact ~ '^[0-9]{1,20}$')
);
--> statement-breakpoint
ALTER TABLE lifecycle.erasure_tombstone_grants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE lifecycle.erasure_tombstone_grants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY erasure_tombstone_grant_scope ON lifecycle.erasure_tombstone_grants TO ensemus_migrator
 USING(tenant_id=app.current_organization_id() AND xact=pg_catalog.pg_current_xact_id()::text)
 WITH CHECK(tenant_id=app.current_organization_id() AND xact=pg_catalog.pg_current_xact_id()::text
  AND session_user='ensemus_app' AND knowledge.is_service_actor());
--> statement-breakpoint
REVOKE ALL ON lifecycle.erasure_tombstone_grants FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_secrets,ensemus_eraser;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION lifecycle.prepare_erasure_artifacts(p_intent uuid,p_limit integer)
 RETURNS TABLE(artifact_id uuid,classification text,added boolean) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE item record;inserted integer;prior_scope text;token text;token_hash text;
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
  -- 0541: the only place erasure_artifact_tombstone_birth admits a migrator tombstone INSERT. The
  -- grant is minted here, bound to this tenant and transaction, and gone before control returns.
  token:=encode(public.gen_random_bytes(32),'hex');token_hash:=encode(public.digest(token,'sha256'),'hex');
  INSERT INTO lifecycle.erasure_tombstone_grants(tenant_id,xact,token_sha256)
   VALUES(app.current_organization_id(),pg_current_xact_id()::text,token_hash);
  prior_scope:=current_setting('lifecycle.erasure_tombstone_token',true);
  PERFORM set_config('lifecycle.erasure_tombstone_token',token,true);
  INSERT INTO platform.tombstones(organization_id,target_type,target_id,reason_code)
   VALUES(app.current_organization_id(),'artifact',item.artifact_id,'TENANT_ERASURE') ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted=ROW_COUNT;
  PERFORM set_config('lifecycle.erasure_tombstone_token',coalesce(prior_scope,''),true);
  DELETE FROM lifecycle.erasure_tombstone_grants g WHERE g.tenant_id=app.current_organization_id()
   AND g.xact=pg_current_xact_id()::text AND g.token_sha256=token_hash;
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
  AND EXISTS(SELECT 1 FROM lifecycle.erasure_tombstone_grants g WHERE g.tenant_id=tombstones.organization_id
   AND g.xact=pg_catalog.pg_current_xact_id()::text
   AND g.token_sha256=pg_catalog.encode(public.digest(coalesce(pg_catalog.current_setting('lifecycle.erasure_tombstone_token',true),''),'sha256'),'hex'))
  AND target_type='artifact' AND reason_code='TENANT_ERASURE'
  AND session_user='ensemus_app' AND knowledge.is_service_actor() AND lifecycle.erasure_open(organization_id) IS TRUE);
--> statement-breakpoint
CREATE FUNCTION billing.refuse_payment_webhook_inbox_conflict() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE prior text:=current_setting('billing.payment_org',true);opaque text:=current_setting('billing.payment_webhook_token',true);a record;b record;h text;expected uuid;
BEGIN
 IF TG_RELID<>'platform.inbox_events'::regclass OR TG_OP<>'INSERT' OR TG_WHEN<>'BEFORE' THEN
  RAISE EXCEPTION 'INVALID_PAYMENT_INBOX_TARGET' USING ERRCODE='42501';END IF;
 -- Not a payment delivery: M3's ordinary inbox dedupe is unchanged.
 IF opaque IS NULL OR opaque='' THEN RETURN NEW;END IF;
 IF session_user<>'ensemus_app' OR app.current_actor_type() IS DISTINCT FROM 'service' OR NEW.organization_id IS DISTINCT FROM app.current_organization_id()
  OR opaque!~'^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'PAYMENT_WEBHOOK_VERIFICATION_REQUIRED' USING ERRCODE='EN850';END IF;
 PERFORM set_config('billing.payment_org',NEW.organization_id::text,true);
 SELECT x.id,x.endpoint_id,x.processor,x.provider_event_id,x.account_namespace_sha256,x.execution_identity_sha256,x.fact_sha256 INTO a
  FROM billing.payment_webhook_attestations x WHERE x.organization_id=NEW.organization_id AND x.token_sha256=encode(public.digest(opaque,'sha256'),'hex');
 IF a.id IS NULL THEN RAISE EXCEPTION 'PAYMENT_WEBHOOK_VERIFICATION_REQUIRED' USING ERRCODE='EN850';END IF;
 -- Same compact JSON array and UUID slices as 0512's record_payment_webhook_inbox_birth.
 h:=encode(public.digest(convert_to('['||to_json(a.endpoint_id::text)::text||','||to_json(a.provider_event_id)::text||']','UTF8'),'sha256'),'hex');
 expected:=(substring(h,1,8)||'-'||substring(h,9,4)||'-5'||substring(h,14,3)||'-a'||substring(h,18,3)||'-'||substring(h,21,12))::uuid;
 IF NEW.consumer_id IS DISTINCT FROM 'webhook:'||a.endpoint_id::text OR NEW.event_id IS DISTINCT FROM expected THEN
  RAISE EXCEPTION 'PAYMENT_WEBHOOK_INBOX_MISMATCH' USING ERRCODE='EN850';END IF;
 -- Serializes payment-token inbox inserts per key until commit, so a concurrent changed delivery
 -- sees the birth attestation of the one that committed first instead of skipping the comparison.
 PERFORM pg_advisory_xact_lock(hashtextextended('payment_webhook_inbox:'||NEW.organization_id::text||':'||NEW.consumer_id||':'||NEW.event_id::text,0));
 SELECT x.id,x.processor,x.provider_event_id,x.account_namespace_sha256,x.execution_identity_sha256,x.fact_sha256 INTO b
  FROM billing.payment_webhook_attestations x WHERE x.organization_id=NEW.organization_id AND x.inbox_consumer_id=NEW.consumer_id
   AND x.inbox_event_id=NEW.event_id AND x.id<>a.id ORDER BY x.issued_at,x.id LIMIT 1;
 IF b.id IS NOT NULL AND(b.processor IS DISTINCT FROM a.processor OR b.provider_event_id IS DISTINCT FROM a.provider_event_id
  OR b.account_namespace_sha256 IS DISTINCT FROM a.account_namespace_sha256
  OR(b.execution_identity_sha256 IS NOT DISTINCT FROM a.execution_identity_sha256 AND b.fact_sha256 IS DISTINCT FROM a.fact_sha256)) THEN
  RAISE EXCEPTION 'PAYMENT_WEBHOOK_EVENT_CONFLICT' USING ERRCODE='EN850';END IF;
 PERFORM set_config('billing.payment_org',coalesce(prior,''),true);RETURN NEW;
EXCEPTION WHEN OTHERS THEN PERFORM set_config('billing.payment_org',coalesce(prior,''),true);RAISE;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION billing.refuse_payment_webhook_inbox_conflict() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER payment_webhook_inbox_conflict BEFORE INSERT ON platform.inbox_events FOR EACH ROW EXECUTE FUNCTION billing.refuse_payment_webhook_inbox_conflict();
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='lifecycle.prepare_erasure_artifacts(uuid,integer)'::regprocedure
   AND p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog'] AND p.prosrc LIKE '%erasure_tombstone_grants%'
   AND p.prosrc NOT LIKE '%erasure_tombstone_org%')
  OR has_function_privilege('public','lifecycle.prepare_erasure_artifacts(uuid,integer)','EXECUTE')
  OR NOT has_function_privilege('ensemus_app','lifecycle.prepare_erasure_artifacts(uuid,integer)','EXECUTE')
  OR NOT EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid='platform.tombstones'::regclass
   AND p.polname='erasure_artifact_tombstone_birth' AND p.polcmd='a' AND p.polpermissive
   AND p.polroles=ARRAY['ensemus_migrator'::regrole::oid]
   AND pg_get_expr(p.polwithcheck,p.polrelid) LIKE '%erasure_tombstone_grants%'
   AND pg_get_expr(p.polwithcheck,p.polrelid) NOT LIKE '%erasure_tombstone_org%')
  OR NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='lifecycle.erasure_tombstone_grants'::regclass
   AND c.relrowsecurity AND c.relforcerowsecurity AND pg_get_userbyid(c.relowner)='ensemus_migrator')
  OR EXISTS(SELECT 1 FROM unnest(ARRAY['ensemus_app','ensemus_agent','ensemus_secrets','ensemus_eraser']) r(role_name)
   CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) k(privilege)
   WHERE has_table_privilege(r.role_name,'lifecycle.erasure_tombstone_grants',k.privilege))
  OR NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid='platform.inbox_events'::regclass
   AND t.tgname='payment_webhook_inbox_conflict' AND NOT t.tgisinternal AND t.tgenabled='O'
   AND p.oid='billing.refuse_payment_webhook_inbox_conflict()'::regprocedure AND p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog'])
  OR has_function_privilege('public','billing.refuse_payment_webhook_inbox_conflict()','EXECUTE') THEN
  RAISE EXCEPTION 'R4_SAAS_GUARD_POSTCONDITION' USING ERRCODE='EN850';END IF;
END $$;
