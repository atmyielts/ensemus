-- FLAGGED FOR HUMAN SECURITY REVIEW
-- Before-put records own only keys below the skill prefix. Superseded records
-- retain physical cleanup debt even if the application lost the PUT response.
CREATE TABLE skills.bundle_uploads (
  organization_id uuid NOT NULL REFERENCES org.organizations(id),
  id uuid NOT NULL,
  package_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  bundle_sha256 text NOT NULL CHECK (bundle_sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 8388608),
  state text NOT NULL DEFAULT 'writing' CHECK (state IN ('writing','attached','superseded')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,id),
  FOREIGN KEY (organization_id,package_id) REFERENCES skills.packages(organization_id,id),
  FOREIGN KEY (organization_id,membership_id) REFERENCES org.memberships(organization_id,id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX skill_bundle_upload_one_writer
  ON skills.bundle_uploads(organization_id,package_id,bundle_sha256) WHERE state='writing';
--> statement-breakpoint
ALTER TABLE skills.bundle_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE skills.bundle_uploads FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT (organization_id,id,package_id,membership_id,bundle_sha256,size_bytes),
  UPDATE (state) ON skills.bundle_uploads TO ensemus_app;
--> statement-breakpoint
CREATE POLICY skill_upload_tenant ON skills.bundle_uploads TO ensemus_app
  USING (organization_id=app.current_organization_id() AND app.current_actor_type()='user')
  WITH CHECK (organization_id=app.current_organization_id() AND app.current_actor_type()='user');
--> statement-breakpoint
CREATE FUNCTION skills.check_bundle_upload() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN
  IF session_user<>'ensemus_app' OR current_user<>session_user
    OR NEW.organization_id IS DISTINCT FROM app.current_organization_id()
    OR app.current_actor_type() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'SKILL_UPLOAD_MANAGER_REQUIRED' USING ERRCODE='42501';
  END IF;
  IF app.interactive_privilege_allowed('skill.manage') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'MFA_REQUIRED' USING ERRCODE='EN405';
  END IF;

  IF TG_OP='INSERT' THEN
    IF NEW.membership_id IS DISTINCT FROM app.current_membership_id() OR NEW.state<>'writing'
      OR NOT EXISTS (SELECT 1 FROM skills.packages p WHERE p.organization_id=NEW.organization_id
        AND p.id=NEW.package_id AND p.origin='tenant' AND p.state='active') THEN
      RAISE EXCEPTION 'SKILL_UPLOAD_NOT_ADMITTED' USING ERRCODE='ES001';
    END IF;
  ELSIF NOT COALESCE(OLD.state='writing' AND (
    (NEW.state='superseded' AND clock_timestamp() >= OLD.created_at + interval '2 minutes')
    OR (NEW.state='attached' AND OLD.membership_id=app.current_membership_id()
      AND EXISTS (SELECT 1 FROM skills.package_versions v
        WHERE v.organization_id=NEW.organization_id AND v.id=NEW.id
          AND v.package_id=NEW.package_id AND v.uploaded_by_membership_id=NEW.membership_id
          AND v.bundle_sha256=NEW.bundle_sha256 AND v.size_bytes=NEW.size_bytes
          AND v.bundle_object_key=NEW.organization_id::text||'/skills/'||NEW.id::text))
  ),false) THEN
    RAISE EXCEPTION 'SKILL_UPLOAD_TRANSITION_INVALID' USING ERRCODE='ES001';
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION skills.check_bundle_upload() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER skill_bundle_upload_check BEFORE INSERT OR UPDATE ON skills.bundle_uploads
FOR EACH ROW EXECUTE FUNCTION skills.check_bundle_upload();
CREATE TRIGGER lifecycle_erasure_birth_fence BEFORE INSERT ON skills.bundle_uploads
FOR EACH ROW EXECUTE FUNCTION lifecycle.refuse_erasing_birth();
--> statement-breakpoint
SELECT identity.extend_auth_restore_admission();
--> statement-breakpoint
CREATE POLICY portable_pending_probe ON skills.bundle_uploads FOR SELECT TO ensemus_migrator
  USING (organization_id=app.current_organization_id());
--> statement-breakpoint
DO $migration$
DECLARE
  probe text := pg_get_functiondef('sovereign.pending_modules_empty()'::regprocedure);
  advance text := pg_get_functiondef('sovereign.advance_pending_module_epoch()'::regprocedure);
  probe_anchor constant text :=
    'OR EXISTS(SELECT 1 FROM skills.packages WHERE organization_id=app.current_organization_id())';
  advance_anchor constant text := 'WHEN ''skills.packages''::regclass THEN columns:=ARRAY[''organization_id''];';
BEGIN
  IF strpos(probe,probe_anchor)=0 OR strpos(advance,advance_anchor)=0 THEN
    RAISE EXCEPTION 'SKILL_UPLOAD_PORTABILITY_GUARD_CHANGED' USING ERRCODE='EN301';
  END IF;
  EXECUTE replace(probe,probe_anchor,probe_anchor||' OR EXISTS(SELECT 1 FROM skills.bundle_uploads
    WHERE organization_id=app.current_organization_id())');
  EXECUTE replace(advance,advance_anchor,advance_anchor||
    ' WHEN ''skills.bundle_uploads''::regclass THEN columns:=ARRAY[''organization_id''];');
END $migration$;
--> statement-breakpoint
CREATE TRIGGER portable_pending_epoch AFTER INSERT OR UPDATE ON skills.bundle_uploads
FOR EACH ROW EXECUTE FUNCTION sovereign.advance_pending_module_epoch();
