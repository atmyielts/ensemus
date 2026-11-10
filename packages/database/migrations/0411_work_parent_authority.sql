-- Current Work -> project -> client authority, from retained ID-only metadata; no body recursion.
-- 0407's structured-record wrappers dispatch Work here after the complete migration gate.
CREATE FUNCTION knowledge.work_scope_class(p_work uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN c.parent_record_id IS NULL THEN c.classification
    WHEN parent.classification IS NULL THEN NULL
    WHEN knowledge.class_rank(c.classification)>=knowledge.class_rank(parent.classification) THEN c.classification
    ELSE parent.classification END
  FROM knowledge.structured_record_catalog c
  LEFT JOIN LATERAL (SELECT knowledge.structured_record_class('project',c.parent_record_id) AS classification) parent ON true
  WHERE c.organization_id=app.current_organization_id() AND c.record_kind='work_unit' AND c.record_id=p_work AND c.alive
    AND NOT EXISTS(SELECT 1 FROM platform.tombstones t WHERE t.organization_id=c.organization_id
      AND t.target_type='work_unit' AND t.target_id=c.record_id)
$$;
CREATE FUNCTION knowledge.work_scope_readable(p_work uuid,p_viewer uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM knowledge.structured_record_catalog c JOIN org.memberships m
    ON m.organization_id=c.organization_id AND m.id=p_viewer AND m.status='active'
    WHERE c.organization_id=app.current_organization_id() AND c.record_kind='work_unit' AND c.record_id=p_work AND c.alive
      AND NOT EXISTS(SELECT 1 FROM platform.tombstones t WHERE t.organization_id=c.organization_id
        AND t.target_type='work_unit' AND t.target_id=c.record_id)
      AND (c.classification IN ('public','internal') OR c.owner_membership_id=p_viewer
        OR (c.classification='confidential' AND m.role IN ('owner','admin'))
        OR EXISTS(SELECT 1 FROM knowledge.structured_work_assignments a WHERE a.organization_id=c.organization_id
          AND a.work_unit_id=c.record_id AND a.membership_id=p_viewer))
      AND (c.parent_record_id IS NULL OR knowledge.structured_record_readable('project',c.parent_record_id,p_viewer)))
$$;
REVOKE ALL ON FUNCTION knowledge.work_scope_class(uuid),knowledge.work_scope_readable(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.work_scope_class(uuid),knowledge.work_scope_readable(uuid,uuid) TO ensemus_app;
CREATE OR REPLACE FUNCTION knowledge.can_read_work(p_work_unit uuid,p_membership uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT knowledge.work_scope_readable(p_work_unit,p_membership)
$$;
--> statement-breakpoint
-- Preserve the public OID used by older parsed policies. Lock only current ID-only metadata, so a
-- concurrent reparenting, client floor change or named-reader revocation cannot pass admission with
-- a stale scope. NOWAIT avoids acquiring a partial closure while waiting on a reverse lock order.
CREATE OR REPLACE FUNCTION knowledge.lock_structured_record(p_kind text,p_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE parent_id uuid; client_id uuid;
BEGIN
  IF current_user<>'ensemus_migrator' OR app.current_organization_id() IS NULL OR p_id IS NULL
    OR p_kind IS NULL OR p_kind NOT IN ('work_unit','project','client','object_record') THEN
    RAISE EXCEPTION 'STRUCTURED_LOCK_TARGET_INVALID' USING ERRCODE='42501';
  END IF;
  IF p_kind='object_record' THEN RETURN objects.lock_record_authority(p_id); END IF;
  BEGIN
    SELECT c.parent_record_id INTO parent_id FROM knowledge.structured_record_catalog c
      WHERE c.organization_id=app.current_organization_id() AND c.record_kind=p_kind
        AND c.record_id=p_id AND c.alive FOR SHARE NOWAIT;
    IF NOT FOUND THEN RETURN false; END IF;
    IF p_kind='work_unit' AND parent_id IS NOT NULL THEN
      SELECT c.parent_record_id INTO client_id FROM knowledge.structured_record_catalog c
        WHERE c.organization_id=app.current_organization_id() AND c.record_kind='project'
          AND c.record_id=parent_id AND c.alive FOR SHARE NOWAIT;
      IF NOT FOUND THEN RETURN false; END IF;
    ELSIF p_kind='project' THEN client_id:=parent_id;
    END IF;
    IF client_id IS NOT NULL THEN
      PERFORM 1 FROM knowledge.structured_record_catalog c
        WHERE c.organization_id=app.current_organization_id() AND c.record_kind='client'
          AND c.record_id=client_id AND c.alive FOR SHARE NOWAIT;
      IF NOT FOUND THEN RETURN false; END IF;
    END IF;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'STRUCTURED_INPUT_BUSY' USING ERRCODE='55P03';
  END;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION knowledge.lock_structured_record(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.lock_structured_record(text,uuid) TO ensemus_app;
--> statement-breakpoint
-- INSERT RETURNING uses the actual row's project: a stable function cannot rely on a catalog row
-- inserted by that same statement. Keep existing own-Work DAL ABAC and close all parent body paths.
CREATE POLICY work_parent_authority ON work.work_units AS RESTRICTIVE TO ensemus_app
  USING(knowledge.is_service_actor() OR (EXISTS(SELECT 1 FROM org.memberships m WHERE m.organization_id=work_units.organization_id
    AND m.id=app.current_membership_id() AND m.user_id=app.current_user_id() AND m.status='active')
    AND (project_id IS NULL OR knowledge.structured_record_readable('project',project_id,app.current_membership_id()))))
  WITH CHECK(knowledge.is_service_actor() OR (EXISTS(SELECT 1 FROM org.memberships m WHERE m.organization_id=work_units.organization_id
    AND m.id=app.current_membership_id() AND m.user_id=app.current_user_id() AND m.status='active')
    AND (project_id IS NULL OR knowledge.structured_record_readable('project',project_id,app.current_membership_id()))));
