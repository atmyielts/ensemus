-- Exhaustive structured reads join 0208's artifact/knowledge inputs. Human review required.
-- No record body is copied. Historical read hashes are provenance, never a live mutable hash gate.
ALTER TABLE knowledge.artifact_lineage ADD COLUMN structured_inventory_complete boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE TABLE knowledge.structured_record_catalog (
  organization_id uuid NOT NULL REFERENCES org.organizations(id), record_kind text NOT NULL,
  record_id uuid NOT NULL, classification text, owner_membership_id uuid, parent_record_id uuid,
  alive boolean NOT NULL, PRIMARY KEY(organization_id,record_kind,record_id),
  CONSTRAINT structured_record_catalog_shape CHECK(record_kind IN ('work_unit','project','client')
    AND ((record_kind='project' AND classification IS NULL AND owner_membership_id IS NULL)
      OR (record_kind<>'project' AND classification IS NOT NULL AND classification IN ('public','internal','confidential','restricted'))))
);
CREATE TABLE knowledge.structured_work_assignments (
  organization_id uuid NOT NULL, work_unit_id uuid NOT NULL, membership_id uuid NOT NULL,
  PRIMARY KEY(organization_id,work_unit_id,membership_id)
);
CREATE TABLE knowledge.artifact_lineage_records (
  organization_id uuid NOT NULL, artifact_id uuid NOT NULL, record_kind text NOT NULL,
  record_id uuid NOT NULL, record_sha256 text NOT NULL, classification text NOT NULL,
  PRIMARY KEY(organization_id,artifact_id,record_kind,record_id,record_sha256),
  FOREIGN KEY(organization_id,artifact_id) REFERENCES knowledge.artifact_lineage(organization_id,artifact_id),
  FOREIGN KEY(organization_id,record_kind,record_id)
    REFERENCES knowledge.structured_record_catalog(organization_id,record_kind,record_id),
  CONSTRAINT artifact_lineage_records_shape CHECK(record_kind IN ('work_unit','project','client')
    AND record_sha256 ~ '^[0-9a-f]{64}$' AND classification IN ('public','internal','confidential','restricted'))
);
CREATE INDEX artifact_lineage_records_source_idx ON knowledge.artifact_lineage_records(organization_id,record_kind,record_id);
--> statement-breakpoint
-- Migration-only metadata backfill policies. No names, objectives, status text or record bodies read.
CREATE POLICY structured_0211_backfill ON work.work_units FOR SELECT TO ensemus_migrator USING(true);
CREATE POLICY structured_0211_backfill ON work.projects FOR SELECT TO ensemus_migrator USING(true);
CREATE POLICY structured_0211_backfill ON work.clients FOR SELECT TO ensemus_migrator USING(true);
CREATE POLICY structured_0211_backfill ON work.work_assignments FOR SELECT TO ensemus_migrator USING(true);
INSERT INTO knowledge.structured_record_catalog(organization_id,record_kind,record_id,classification,owner_membership_id,parent_record_id,alive)
  SELECT organization_id,'work_unit',id,classification,owner_membership_id,project_id,true FROM work.work_units
  UNION ALL SELECT organization_id,'project',id,NULL::text,NULL::uuid,client_id,true FROM work.projects
  UNION ALL SELECT organization_id,'client',id,classification,owner_membership_id,NULL::uuid,true FROM work.clients;
INSERT INTO knowledge.structured_work_assignments SELECT organization_id,work_unit_id,membership_id FROM work.work_assignments;
DROP POLICY structured_0211_backfill ON work.work_units;
DROP POLICY structured_0211_backfill ON work.projects;
DROP POLICY structured_0211_backfill ON work.clients;
DROP POLICY structured_0211_backfill ON work.work_assignments;
--> statement-breakpoint
ALTER TABLE knowledge.structured_record_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge.structured_record_catalog FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON knowledge.structured_record_catalog FOR SELECT TO ensemus_app USING(organization_id=app.current_organization_id());
CREATE POLICY catalog_read ON knowledge.structured_record_catalog FOR SELECT TO ensemus_migrator USING(organization_id=app.current_organization_id());
CREATE POLICY catalog_writer ON knowledge.structured_record_catalog TO ensemus_migrator
  USING(organization_id=app.current_organization_id() AND pg_trigger_depth()>0)
  WITH CHECK(organization_id=app.current_organization_id() AND pg_trigger_depth()>0);
CREATE POLICY catalog_lock ON knowledge.structured_record_catalog FOR UPDATE TO ensemus_migrator
  USING(organization_id=app.current_organization_id()) WITH CHECK(false);
ALTER TABLE knowledge.structured_work_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge.structured_work_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON knowledge.structured_work_assignments FOR SELECT TO ensemus_app USING(organization_id=app.current_organization_id());
CREATE POLICY catalog_writer ON knowledge.structured_work_assignments TO ensemus_migrator
  USING(organization_id=app.current_organization_id() AND pg_trigger_depth()>0)
  WITH CHECK(organization_id=app.current_organization_id() AND pg_trigger_depth()>0);
ALTER TABLE knowledge.artifact_lineage_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge.artifact_lineage_records FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scoped ON knowledge.artifact_lineage_records TO ensemus_app
  USING(organization_id=app.current_organization_id()) WITH CHECK(organization_id=app.current_organization_id());
GRANT SELECT ON knowledge.structured_record_catalog,knowledge.structured_work_assignments TO ensemus_app;
GRANT SELECT,INSERT ON knowledge.artifact_lineage_records TO ensemus_app;
--> statement-breakpoint
-- Fixed invoker targets expose only the same metadata as their triggering row. A deleted identity
-- cannot be silently revived while a retained historical input still refers to it.
CREATE FUNCTION knowledge.track_structured_record_acl() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE row_org uuid; row_id uuid; kind text; parent_id uuid; owner_id uuid; record_class text;
BEGIN
  IF TG_RELID NOT IN ('work.work_units'::regclass,'work.projects'::regclass,'work.clients'::regclass,'work.work_assignments'::regclass,'work.client_readers'::regclass)
    OR TG_TABLE_SCHEMA<>'work' OR TG_OP NOT IN ('INSERT','UPDATE','DELETE') THEN
    RAISE EXCEPTION 'STRUCTURED_CATALOG_TARGET_INVALID' USING ERRCODE='42501';
  END IF;
  row_org:=CASE WHEN TG_OP='DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
  IF row_org IS DISTINCT FROM app.current_organization_id()
    OR (TG_OP='UPDATE' AND NEW.organization_id IS DISTINCT FROM OLD.organization_id) THEN
    RAISE EXCEPTION 'STRUCTURED_CATALOG_TENANT_INVALID' USING ERRCODE='42501';
  END IF;
  IF TG_RELID='work.client_readers'::regclass THEN
    IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'STRUCTURED_ACL_REFERENCE_IMMUTABLE' USING ERRCODE='42501'; END IF;
    PERFORM 1 FROM knowledge.structured_record_catalog c WHERE c.organization_id=row_org AND c.record_kind='client'
      AND c.record_id=CASE WHEN TG_OP='DELETE' THEN OLD.client_id ELSE NEW.client_id END FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'STRUCTURED_ACL_RECORD_MISSING' USING ERRCODE='EN118'; END IF;
  ELSIF TG_RELID='work.work_assignments'::regclass THEN
    PERFORM 1 FROM knowledge.structured_record_catalog c WHERE c.organization_id=row_org AND c.record_kind='work_unit'
      AND (c.record_id=CASE WHEN TG_OP='DELETE' THEN OLD.work_unit_id ELSE NEW.work_unit_id END
        OR (TG_OP='UPDATE' AND c.record_id=OLD.work_unit_id)) ORDER BY c.record_id FOR UPDATE;
    IF TG_OP IN ('UPDATE','DELETE') THEN DELETE FROM knowledge.structured_work_assignments
      WHERE organization_id=row_org AND work_unit_id=OLD.work_unit_id AND membership_id=OLD.membership_id; END IF;
    IF TG_OP<>'DELETE' THEN INSERT INTO knowledge.structured_work_assignments VALUES(row_org,NEW.work_unit_id,NEW.membership_id) ON CONFLICT DO NOTHING; END IF;
  ELSE
    kind:=CASE TG_RELID WHEN 'work.work_units'::regclass THEN 'work_unit' WHEN 'work.projects'::regclass THEN 'project' ELSE 'client' END;
    row_id:=CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
    IF TG_OP='DELETE' THEN UPDATE knowledge.structured_record_catalog SET alive=false
      WHERE organization_id=row_org AND record_kind=kind AND record_id=row_id;
    ELSE
      IF TG_RELID='work.projects'::regclass THEN parent_id:=NEW.client_id; owner_id:=NULL; record_class:=NULL;
      ELSIF TG_RELID='work.work_units'::regclass THEN parent_id:=NEW.project_id; owner_id:=NEW.owner_membership_id; record_class:=NEW.classification;
      ELSE parent_id:=NULL; owner_id:=NEW.owner_membership_id; record_class:=NEW.classification; END IF;
      IF EXISTS(SELECT 1 FROM knowledge.structured_record_catalog c WHERE c.organization_id=row_org
        AND c.record_kind=kind AND c.record_id=row_id AND NOT c.alive) THEN
        RAISE EXCEPTION 'STRUCTURED_RECORD_ID_REUSE' USING ERRCODE='EN118';
      END IF;
      INSERT INTO knowledge.structured_record_catalog(organization_id,record_kind,record_id,classification,owner_membership_id,parent_record_id,alive)
        VALUES(row_org,kind,row_id,record_class,owner_id,parent_id,true)
        ON CONFLICT(organization_id,record_kind,record_id) DO UPDATE SET classification=EXCLUDED.classification,
          owner_membership_id=EXCLUDED.owner_membership_id,parent_record_id=EXCLUDED.parent_record_id;
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION knowledge.track_structured_record_acl() FROM PUBLIC;
CREATE TRIGGER structured_work_catalog BEFORE INSERT OR UPDATE OF classification,owner_membership_id,project_id OR DELETE ON work.work_units
  FOR EACH ROW EXECUTE FUNCTION knowledge.track_structured_record_acl();
CREATE TRIGGER structured_project_catalog BEFORE INSERT OR UPDATE OF client_id OR DELETE ON work.projects
  FOR EACH ROW EXECUTE FUNCTION knowledge.track_structured_record_acl();
CREATE TRIGGER structured_client_catalog BEFORE INSERT OR UPDATE OF classification,owner_membership_id,access_version OR DELETE ON work.clients
  FOR EACH ROW EXECUTE FUNCTION knowledge.track_structured_record_acl();
CREATE TRIGGER structured_assignment_catalog BEFORE INSERT OR UPDATE OR DELETE ON work.work_assignments
  FOR EACH ROW EXECUTE FUNCTION knowledge.track_structured_record_acl();
CREATE TRIGGER structured_client_reader_lock BEFORE INSERT OR DELETE ON work.client_readers
  FOR EACH ROW EXECUTE FUNCTION knowledge.track_structured_record_acl();
--> statement-breakpoint
CREATE FUNCTION knowledge.structured_record_class(p_kind text,p_id uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN c.record_kind='project' THEN CASE WHEN c.parent_record_id IS NULL THEN 'internal'
    ELSE (SELECT parent.classification FROM knowledge.structured_record_catalog parent
      WHERE parent.organization_id=c.organization_id AND parent.record_kind='client' AND parent.record_id=c.parent_record_id AND parent.alive
        AND NOT EXISTS(SELECT 1 FROM platform.tombstones t WHERE t.organization_id=parent.organization_id AND t.target_type='client' AND t.target_id=parent.record_id)) END
    ELSE c.classification END
  FROM knowledge.structured_record_catalog c WHERE c.organization_id=app.current_organization_id()
    AND c.record_kind=p_kind AND c.record_id=p_id AND c.alive
    AND NOT EXISTS(SELECT 1 FROM platform.tombstones t WHERE t.organization_id=c.organization_id AND t.target_type=c.record_kind AND t.target_id=c.record_id)
$$;
-- Named-viewer decision: service inspection never replaces the actual viewer with a service bypass.
CREATE FUNCTION knowledge.structured_record_readable(p_kind text,p_id uuid,p_viewer uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(EXISTS(SELECT 1 FROM knowledge.structured_record_catalog c JOIN org.memberships m
    ON m.organization_id=c.organization_id AND m.id=p_viewer AND m.status='active'
    LEFT JOIN knowledge.structured_record_catalog scope ON scope.organization_id=c.organization_id
      AND scope.record_kind=CASE WHEN c.record_kind='project' THEN 'client' ELSE c.record_kind END
      AND scope.record_id=CASE WHEN c.record_kind='project' THEN c.parent_record_id ELSE c.record_id END
    WHERE c.organization_id=app.current_organization_id() AND c.record_kind=p_kind AND c.record_id=p_id AND c.alive
      AND NOT EXISTS(SELECT 1 FROM platform.tombstones t WHERE t.organization_id=c.organization_id AND t.target_type=c.record_kind AND t.target_id=c.record_id)
      AND ((c.record_kind='project' AND c.parent_record_id IS NULL) OR (scope.alive
        AND scope.classification IN ('public','internal','confidential','restricted')
        AND NOT EXISTS(SELECT 1 FROM platform.tombstones t WHERE t.organization_id=scope.organization_id AND t.target_type=scope.record_kind AND t.target_id=scope.record_id) AND (
        scope.classification IN ('public','internal') OR scope.owner_membership_id=p_viewer
        OR (scope.classification='confidential' AND m.role IN ('owner','admin'))
        OR (scope.record_kind='client' AND EXISTS(SELECT 1 FROM work.client_readers r
          WHERE r.organization_id=scope.organization_id AND r.client_id=scope.record_id AND r.membership_id=p_viewer))
        OR (scope.record_kind='work_unit' AND EXISTS(SELECT 1 FROM knowledge.structured_work_assignments a
          WHERE a.organization_id=scope.organization_id AND a.work_unit_id=scope.record_id AND a.membership_id=p_viewer))
      )))),false)
$$;
REVOKE ALL ON FUNCTION knowledge.structured_record_class(text,uuid),knowledge.structured_record_readable(text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.structured_record_class(text,uuid),knowledge.structured_record_readable(text,uuid,uuid) TO ensemus_app;
-- Fixed metadata-only lock. It grants no record body access and cannot write the catalog. Callers
-- separately check the named viewer with the invoker-rights decision before and after the lock set.
CREATE FUNCTION knowledge.lock_structured_record(p_kind text,p_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF current_user<>'ensemus_migrator' OR app.current_organization_id() IS NULL OR p_id IS NULL
    OR p_kind IS NULL OR p_kind NOT IN ('work_unit','project','client') THEN
    RAISE EXCEPTION 'STRUCTURED_LOCK_TARGET_INVALID' USING ERRCODE='42501';
  END IF;
  BEGIN
    PERFORM 1 FROM knowledge.structured_record_catalog c WHERE c.organization_id=app.current_organization_id()
      AND c.record_kind=p_kind AND c.record_id=p_id AND c.alive FOR SHARE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'STRUCTURED_INPUT_BUSY' USING ERRCODE='55P03';
  END;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION knowledge.lock_structured_record(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.lock_structured_record(text,uuid) TO ensemus_app;
--> statement-breakpoint
-- Reuse one metadata decision in body RLS and retained-input serving, without reading body tables
-- recursively from their own policies. Preserve existing service and owner-only mutation authority.
CREATE OR REPLACE FUNCTION knowledge.can_read_work(p_work_unit uuid,p_membership uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT knowledge.structured_record_readable('work_unit',p_work_unit,p_membership)
$$;
ALTER POLICY client_visibility ON work.clients USING(knowledge.is_service_actor() OR knowledge.structured_record_readable('client',id,app.current_membership_id()));
ALTER POLICY client_owner_change ON work.clients USING(knowledge.is_service_actor() OR knowledge.structured_record_readable('client',id,app.current_membership_id()));
--> statement-breakpoint
CREATE FUNCTION knowledge.artifact_required_records(p_artifact uuid)
RETURNS TABLE(record_kind text,record_id uuid,record_sha256 text,classification text) LANGUAGE sql STABLE AS $$
  WITH nodes AS (SELECT p_artifact AS id UNION SELECT i.input_artifact_id FROM knowledge.artifact_lineage_inputs i
    WHERE i.organization_id=app.current_organization_id() AND i.artifact_id=p_artifact)
  SELECT DISTINCT r.record_kind,r.record_id,r.record_sha256,r.classification
    FROM knowledge.artifact_lineage_records r JOIN nodes n ON n.id=r.artifact_id
    WHERE r.organization_id=app.current_organization_id()
$$;
REVOKE ALL ON FUNCTION knowledge.artifact_required_records(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.artifact_required_records(uuid) TO ensemus_app;
--> statement-breakpoint
CREATE FUNCTION knowledge.structured_artifact_readable(p_artifact uuid,p_viewer uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  WITH nodes AS (SELECT p_artifact AS id UNION SELECT i.input_artifact_id FROM knowledge.artifact_lineage_inputs i
    WHERE i.organization_id=app.current_organization_id() AND i.artifact_id=p_artifact),
  records AS (SELECT * FROM knowledge.artifact_required_records(p_artifact))
  SELECT NOT EXISTS(SELECT 1 FROM nodes n JOIN knowledge.artifact_lineage l
    ON l.organization_id=app.current_organization_id() AND l.artifact_id=n.id
    WHERE l.execution_kind IN ('agent_run','system') AND (NOT l.structured_inventory_complete
      OR NOT EXISTS(SELECT 1 FROM knowledge.artifact_lineage_records r WHERE r.organization_id=l.organization_id
        AND r.artifact_id=l.artifact_id AND r.record_kind='work_unit' AND r.record_id=l.work_unit_id)))
    AND NOT EXISTS(SELECT 1 FROM records r WHERE
      knowledge.structured_record_class(r.record_kind,r.record_id) IS NULL
      OR knowledge.class_rank(knowledge.structured_record_class(r.record_kind,r.record_id))>
        (SELECT knowledge.class_rank(a.classification) FROM knowledge.artifact_acl_catalog a WHERE a.organization_id=app.current_organization_id() AND a.artifact_id=p_artifact)
      OR knowledge.class_rank(r.classification)>
        (SELECT knowledge.class_rank(a.classification) FROM knowledge.artifact_acl_catalog a WHERE a.organization_id=app.current_organization_id() AND a.artifact_id=p_artifact)
      OR CASE WHEN p_viewer IS NOT NULL THEN NOT knowledge.structured_record_readable(r.record_kind,r.record_id,p_viewer)
        ELSE NOT (knowledge.is_service_actor() AND r.record_kind='work_unit' AND EXISTS(
          SELECT 1 FROM knowledge.artifact_lineage l WHERE l.organization_id=app.current_organization_id()
            AND l.artifact_id=p_artifact AND l.execution_kind='system' AND l.structured_inventory_complete AND l.work_unit_id=r.record_id)
          AND NOT EXISTS(SELECT 1 FROM knowledge.artifact_lineage_inputs i WHERE i.organization_id=app.current_organization_id() AND i.artifact_id=p_artifact)) END)
$$;
REVOKE ALL ON FUNCTION knowledge.structured_artifact_readable(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.structured_artifact_readable(uuid,uuid) TO ensemus_app;
--> statement-breakpoint
CREATE FUNCTION knowledge.structured_inventory_valid(p_artifact uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(EXISTS(SELECT 1 FROM knowledge.artifact_lineage l WHERE l.organization_id=app.current_organization_id()
    AND l.artifact_id=p_artifact AND l.structured_inventory_complete AND l.inventory_complete
    AND l.execution_kind IN ('agent_run','system')
    AND (SELECT count(*) FROM knowledge.artifact_lineage_records r WHERE r.organization_id=l.organization_id AND r.artifact_id=l.artifact_id) BETWEEN 1 AND 1000
    AND EXISTS(SELECT 1 FROM knowledge.artifact_lineage_records r WHERE r.organization_id=l.organization_id AND r.artifact_id=l.artifact_id AND r.record_kind='work_unit' AND r.record_id=l.work_unit_id)
    AND NOT EXISTS(SELECT 1 FROM knowledge.artifact_required_records(l.artifact_id) r WHERE
      knowledge.structured_record_class(r.record_kind,r.record_id) IS NULL
      OR knowledge.class_rank(r.classification)>knowledge.class_rank(l.classification)
      OR knowledge.class_rank(knowledge.structured_record_class(r.record_kind,r.record_id))>knowledge.class_rank(l.classification)
      OR CASE WHEN l.execution_kind='agent_run' THEN NOT knowledge.structured_record_readable(r.record_kind,r.record_id,l.viewer_membership_id)
        ELSE r.record_kind<>'work_unit' OR r.record_id<>l.work_unit_id END)
    AND NOT EXISTS(SELECT 1 FROM knowledge.artifact_lineage_inputs i JOIN knowledge.artifact_lineage_records inherited
      ON inherited.organization_id=i.organization_id AND inherited.artifact_id=i.input_artifact_id
      WHERE i.organization_id=l.organization_id AND i.artifact_id=l.artifact_id AND NOT EXISTS(
        SELECT 1 FROM knowledge.artifact_lineage_records flat WHERE flat.organization_id=l.organization_id AND flat.artifact_id=l.artifact_id
          AND flat.record_kind=inherited.record_kind AND flat.record_id=inherited.record_id AND flat.record_sha256=inherited.record_sha256
          AND knowledge.class_rank(flat.classification)>=knowledge.class_rank(inherited.classification)))),false)
$$;
REVOKE ALL ON FUNCTION knowledge.structured_inventory_valid(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.structured_inventory_valid(uuid) TO ensemus_app;
--> statement-breakpoint
CREATE FUNCTION knowledge.guard_structured_artifact_input() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE l knowledge.artifact_lineage%ROWTYPE; current_class text; parent_id uuid;
BEGIN
  IF TG_RELID<>'knowledge.artifact_lineage_records'::regclass OR TG_OP<>'INSERT'
    OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN
    RAISE EXCEPTION 'STRUCTURED_BINDING_TARGET_INVALID' USING ERRCODE='42501';
  END IF;
  IF NOT knowledge.lock_structured_record(NEW.record_kind,NEW.record_id) THEN
    RAISE EXCEPTION 'STRUCTURED_INPUT_UNAVAILABLE' USING ERRCODE='EN118'; END IF;
  IF NEW.record_kind='project' THEN
    SELECT c.parent_record_id INTO parent_id FROM knowledge.structured_record_catalog c WHERE c.organization_id=NEW.organization_id AND c.record_kind='project' AND c.record_id=NEW.record_id;
    IF parent_id IS NOT NULL AND NOT knowledge.lock_structured_record('client',parent_id) THEN
      RAISE EXCEPTION 'STRUCTURED_INPUT_UNAVAILABLE' USING ERRCODE='EN118'; END IF;
  END IF;
  -- Serialize append/count with publication and other appenders; never wait after metadata locks.
  BEGIN
    SELECT * INTO l FROM knowledge.artifact_lineage h WHERE h.organization_id=NEW.organization_id AND h.artifact_id=NEW.artifact_id FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'STRUCTURED_INPUT_BUSY' USING ERRCODE='55P03'; END;
  current_class:=knowledge.structured_record_class(NEW.record_kind,NEW.record_id);
  IF NOT FOUND OR l.state<>'pending' OR NOT l.structured_inventory_complete OR NOT l.inventory_complete
    OR l.write_state<>'active' OR l.execution_kind NOT IN ('agent_run','system') OR current_class IS NULL
    OR app.current_actor_type() IS NULL OR app.current_actor_type() NOT IN ('service','agent','delegated')
    OR (NOT knowledge.is_service_actor() AND l.viewer_membership_id IS DISTINCT FROM app.current_membership_id())
    OR knowledge.class_rank(NEW.classification)<knowledge.class_rank(current_class)
    OR knowledge.class_rank(NEW.classification)>knowledge.class_rank(l.classification)
    OR (l.execution_kind='agent_run' AND NOT knowledge.structured_record_readable(NEW.record_kind,NEW.record_id,l.viewer_membership_id))
    OR (l.execution_kind='system' AND (NOT knowledge.is_service_actor() OR NEW.record_kind<>'work_unit' OR NEW.record_id<>l.work_unit_id)) THEN
    RAISE EXCEPTION 'STRUCTURED_INPUT_INVENTORY_REQUIRED' USING ERRCODE='EN118';
  END IF;
  IF (SELECT count(*) FROM knowledge.artifact_lineage_records r WHERE r.organization_id=NEW.organization_id AND r.artifact_id=NEW.artifact_id)>=1000 THEN
    RAISE EXCEPTION 'STRUCTURED_INPUT_LIMIT' USING ERRCODE='EN118'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION knowledge.guard_structured_artifact_input() FROM PUBLIC;
CREATE TRIGGER structured_artifact_input_guard BEFORE INSERT ON knowledge.artifact_lineage_records
  FOR EACH ROW EXECUTE FUNCTION knowledge.guard_structured_artifact_input();
CREATE TRIGGER structured_artifact_inputs_keep BEFORE UPDATE OR DELETE OR TRUNCATE ON knowledge.artifact_lineage_records
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
CREATE FUNCTION knowledge.guard_structured_artifact_header() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_RELID<>'knowledge.artifact_lineage'::regclass OR TG_OP NOT IN ('INSERT','UPDATE') THEN
    RAISE EXCEPTION 'STRUCTURED_HEADER_TARGET_INVALID' USING ERRCODE='42501'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.execution_kind IN ('agent_run','system') AND (NOT NEW.structured_inventory_complete
      OR app.current_actor_type() IS NULL OR app.current_actor_type() NOT IN ('service','agent','delegated')) THEN
      RAISE EXCEPTION 'STRUCTURED_INPUT_INVENTORY_REQUIRED' USING ERRCODE='EN118'; END IF;
  ELSE
    IF NEW.structured_inventory_complete IS DISTINCT FROM OLD.structured_inventory_complete THEN
      RAISE EXCEPTION 'STRUCTURED_INPUT_INVENTORY_IMMUTABLE' USING ERRCODE='42501'; END IF;
    IF NEW.state='bound' AND OLD.state='pending' AND NEW.execution_kind IN ('agent_run','system')
      AND NOT knowledge.structured_inventory_valid(NEW.artifact_id) THEN
      RAISE EXCEPTION 'STRUCTURED_INPUT_INVENTORY_REQUIRED' USING ERRCODE='EN118'; END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION knowledge.guard_structured_artifact_header() FROM PUBLIC;
CREATE TRIGGER artifact_lineage_03_structured BEFORE INSERT OR UPDATE ON knowledge.artifact_lineage
  FOR EACH ROW EXECUTE FUNCTION knowledge.guard_structured_artifact_header();
CREATE FUNCTION knowledge.check_structured_artifact_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE l knowledge.artifact_lineage%ROWTYPE;
BEGIN
  SELECT * INTO l FROM knowledge.artifact_lineage h WHERE h.organization_id=NEW.organization_id AND h.artifact_id=NEW.artifact_id;
  IF FOUND AND l.execution_kind IN ('agent_run','system') AND l.state IN ('pending','bound')
    AND NOT knowledge.structured_inventory_valid(l.artifact_id) THEN
    RAISE EXCEPTION 'STRUCTURED_INPUT_INVENTORY_REQUIRED' USING ERRCODE='EN118'; END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION knowledge.check_structured_artifact_commit() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER structured_artifact_commit AFTER INSERT OR UPDATE ON knowledge.artifact_lineage
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION knowledge.check_structured_artifact_commit();
--> statement-breakpoint
-- Same 0208 decision, with the structured predicate added at the final conjunction. Its service
-- exception is not broadened: a generated agent file still requires a real named viewer.
CREATE OR REPLACE FUNCTION knowledge.artifact_readable(p_artifact uuid,p_viewer uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  WITH nodes AS (
    SELECT p_artifact AS id,NULL::text AS expected_sha UNION ALL
    SELECT i.input_artifact_id,i.input_sha256 FROM knowledge.artifact_lineage_inputs i
      WHERE i.organization_id=app.current_organization_id() AND i.artifact_id=p_artifact
  ), sources AS (SELECT knowledge.artifact_required_sources(p_artifact) AS id)
  SELECT EXISTS(SELECT 1 FROM knowledge.artifact_acl_catalog a WHERE a.organization_id=app.current_organization_id()
      AND a.artifact_id=p_artifact AND a.alive)
    AND (EXISTS(SELECT 1 FROM org.memberships m WHERE m.organization_id=app.current_organization_id()
      AND m.id=p_viewer AND m.status='active') OR
      (knowledge.is_service_actor() AND p_viewer IS NULL AND NOT EXISTS(SELECT 1 FROM sources)
       AND NOT EXISTS(SELECT 1 FROM nodes n JOIN knowledge.artifact_lineage l
         ON l.organization_id=app.current_organization_id() AND l.artifact_id=n.id
         WHERE l.execution_kind NOT IN ('system','manual'))))
    AND NOT EXISTS(SELECT 1 FROM nodes n LEFT JOIN knowledge.artifact_acl_catalog a
      ON a.organization_id=app.current_organization_id() AND a.artifact_id=n.id
      LEFT JOIN knowledge.artifact_lineage l ON l.organization_id=a.organization_id AND l.artifact_id=a.artifact_id
      WHERE a.artifact_id IS NULL OR NOT a.alive OR (n.expected_sha IS NOT NULL AND n.expected_sha<>a.sha256)
        OR knowledge.class_rank(a.classification)>(SELECT knowledge.class_rank(root.classification)
          FROM knowledge.artifact_acl_catalog root WHERE root.organization_id=app.current_organization_id() AND root.artifact_id=p_artifact)
        OR EXISTS(SELECT 1 FROM knowledge.artifact_required_sources(n.id) required JOIN knowledge.sources source
          ON source.organization_id=app.current_organization_id() AND source.id=required
          WHERE knowledge.class_rank(source.classification)>knowledge.class_rank(a.classification))
        OR a.provenance_state IN ('pending','blocked')
        OR (a.classification IN ('confidential','restricted') AND NOT EXISTS(
          SELECT 1 FROM org.memberships viewer WHERE viewer.organization_id=app.current_organization_id()
            AND viewer.id=p_viewer AND viewer.status='active' AND (
              (a.classification='confidential' AND viewer.role IN ('owner','admin')) OR EXISTS(
                SELECT 1 FROM knowledge.artifact_work_links class_link JOIN work.work_units class_work
                  ON class_work.organization_id=class_link.organization_id AND class_work.id=class_link.work_unit_id
                WHERE class_link.organization_id=a.organization_id AND class_link.artifact_id=a.artifact_id
                  AND (class_work.owner_membership_id=viewer.id OR EXISTS(SELECT 1 FROM work.work_assignments assignment
                    WHERE assignment.organization_id=class_work.organization_id AND assignment.work_unit_id=class_work.id AND assignment.membership_id=viewer.id))))))
        OR (l.artifact_id IS NOT NULL AND (NOT l.inventory_complete OR l.state<>'bound' OR l.write_state<>'settled' OR l.physical_purged_at IS NOT NULL))
        OR (a.provenance_state='bound' AND (l.artifact_id IS NULL OR l.state<>'bound' OR NOT l.inventory_complete OR l.write_state<>'settled'
          OR l.artifact_sha256<>a.sha256 OR l.physical_purged_at IS NOT NULL))
        OR EXISTS(SELECT 1 FROM platform.tombstones t WHERE t.organization_id=app.current_organization_id()
          AND t.target_type='artifact' AND t.target_id=n.id)
        OR NOT EXISTS(SELECT 1 FROM knowledge.artifact_work_links wa
          WHERE wa.organization_id=app.current_organization_id() AND wa.artifact_id=n.id
            AND (knowledge.can_read_work(wa.work_unit_id,p_viewer) OR
              (p_viewer IS NULL AND knowledge.is_service_actor() AND NOT EXISTS(SELECT 1 FROM sources)))))
    AND NOT EXISTS(SELECT 1 FROM sources x LEFT JOIN knowledge.sources s
      ON s.organization_id=app.current_organization_id() AND s.id=x.id
      WHERE s.id IS NULL OR s.state<>'active' OR s.id NOT IN(SELECT knowledge.readable_source_ids(p_viewer))
        OR EXISTS(SELECT 1 FROM platform.tombstones t WHERE t.organization_id=app.current_organization_id()
          AND t.target_type='knowledge_source' AND t.target_id=x.id)
        OR knowledge.class_rank(s.classification)>(SELECT knowledge.class_rank(a.classification)
          FROM knowledge.artifact_acl_catalog a WHERE a.organization_id=app.current_organization_id() AND a.artifact_id=p_artifact))
    AND knowledge.structured_artifact_readable(p_artifact,p_viewer)
$$;
--> statement-breakpoint
CREATE FUNCTION knowledge.derived_structured_artifacts_remaining(p_kind text,p_id uuid) RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT count(*)::integer FROM knowledge.artifact_lineage l LEFT JOIN knowledge.artifact_acl_catalog a
    ON a.organization_id=l.organization_id AND a.artifact_id=l.artifact_id
    WHERE l.organization_id=app.current_organization_id() AND (
      (l.execution_kind IN ('agent_run','system') AND NOT l.structured_inventory_complete)
      OR EXISTS(SELECT 1 FROM knowledge.artifact_required_records(l.artifact_id) r WHERE r.record_kind=p_kind AND r.record_id=p_id))
      AND (l.physical_purged_at IS NULL OR l.write_state IN ('active','unknown') OR coalesce(a.alive,true)
        OR NOT EXISTS(SELECT 1 FROM platform.tombstones t WHERE t.organization_id=l.organization_id AND t.target_type='artifact' AND t.target_id=l.artifact_id))
$$;
REVOKE ALL ON FUNCTION knowledge.derived_structured_artifacts_remaining(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.derived_structured_artifacts_remaining(text,uuid) TO ensemus_app;
--> statement-breakpoint
-- The new retained edges use 0208's positive receipt. The catalog FK cannot disappear until every
-- dependent edge has passed it; a still-live body is an ordinary FK-order dependency for M8's eraser.
CREATE OR REPLACE FUNCTION knowledge.guard_retained_artifact_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid;
BEGIN
  IF TG_OP<>'DELETE' OR TG_RELID NOT IN ('knowledge.artifact_acl_catalog'::regclass,'knowledge.artifact_work_links'::regclass,
    'knowledge.artifact_lineage'::regclass,'knowledge.artifact_lineage_sources'::regclass,'knowledge.artifact_lineage_inputs'::regclass,
    'knowledge.artifact_lineage_packages'::regclass,'knowledge.artifact_lineage_records'::regclass,'platform.blob_lifecycle'::regclass,'platform.tombstones'::regclass) THEN
    RAISE EXCEPTION 'INVALID_ARTIFACT_ERASURE_TARGET' USING ERRCODE='42501'; END IF;
  IF current_user<>'ensemus_eraser' THEN
    IF TG_RELID IN ('platform.blob_lifecycle'::regclass,'platform.tombstones'::regclass) THEN RETURN OLD; END IF;
    IF TG_RELID='knowledge.artifact_work_links'::regclass AND current_user='ensemus_migrator' AND pg_trigger_depth()>=2 THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'RETAIN_ARTIFACT_ERASURE_PROOF' USING ERRCODE='42501'; END IF;
  IF OLD.organization_id IS DISTINCT FROM app.current_organization_id() THEN
    RAISE EXCEPTION 'INVALID_ARTIFACT_ERASURE_TENANT' USING ERRCODE='42501'; END IF;
  IF TG_RELID='platform.tombstones'::regclass THEN
    IF OLD.target_type<>'artifact' THEN RETURN OLD; END IF; target:=OLD.target_id;
  ELSE target:=OLD.artifact_id; END IF;
  IF NOT knowledge.certify_artifact_erasure(target,TG_RELID<>'knowledge.artifact_acl_catalog'::regclass) THEN
    RAISE EXCEPTION 'ARTIFACT_ERASURE_UNCONFIRMED' USING ERRCODE='EN118'; END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER artifact_records_physical_proof BEFORE DELETE ON knowledge.artifact_lineage_records
  FOR EACH ROW EXECUTE FUNCTION knowledge.guard_retained_artifact_erasure();
CREATE FUNCTION knowledge.guard_structured_catalog_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_RELID<>'knowledge.structured_record_catalog'::regclass OR TG_OP<>'DELETE'
    OR current_user<>'ensemus_eraser' OR OLD.organization_id IS DISTINCT FROM app.current_organization_id() THEN
    RAISE EXCEPTION 'RETAIN_STRUCTURED_CATALOG' USING ERRCODE='42501'; END IF;
  IF OLD.alive THEN RAISE EXCEPTION 'STRUCTURED_RECORD_STILL_LIVE' USING ERRCODE='23503'; END IF;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION knowledge.guard_structured_catalog_erasure() FROM PUBLIC;
CREATE TRIGGER structured_catalog_keep BEFORE DELETE ON knowledge.structured_record_catalog
  FOR EACH ROW EXECUTE FUNCTION knowledge.guard_structured_catalog_erasure();
