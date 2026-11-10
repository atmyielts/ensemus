-- Unregistered early foundation. Apply before0417/0419, then0515's dependent rotation/proof code.
-- This initializes a protected current generation; it does not qualify historical input/body proof.
DO $$ BEGIN
 IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND(rolsuper OR rolbypassrls))
  OR pg_has_role(current_user,'ensemus_auth','member') THEN
  RAISE EXCEPTION 'MATERIAL_RESTORE_ANCHOR_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
END $$;
--> statement-breakpoint
ALTER TABLE org.organizations ADD COLUMN material_restore_generation uuid NOT NULL DEFAULT gen_random_uuid();
CREATE FUNCTION sovereign.guard_material_restore_generation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_RELID<>'org.organizations'::regclass OR TG_OP NOT IN('INSERT','UPDATE') THEN
    RAISE EXCEPTION 'MATERIAL_RESTORE_GENERATION_TARGET' USING ERRCODE='42501';END IF;
  IF TG_OP='INSERT' THEN NEW.material_restore_generation:=gen_random_uuid();RETURN NEW;END IF;
  IF NEW.material_restore_generation IS DISTINCT FROM OLD.material_restore_generation THEN
    IF current_user<>'ensemus_migrator' OR session_user<>'ensemus_migrator' OR app.current_actor_type() IS DISTINCT FROM 'service'
      OR NEW.id IS DISTINCT FROM OLD.id OR OLD.id IS DISTINCT FROM app.current_organization_id()
      OR current_setting('sovereign.material_restore_mode',true) IS DISTINCT FROM 'row'
      OR current_setting('sovereign.material_restore_org',true) IS DISTINCT FROM OLD.id::text
      OR current_setting('sovereign.material_restore_generation',true) IS DISTINCT FROM NEW.material_restore_generation::text THEN
      RAISE EXCEPTION 'MATERIAL_RESTORE_GENERATION_IMMUTABLE' USING ERRCODE='42501';END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION sovereign.guard_material_restore_generation() FROM PUBLIC;
CREATE TRIGGER organizations_material_restore_generation BEFORE INSERT OR UPDATE ON org.organizations FOR EACH ROW EXECUTE FUNCTION sovereign.guard_material_restore_generation();
CREATE POLICY material_restore_native_scan ON org.organizations FOR SELECT TO ensemus_migrator
  USING(current_user='ensemus_migrator' AND session_user='ensemus_migrator' AND current_setting('sovereign.material_restore_mode',true)='scan');
CREATE POLICY material_restore_native_read ON org.organizations FOR SELECT TO ensemus_migrator
  USING(current_user='ensemus_migrator' AND session_user='ensemus_migrator' AND current_setting('sovereign.material_restore_mode',true)='row'
    AND id=app.current_organization_id() AND id::text=current_setting('sovereign.material_restore_org',true));
CREATE POLICY material_restore_native_write ON org.organizations FOR UPDATE TO ensemus_migrator
  USING(current_user='ensemus_migrator' AND session_user='ensemus_migrator' AND current_setting('sovereign.material_restore_mode',true)='row'
    AND id=app.current_organization_id() AND id::text=current_setting('sovereign.material_restore_org',true))
  WITH CHECK(current_user='ensemus_migrator' AND session_user='ensemus_migrator' AND current_setting('sovereign.material_restore_mode',true)='row'
    AND id=app.current_organization_id() AND id::text=current_setting('sovereign.material_restore_org',true)
    AND material_restore_generation::text=current_setting('sovereign.material_restore_generation',true));
