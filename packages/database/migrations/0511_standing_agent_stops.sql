-- Actual standing INSERT -> actual lifecycle UPDATE -> separately owned M4 stop. Requires0509.
-- No timestamp/xmin or caller-stamped admission establishes a transition's birth.
DO $$ BEGIN
 IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND(rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'STANDING_GUARD_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
END $$;
--> statement-breakpoint
CREATE TABLE lifecycle.standing_stop_receipts (
 organization_id uuid NOT NULL,standing_change_id uuid NOT NULL,
 birth_transaction text NOT NULL,applied_transaction text,applied_at timestamptz,
 requires_effect boolean NOT NULL DEFAULT false,release_requested boolean,
 switch_id uuid,settled_at timestamptz,
 CONSTRAINT standing_stop_receipts_pk PRIMARY KEY(organization_id,standing_change_id),
 CONSTRAINT standing_stop_org FOREIGN KEY(organization_id) REFERENCES org.organizations(id),
 CONSTRAINT standing_stop_switch FOREIGN KEY(switch_id) REFERENCES governance.kill_switches(id),
 CONSTRAINT standing_stop_switch_unique UNIQUE(switch_id),
 CONSTRAINT standing_stop_source FOREIGN KEY(organization_id,standing_change_id)
  REFERENCES billing.standing_changes(organization_id,id),
 CONSTRAINT standing_stop_applied CHECK((applied_transaction IS NULL)=(applied_at IS NULL)),
 CONSTRAINT standing_stop_settlement CHECK(settled_at IS NULL OR applied_transaction IS NOT NULL)
);
ALTER TABLE lifecycle.standing_stop_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE lifecycle.standing_stop_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY standing_receipt_fixed_owner ON lifecycle.standing_stop_receipts TO ensemus_migrator
 -- The generated deferred trigger pins NEW.organization_id even if an outer savepoint restored its GUCs.
 -- Only fixed metadata functions can read this table; app/agent have no table SELECT grant.
 USING(session_user IN('ensemus_app','ensemus_agent')
  AND organization_id::text=current_setting('lifecycle.standing_org',true))
 WITH CHECK(session_user='ensemus_app' AND organization_id=app.current_organization_id()
  AND organization_id::text=current_setting('lifecycle.standing_org',true));
REVOKE ALL ON lifecycle.standing_stop_receipts FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_eraser;
GRANT SELECT(id,lifecycle) ON org.organizations TO ensemus_migrator;
CREATE POLICY standing_org_fixed_read ON org.organizations FOR SELECT TO ensemus_migrator
 USING(session_user='ensemus_app' AND id=app.current_organization_id()
  AND id::text=current_setting('lifecycle.standing_org',true));
CREATE POLICY standing_org_fixed_lock ON org.organizations FOR UPDATE TO ensemus_migrator
 USING(session_user='ensemus_app' AND id=app.current_organization_id()
  AND id::text=current_setting('lifecycle.standing_org',true)) WITH CHECK(false);
GRANT SELECT(organization_id,id,from_lifecycle,to_lifecycle,reason_code) ON billing.standing_changes TO ensemus_migrator;
CREATE POLICY standing_source_fixed_read ON billing.standing_changes FOR SELECT TO ensemus_migrator
 USING(session_user='ensemus_app' AND organization_id=app.current_organization_id()
  AND organization_id::text=current_setting('lifecycle.standing_org',true));
CREATE POLICY standing_switch_fixed_owner ON governance.kill_switches TO ensemus_migrator
 USING(session_user='ensemus_app' AND organization_id=app.current_organization_id()
  AND organization_id::text=current_setting('lifecycle.standing_org',true)
  AND scope='organization' AND target_ref IS NULL AND reason_code='TENANT_STANDING')
 WITH CHECK(session_user='ensemus_app' AND organization_id=app.current_organization_id()
  AND organization_id::text=current_setting('lifecycle.standing_org',true)
  AND scope='organization' AND target_ref IS NULL AND reason_code='TENANT_STANDING');
--> statement-breakpoint

CREATE FUNCTION lifecycle.record_standing_birth() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE prior text:=current_setting('lifecycle.standing_org',true);current_state text;
BEGIN
 IF TG_RELID<>'billing.standing_changes'::regclass OR TG_OP<>'INSERT' OR session_user<>'ensemus_app'
  OR NEW.organization_id IS DISTINCT FROM app.current_organization_id()
  OR coalesce(app.current_actor_type(),'') NOT IN('user','service') THEN
  RAISE EXCEPTION 'STANDING_STOP_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 PERFORM set_config('lifecycle.standing_org',NEW.organization_id::text,true);
 SELECT o.lifecycle INTO current_state FROM org.organizations o WHERE o.id=NEW.organization_id FOR NO KEY UPDATE NOWAIT;
 IF current_state IS DISTINCT FROM NEW.from_lifecycle OR NEW.to_lifecycle=NEW.from_lifecycle THEN
  RAISE EXCEPTION 'STANDING_STOP_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 INSERT INTO lifecycle.standing_stop_receipts(organization_id,standing_change_id,birth_transaction)
 VALUES(NEW.organization_id,NEW.id,pg_current_xact_id()::text);
 PERFORM set_config('lifecycle.standing_org',coalesce(prior,''),true);RETURN NEW;
EXCEPTION WHEN OTHERS THEN
 PERFORM set_config('lifecycle.standing_org',coalesce(prior,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION lifecycle.record_standing_birth() FROM PUBLIC;
CREATE TRIGGER standing_birth AFTER INSERT ON billing.standing_changes FOR EACH ROW EXECUTE FUNCTION lifecycle.record_standing_birth();

CREATE FUNCTION lifecycle.apply_standing_birth() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE prior text:=current_setting('lifecycle.standing_org',true);ids uuid[];needs_effect boolean;
BEGIN
 IF TG_RELID<>'org.organizations'::regclass OR TG_OP<>'UPDATE' THEN
  RAISE EXCEPTION 'STANDING_STOP_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 IF NEW.lifecycle=OLD.lifecycle THEN RETURN NEW;END IF;
 IF session_user<>'ensemus_app' OR NEW.id IS DISTINCT FROM app.current_organization_id() THEN
  RAISE EXCEPTION 'STANDING_STOP_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 PERFORM set_config('lifecycle.standing_org',NEW.id::text,true);
 SELECT array_agg(r.standing_change_id) INTO ids FROM lifecycle.standing_stop_receipts r
 JOIN billing.standing_changes s ON s.organization_id=r.organization_id AND s.id=r.standing_change_id
 WHERE r.organization_id=NEW.id AND r.birth_transaction=pg_current_xact_id()::text AND r.applied_transaction IS NULL
  AND s.from_lifecycle=OLD.lifecycle AND s.to_lifecycle=NEW.lifecycle;
 IF coalesce(cardinality(ids),0)<>1 THEN RAISE EXCEPTION 'STANDING_STOP_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 -- Offboarding and its cancellation have their independently owned0508 admission/stop. Do not duplicate it.
 needs_effect:=OLD.lifecycle<>'offboarding' AND NEW.lifecycle IN('active','read_only','suspended');
 IF needs_effect AND app.current_actor_type() IS DISTINCT FROM 'service' THEN
  RAISE EXCEPTION 'STANDING_STOP_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 UPDATE lifecycle.standing_stop_receipts SET applied_transaction=pg_current_xact_id()::text,applied_at=clock_timestamp(),
  requires_effect=needs_effect,release_requested=CASE WHEN needs_effect THEN NEW.lifecycle='active' ELSE NULL END
 WHERE organization_id=NEW.id AND standing_change_id=ids[1];
 PERFORM set_config('lifecycle.standing_org',coalesce(prior,''),true);RETURN NEW;
EXCEPTION WHEN OTHERS THEN
 PERFORM set_config('lifecycle.standing_org',coalesce(prior,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION lifecycle.apply_standing_birth() FROM PUBLIC;
CREATE TRIGGER standing_birth_applied AFTER UPDATE OF lifecycle ON org.organizations FOR EACH ROW EXECUTE FUNCTION lifecycle.apply_standing_birth();

CREATE FUNCTION lifecycle.require_standing_stop() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE prior text:=current_setting('lifecycle.standing_org',true);settled timestamptz;
BEGIN
 IF TG_RELID<>'lifecycle.standing_stop_receipts'::regclass OR TG_OP<>'UPDATE' THEN
  RAISE EXCEPTION 'STANDING_STOP_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 IF NEW.requires_effect AND OLD.applied_transaction IS NULL AND NEW.applied_transaction IS NOT NULL THEN
  PERFORM set_config('lifecycle.standing_org',NEW.organization_id::text,true);
  SELECT r.settled_at INTO settled FROM lifecycle.standing_stop_receipts r
   WHERE r.organization_id=NEW.organization_id AND r.standing_change_id=NEW.standing_change_id;
  IF settled IS NULL THEN RAISE EXCEPTION 'STANDING_STOP_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 END IF;
 PERFORM set_config('lifecycle.standing_org',coalesce(prior,''),true);RETURN NEW;
EXCEPTION WHEN OTHERS THEN
 PERFORM set_config('lifecycle.standing_org',coalesce(prior,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION lifecycle.require_standing_stop() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER standing_stop_required AFTER UPDATE ON lifecycle.standing_stop_receipts
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION lifecycle.require_standing_stop();
--> statement-breakpoint

CREATE FUNCTION lifecycle.standing_agent_stop(p_reason text,p_release boolean)
 RETURNS TABLE(switch_id uuid,changed boolean) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE prior text:=current_setting('lifecycle.standing_org',true);state text;receipt record;stop uuid;made boolean:=false;
BEGIN
 IF session_user<>'ensemus_app' OR app.current_actor_type() IS DISTINCT FROM 'service' OR app.current_organization_id() IS NULL
  OR p_reason IS NULL OR p_reason!~'^[A-Z][A-Z0-9_]{0,63}$' OR p_release IS NULL THEN
  RAISE EXCEPTION 'STANDING_STOP_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 PERFORM set_config('lifecycle.standing_org',app.current_organization_id()::text,true);
 SELECT o.lifecycle INTO state FROM org.organizations o WHERE o.id=app.current_organization_id() FOR NO KEY UPDATE NOWAIT;
 IF state IS NULL OR(p_release AND state<>'active') OR(NOT p_release AND state NOT IN('read_only','suspended')) THEN
  RAISE EXCEPTION 'STANDING_STOP_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 SELECT r.* INTO receipt FROM lifecycle.standing_stop_receipts r JOIN billing.standing_changes s
  ON s.organization_id=r.organization_id AND s.id=r.standing_change_id
 WHERE r.organization_id=app.current_organization_id() AND r.requires_effect AND r.release_requested=p_release
  AND r.applied_transaction IS NOT NULL AND s.to_lifecycle=state AND s.reason_code=p_reason
 ORDER BY(r.applied_transaction=pg_current_xact_id()::text) DESC,r.applied_at DESC,r.standing_change_id DESC LIMIT 1 FOR UPDATE OF r;
 IF receipt.standing_change_id IS NULL THEN RAISE EXCEPTION 'STANDING_STOP_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 IF receipt.settled_at IS NOT NULL THEN
  RETURN QUERY SELECT receipt.switch_id::uuid,false;
 ELSE
  IF receipt.birth_transaction<>pg_current_xact_id()::text OR receipt.applied_transaction<>pg_current_xact_id()::text THEN
   RAISE EXCEPTION 'STANDING_STOP_UNCONFIRMED' USING ERRCODE='EN850';END IF;
  IF p_release THEN
   FOR stop IN SELECT k.id FROM governance.kill_switches k JOIN lifecycle.standing_stop_receipts r
    ON r.organization_id=k.organization_id AND r.switch_id=k.id WHERE r.organization_id=app.current_organization_id()
     AND k.scope='organization' AND k.target_ref IS NULL AND k.reason_code='TENANT_STANDING' AND k.released_at IS NULL
     ORDER BY k.id FOR UPDATE OF k LOOP
    UPDATE governance.kill_switches k SET released_at=clock_timestamp() WHERE k.id=stop;
    made:=true;RETURN QUERY SELECT stop,true;
   END LOOP;
   IF NOT made THEN RETURN QUERY SELECT NULL::uuid,false;END IF;
  ELSE
   INSERT INTO governance.kill_switches(organization_id,scope,reason_code)
    VALUES(app.current_organization_id(),'organization','TENANT_STANDING') RETURNING id INTO stop;
   UPDATE lifecycle.standing_stop_receipts SET switch_id=stop
    WHERE organization_id=receipt.organization_id AND standing_change_id=receipt.standing_change_id;
   RETURN QUERY SELECT stop,true;
  END IF;
  UPDATE lifecycle.standing_stop_receipts SET settled_at=clock_timestamp()
   WHERE organization_id=receipt.organization_id AND standing_change_id=receipt.standing_change_id;
 END IF;
 PERFORM set_config('lifecycle.standing_org',coalesce(prior,''),true);
EXCEPTION WHEN OTHERS THEN
 PERFORM set_config('lifecycle.standing_org',coalesce(prior,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION lifecycle.standing_agent_stop(text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle.standing_agent_stop(text,boolean) TO ensemus_app;

CREATE FUNCTION lifecycle.protect_standing_stop() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE prior text:=current_setting('lifecycle.standing_org',true);owned boolean;
BEGIN
 IF TG_RELID<>'governance.kill_switches'::regclass OR TG_OP<>'UPDATE' THEN
  RAISE EXCEPTION 'STANDING_STOP_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 IF OLD.released_at IS NOT NULL OR NEW.released_at IS NULL OR OLD.organization_id IS NULL THEN RETURN NEW;END IF;
 PERFORM set_config('lifecycle.standing_org',OLD.organization_id::text,true);
 SELECT EXISTS(SELECT 1 FROM lifecycle.standing_stop_receipts r WHERE r.organization_id=OLD.organization_id AND r.switch_id=OLD.id) INTO owned;
 IF owned AND(session_user<>'ensemus_app' OR app.current_actor_type() IS DISTINCT FROM 'service'
  OR OLD.organization_id IS DISTINCT FROM app.current_organization_id() OR NOT EXISTS(
   SELECT 1 FROM lifecycle.standing_stop_receipts r JOIN org.organizations o ON o.id=r.organization_id
   WHERE r.organization_id=OLD.organization_id AND o.lifecycle='active' AND r.requires_effect AND r.release_requested
    AND r.birth_transaction=pg_current_xact_id()::text AND r.applied_transaction=pg_current_xact_id()::text AND r.settled_at IS NULL)) THEN
  RAISE EXCEPTION 'STANDING_STOP_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 PERFORM set_config('lifecycle.standing_org',coalesce(prior,''),true);RETURN NEW;
EXCEPTION WHEN OTHERS THEN
 PERFORM set_config('lifecycle.standing_org',coalesce(prior,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION lifecycle.protect_standing_stop() FROM PUBLIC;
CREATE TRIGGER kill_switch_standing_release BEFORE UPDATE ON governance.kill_switches FOR EACH ROW EXECUTE FUNCTION lifecycle.protect_standing_stop();

CREATE FUNCTION lifecycle.keep_standing_receipt() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_RELID<>'lifecycle.standing_stop_receipts'::regclass OR TG_OP<>'UPDATE' OR current_user<>'ensemus_migrator'
  OR NEW.organization_id<>OLD.organization_id OR NEW.standing_change_id<>OLD.standing_change_id OR NEW.birth_transaction<>OLD.birth_transaction
  OR(OLD.applied_transaction IS NOT NULL AND(NEW.applied_transaction IS DISTINCT FROM OLD.applied_transaction
    OR NEW.applied_at IS DISTINCT FROM OLD.applied_at OR NEW.requires_effect IS DISTINCT FROM OLD.requires_effect
    OR NEW.release_requested IS DISTINCT FROM OLD.release_requested))
  OR(OLD.switch_id IS NOT NULL AND NEW.switch_id IS DISTINCT FROM OLD.switch_id)
  OR(OLD.settled_at IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
  RAISE EXCEPTION 'STANDING_STOP_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION lifecycle.keep_standing_receipt() FROM PUBLIC;
CREATE TRIGGER standing_receipt_change BEFORE UPDATE ON lifecycle.standing_stop_receipts FOR EACH ROW EXECUTE FUNCTION lifecycle.keep_standing_receipt();
CREATE TRIGGER standing_receipt_keep BEFORE DELETE OR TRUNCATE ON lifecycle.standing_stop_receipts FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint

-- The service's lifecycle-only effect uses actual INSERT birth. It does not impersonate an interactive
-- person, and cannot use an old/updated row or a forged selector as authority for another field.
CREATE FUNCTION lifecycle.service_standing_birth(p_org uuid,p_from text,p_to text) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE prior text:=current_setting('lifecycle.standing_org',true);matches integer;
BEGIN
 IF session_user<>'ensemus_app' OR app.current_actor_type() IS DISTINCT FROM 'service'
  OR p_org IS DISTINCT FROM app.current_organization_id() OR p_org IS NULL OR p_from IS NULL OR p_to IS NULL OR p_from=p_to THEN
  RETURN false;END IF;
 PERFORM set_config('lifecycle.standing_org',p_org::text,true);
 SELECT count(*)::integer INTO matches FROM lifecycle.standing_stop_receipts r
 JOIN billing.standing_changes s ON s.organization_id=r.organization_id AND s.id=r.standing_change_id
 WHERE r.organization_id=p_org AND r.birth_transaction=pg_current_xact_id()::text AND r.applied_transaction IS NULL
  AND s.from_lifecycle=p_from AND s.to_lifecycle=p_to;
 PERFORM set_config('lifecycle.standing_org',coalesce(prior,''),true);RETURN matches=1;
EXCEPTION WHEN OTHERS THEN
 PERFORM set_config('lifecycle.standing_org',coalesce(prior,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION lifecycle.service_standing_birth(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle.service_standing_birth(uuid,text,text) TO ensemus_app;

-- Preserve the original function OID and human/agent MFA+SSO fallback. The fixed predicate reads only
-- the current transaction's genuine witness; no generic service role or custom GUC waives the guard.
CREATE OR REPLACE FUNCTION org.guard_organization_management() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_RELID<>'org.organizations'::regclass OR TG_OP<>'UPDATE' THEN
  RAISE EXCEPTION 'INTERACTIVE_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
 IF current_user='ensemus_app' AND session_user='ensemus_app' AND app.current_actor_type()='service'
  AND NEW.id=app.current_organization_id() AND NEW.lifecycle<>OLD.lifecycle
  AND(to_jsonb(NEW)-'lifecycle') IS NOT DISTINCT FROM(to_jsonb(OLD)-'lifecycle')
  AND lifecycle.service_standing_birth(NEW.id,OLD.lifecycle,NEW.lifecycle) THEN RETURN NEW;END IF;
 IF current_user IN('ensemus_app','ensemus_agent') AND
  (NEW.id IS DISTINCT FROM app.current_organization_id() OR NOT app.interactive_privilege_allowed('organization.manage')) THEN
  RAISE EXCEPTION 'MFA_REQUIRED' USING ERRCODE='EN405';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION org.guard_organization_management() FROM PUBLIC;

--> statement-breakpoint
-- 0508's fixed stop function locks the actual native-admitted intent. PostgreSQL also applies UPDATE
-- USING to SELECT FOR UPDATE; its existing metadata SELECT policy alone silently hides that row.
-- This permits a lock only. It cannot UPDATE the row, and does not mint or relax native admission.
-- Match the retained original requester, not the current cancelling owner: another current owner may
-- cancel through the existing native manager path without pretending to be the original requester.
CREATE POLICY offboarding_stop_native_lock ON lifecycle.offboardings FOR UPDATE TO ensemus_migrator
 USING(session_user='ensemus_app' AND app.current_actor_type() IN('user','service')
  AND organization_id=app.current_organization_id()
  AND EXISTS(SELECT 1 FROM lifecycle.offboarding_admissions a
   WHERE a.organization_id=offboardings.organization_id AND a.offboarding_id=offboardings.id
    AND a.requested_by_membership_id=offboardings.requested_by_membership_id))
 WITH CHECK(false);
