-- Source draft: additive custom-object authority and retained metadata. Runtime qualification owed.
CREATE TABLE objects.migration_results (
 organization_id uuid NOT NULL, migration_id uuid NOT NULL, record_id uuid NOT NULL,
 outcome text NOT NULL, error_code text, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,migration_id,record_id),
 FOREIGN KEY(organization_id,migration_id) REFERENCES objects.migrations(organization_id,id),
 FOREIGN KEY(organization_id,record_id) REFERENCES objects.records(organization_id,id),
 CONSTRAINT object_migration_results_shape CHECK(outcome IN ('migrated','failed') AND (error_code IS NULL OR error_code='OBJECT_RECORD_INVALID'))
);
CREATE TABLE objects.type_acl_catalog (
 organization_id uuid NOT NULL REFERENCES org.organizations(id), type_id uuid NOT NULL,
 classification text NOT NULL CHECK(classification IN ('public','internal','confidential','restricted')),
 PRIMARY KEY(organization_id,type_id)
);
ALTER TABLE objects.migration_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE objects.migration_results FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON objects.migration_results FOR SELECT TO ensemus_app USING(organization_id=app.current_organization_id());
CREATE POLICY worker_insert ON objects.migration_results FOR INSERT TO ensemus_app WITH CHECK(organization_id=app.current_organization_id() AND app.current_actor_type()='service');
GRANT SELECT,INSERT ON objects.migration_results TO ensemus_app;
ALTER TABLE objects.type_acl_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE objects.type_acl_catalog FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON objects.type_acl_catalog FOR SELECT TO ensemus_app USING(organization_id=app.current_organization_id());
CREATE POLICY catalog_read ON objects.type_acl_catalog FOR SELECT TO ensemus_migrator USING(organization_id=app.current_organization_id());
CREATE POLICY catalog_lock ON objects.type_acl_catalog FOR UPDATE TO ensemus_migrator USING(organization_id=app.current_organization_id()) WITH CHECK(false);
CREATE POLICY catalog_write ON objects.type_acl_catalog TO ensemus_migrator USING(organization_id=app.current_organization_id() AND pg_trigger_depth()>0) WITH CHECK(organization_id=app.current_organization_id() AND pg_trigger_depth()>0);
GRANT SELECT ON objects.type_acl_catalog TO ensemus_app;
--> statement-breakpoint
ALTER TABLE knowledge.structured_record_catalog DROP CONSTRAINT structured_record_catalog_shape;
ALTER TABLE knowledge.structured_record_catalog ADD CONSTRAINT structured_record_catalog_shape CHECK(record_kind IN ('work_unit','project','client','object_record') AND ((record_kind='project' AND classification IS NULL AND owner_membership_id IS NULL) OR (record_kind<>'project' AND classification IS NOT NULL AND classification IN ('public','internal','confidential','restricted'))) AND (record_kind<>'object_record' OR owner_membership_id IS NOT NULL));
ALTER TABLE knowledge.artifact_lineage_records DROP CONSTRAINT artifact_lineage_records_shape;
ALTER TABLE knowledge.artifact_lineage_records ADD CONSTRAINT artifact_lineage_records_shape CHECK(record_kind IN ('work_unit','project','client','object_record') AND record_sha256 ~ '^[0-9a-f]{64}$' AND classification IN ('public','internal','confidential','restricted'));
-- This migration backfills ACL identities only, never actual read/provenance history.
CREATE POLICY object_0407_backfill ON objects.types FOR SELECT TO ensemus_migrator USING(true);
CREATE POLICY object_0407_backfill ON objects.records FOR SELECT TO ensemus_migrator USING(true);
CREATE POLICY object_0407_backfill ON objects.type_acl_catalog FOR INSERT TO ensemus_migrator WITH CHECK(true);
CREATE POLICY object_0407_backfill ON knowledge.structured_record_catalog FOR INSERT TO ensemus_migrator WITH CHECK(true);
INSERT INTO objects.type_acl_catalog SELECT organization_id,id,classification FROM objects.types;
INSERT INTO knowledge.structured_record_catalog(organization_id,record_kind,record_id,classification,owner_membership_id,parent_record_id,alive)
 SELECT organization_id,'object_record',id,classification,owner_membership_id,type_id,deleted_at IS NULL FROM objects.records;
DROP POLICY object_0407_backfill ON objects.types;
DROP POLICY object_0407_backfill ON objects.records;
DROP POLICY object_0407_backfill ON objects.type_acl_catalog;
DROP POLICY object_0407_backfill ON knowledge.structured_record_catalog;
--> statement-breakpoint
CREATE FUNCTION objects.record_class(p_record uuid) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN knowledge.class_rank(c.classification)>=knowledge.class_rank(t.classification) THEN c.classification ELSE t.classification END
 FROM knowledge.structured_record_catalog c JOIN objects.type_acl_catalog t ON t.organization_id=c.organization_id AND t.type_id=c.parent_record_id
 WHERE c.organization_id=app.current_organization_id() AND c.record_kind='object_record' AND c.record_id=p_record AND c.alive
 AND NOT EXISTS(SELECT 1 FROM platform.tombstones x WHERE x.organization_id=c.organization_id AND x.target_type='object_record' AND x.target_id=c.record_id)
$$;
CREATE FUNCTION objects.record_readable(p_record uuid,p_viewer uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT coalesce(EXISTS(SELECT 1 FROM knowledge.structured_record_catalog c JOIN org.memberships m ON m.organization_id=c.organization_id AND m.id=p_viewer AND m.status='active'
 WHERE c.organization_id=app.current_organization_id() AND c.record_kind='object_record' AND c.record_id=p_record AND c.alive
 AND (objects.record_class(p_record) IN ('public','internal') OR (objects.record_class(p_record)='confidential' AND (c.owner_membership_id=m.id OR m.role IN ('owner','admin'))) OR (objects.record_class(p_record)='restricted' AND c.owner_membership_id=m.id))),false)
$$;
REVOKE ALL ON FUNCTION objects.record_class(uuid),objects.record_readable(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION objects.record_class(uuid),objects.record_readable(uuid,uuid) TO ensemus_app;
-- Preserve public function OIDs: existing RLS/view expressions bind those OIDs. Renaming the old
-- functions would leave such expressions on the old policy. Clone only these three fixed existing
-- definitions, then replace the original public bodies. Unknown/missing definitions refuse apply.
DO $$
 DECLARE signature text; original_name text; definition text; copied text;
 BEGIN
 FOREACH signature IN ARRAY ARRAY['knowledge.structured_record_class(text,uuid)','knowledge.structured_record_readable(text,uuid,uuid)','knowledge.lock_structured_record(text,uuid)'] LOOP
 original_name:=split_part(signature,'(',1);
 definition:=pg_get_functiondef(signature::regprocedure);
 copied:=replace(definition,'FUNCTION '||original_name||'(','FUNCTION '||original_name||'_before_objects(');
 IF copied=definition THEN RAISE EXCEPTION 'OBJECT_POLICY_DEPENDENCY_INVALID' USING ERRCODE='EN407'; END IF;
 EXECUTE copied;
 END LOOP;
 END $$;
REVOKE ALL ON FUNCTION knowledge.structured_record_class_before_objects(text,uuid),knowledge.structured_record_readable_before_objects(text,uuid,uuid),knowledge.lock_structured_record_before_objects(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.structured_record_class_before_objects(text,uuid),knowledge.structured_record_readable_before_objects(text,uuid,uuid) TO ensemus_app;
-- Work scope helpers are supplied by0411. PL/pgSQL defers that dependency; runtime without0411
-- refuses instead of silently using the older Work-only decision. No backfill calls this branch.
CREATE OR REPLACE FUNCTION knowledge.structured_record_class(p_kind text,p_id uuid) RETURNS text LANGUAGE plpgsql STABLE AS $$
 BEGIN
 IF p_kind='object_record' THEN RETURN objects.record_class(p_id); END IF;
 IF p_kind='work_unit' THEN RETURN knowledge.work_scope_class(p_id); END IF;
 RETURN knowledge.structured_record_class_before_objects(p_kind,p_id);
 END $$;
CREATE OR REPLACE FUNCTION knowledge.structured_record_readable(p_kind text,p_id uuid,p_viewer uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
 BEGIN
 IF p_kind='object_record' THEN RETURN objects.record_readable(p_id,p_viewer); END IF;
 IF p_kind='work_unit' THEN RETURN knowledge.work_scope_readable(p_id,p_viewer); END IF;
 RETURN knowledge.structured_record_readable_before_objects(p_kind,p_id,p_viewer);
 END $$;
CREATE FUNCTION objects.lock_record_authority(p_id uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE locked_object_type uuid;
 BEGIN
 IF current_user<>'ensemus_migrator' OR app.current_organization_id() IS NULL OR p_id IS NULL THEN RAISE EXCEPTION 'STRUCTURED_LOCK_TARGET_INVALID' USING ERRCODE='42501'; END IF;
 SELECT c.parent_record_id INTO locked_object_type FROM knowledge.structured_record_catalog c WHERE c.organization_id=app.current_organization_id() AND c.record_kind='object_record' AND c.record_id=p_id AND c.alive;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM 1 FROM objects.type_acl_catalog t WHERE t.organization_id=app.current_organization_id() AND t.type_id=locked_object_type FOR SHARE NOWAIT;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM 1 FROM knowledge.structured_record_catalog c WHERE c.organization_id=app.current_organization_id() AND c.record_kind='object_record' AND c.record_id=p_id AND c.parent_record_id=locked_object_type AND c.alive FOR SHARE NOWAIT;
 RETURN FOUND;
 END $$;
REVOKE ALL ON FUNCTION objects.lock_record_authority(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION objects.lock_record_authority(uuid) TO ensemus_app;
CREATE OR REPLACE FUNCTION knowledge.lock_structured_record(p_kind text,p_id uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 BEGIN
 IF p_kind='object_record' THEN RETURN objects.lock_record_authority(p_id); END IF;
 RETURN knowledge.lock_structured_record_before_objects(p_kind,p_id);
 END $$;
REVOKE ALL ON FUNCTION knowledge.structured_record_class(text,uuid),knowledge.structured_record_readable(text,uuid,uuid),knowledge.lock_structured_record(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.structured_record_class(text,uuid),knowledge.structured_record_readable(text,uuid,uuid),knowledge.lock_structured_record(text,uuid) TO ensemus_app;
--> statement-breakpoint
CREATE FUNCTION objects.active_person(p_manage boolean DEFAULT false) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT app.current_actor_type()='user' AND EXISTS(SELECT 1 FROM org.memberships m WHERE m.organization_id=app.current_organization_id() AND m.id=app.current_membership_id() AND m.user_id=app.current_user_id() AND m.status='active' AND (CASE WHEN p_manage THEN m.role IN ('owner','admin') ELSE m.role IN ('owner','admin','member') END))
$$;
REVOKE ALL ON FUNCTION objects.active_person(boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION objects.active_person(boolean) TO ensemus_app;
CREATE FUNCTION objects.pending_migration(p_type uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT app.current_actor_type()='service' AND EXISTS(SELECT 1 FROM objects.migrations m WHERE m.organization_id=app.current_organization_id() AND m.type_id=p_type AND m.status IN ('queued','running'))
$$;
REVOKE ALL ON FUNCTION objects.pending_migration(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION objects.pending_migration(uuid) TO ensemus_app;
-- INSERT RETURNING must judge the actual row: a STABLE function cannot require the record catalog
-- entry inserted by that same statement's BEFORE trigger. The parent floor already exists. Keep
-- the canonical record_readable(id,viewer) above for retained-input/export authority, not this helper.
CREATE FUNCTION objects.record_row_readable(p_id uuid,p_type uuid,p_class text,p_owner uuid,p_deleted timestamptz,p_viewer uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT p_deleted IS NULL AND p_class IN ('public','internal','confidential','restricted')
 AND NOT EXISTS(SELECT 1 FROM platform.tombstones t WHERE t.organization_id=app.current_organization_id() AND t.target_type='object_record' AND t.target_id=p_id)
 AND NOT EXISTS(SELECT 1 FROM knowledge.structured_record_catalog c WHERE c.organization_id=app.current_organization_id() AND c.record_kind='object_record' AND c.record_id=p_id AND NOT c.alive)
 AND EXISTS(SELECT 1 FROM org.memberships m JOIN objects.type_acl_catalog t ON t.organization_id=m.organization_id AND t.type_id=p_type
 CROSS JOIN LATERAL(SELECT CASE WHEN knowledge.class_rank(p_class)>=knowledge.class_rank(t.classification) THEN p_class ELSE t.classification END AS classification) scope
 WHERE m.organization_id=app.current_organization_id() AND m.id=p_viewer AND m.status='active'
 AND (scope.classification IN ('public','internal') OR (scope.classification='confidential' AND (m.id=p_owner OR m.role IN ('owner','admin'))) OR (scope.classification='restricted' AND m.id=p_owner)))
$$;
REVOKE ALL ON FUNCTION objects.record_row_readable(uuid,uuid,text,uuid,timestamptz,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION objects.record_row_readable(uuid,uuid,text,uuid,timestamptz,uuid) TO ensemus_app;
CREATE POLICY object_type_read ON objects.types AS RESTRICTIVE FOR SELECT TO ensemus_app USING(objects.active_person() OR app.current_actor_type()='service');
-- Broad visible-row USING permits evidence locks; the trigger owns exact mutation authority.
CREATE POLICY object_type_update ON objects.types AS RESTRICTIVE FOR UPDATE TO ensemus_app USING(objects.active_person() OR app.current_actor_type()='service') WITH CHECK(objects.active_person(true));
CREATE POLICY object_type_insert ON objects.types AS RESTRICTIVE FOR INSERT TO ensemus_app WITH CHECK(objects.active_person(true) AND created_by_membership_id=app.current_membership_id());
CREATE POLICY object_shape_read ON objects.type_versions AS RESTRICTIVE FOR SELECT TO ensemus_app USING(objects.active_person() OR app.current_actor_type()='service');
CREATE POLICY object_shape_insert ON objects.type_versions AS RESTRICTIVE FOR INSERT TO ensemus_app WITH CHECK(objects.active_person(true) AND created_by_membership_id=app.current_membership_id());
CREATE POLICY object_record_read ON objects.records AS RESTRICTIVE FOR SELECT TO ensemus_app USING((objects.active_person() AND objects.record_row_readable(id,type_id,classification,owner_membership_id,deleted_at,app.current_membership_id())) OR objects.pending_migration(type_id));
CREATE POLICY object_record_lock ON objects.records AS RESTRICTIVE FOR UPDATE TO ensemus_app USING((objects.active_person() AND objects.record_readable(id,app.current_membership_id())) OR objects.pending_migration(type_id)) WITH CHECK(true);
CREATE POLICY object_record_insert ON objects.records AS RESTRICTIVE FOR INSERT TO ensemus_app WITH CHECK(objects.active_person() AND owner_membership_id=app.current_membership_id() AND created_by_membership_id=app.current_membership_id());
CREATE POLICY object_values_read ON objects.record_values AS RESTRICTIVE FOR SELECT TO ensemus_app USING(objects.active_person() AND objects.record_readable(record_id,app.current_membership_id()));
REVOKE INSERT,UPDATE,DELETE ON objects.record_values FROM ensemus_app;
CREATE POLICY object_relations_read ON objects.relations AS RESTRICTIVE FOR SELECT TO ensemus_app USING(objects.active_person() AND objects.record_readable(from_record_id,app.current_membership_id()) AND objects.record_readable(to_record_id,app.current_membership_id()));
CREATE POLICY object_relations_insert ON objects.relations AS RESTRICTIVE FOR INSERT TO ensemus_app WITH CHECK(objects.active_person() AND created_by_membership_id=app.current_membership_id() AND objects.record_readable(from_record_id,app.current_membership_id()) AND objects.record_readable(to_record_id,app.current_membership_id()));
CREATE POLICY object_relations_delete ON objects.relations AS RESTRICTIVE FOR DELETE TO ensemus_app USING(objects.active_person() AND objects.record_readable(from_record_id,app.current_membership_id()) AND objects.record_readable(to_record_id,app.current_membership_id()));
CREATE POLICY object_migrations_read ON objects.migrations AS RESTRICTIVE FOR SELECT TO ensemus_app USING(objects.active_person(true) OR app.current_actor_type()='service');
CREATE POLICY object_migrations_insert ON objects.migrations AS RESTRICTIVE FOR INSERT TO ensemus_app WITH CHECK(objects.active_person(true) AND requested_by_membership_id=app.current_membership_id() AND status='queued' AND migrated_count=0 AND failed_count=0 AND error_code IS NULL AND finished_at IS NULL);
CREATE POLICY object_migrations_update ON objects.migrations AS RESTRICTIVE FOR UPDATE TO ensemus_app USING(objects.active_person(true) OR app.current_actor_type()='service') WITH CHECK(app.current_actor_type()='service');
--> statement-breakpoint
-- BEFORE mirrors make INSERT RETURNING obey the same ACL without a service read bypass.
CREATE FUNCTION objects.track_record_acl() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 BEGIN
 IF TG_TABLE_SCHEMA<>'objects' OR TG_RELID NOT IN ('objects.types'::regclass,'objects.records'::regclass) OR TG_OP NOT IN ('INSERT','UPDATE') OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN RAISE EXCEPTION 'OBJECT_CATALOG_TARGET_INVALID' USING ERRCODE='42501'; END IF;
 IF TG_RELID='objects.types'::regclass THEN
 IF TG_OP='INSERT' AND EXISTS(SELECT 1 FROM objects.type_acl_catalog WHERE organization_id=NEW.organization_id AND type_id=NEW.id) THEN RAISE EXCEPTION 'OBJECT_TYPE_ID_REUSE' USING ERRCODE='EN407'; END IF;
 INSERT INTO objects.type_acl_catalog VALUES(NEW.organization_id,NEW.id,NEW.classification) ON CONFLICT(organization_id,type_id) DO UPDATE SET classification=EXCLUDED.classification;
 ELSE
 IF TG_OP='UPDATE' AND OLD.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'OBJECT_DELETED' USING ERRCODE='EN407'; END IF;
 IF EXISTS(SELECT 1 FROM knowledge.structured_record_catalog WHERE organization_id=NEW.organization_id AND record_kind='object_record' AND record_id=NEW.id AND NOT alive) THEN RAISE EXCEPTION 'OBJECT_RECORD_ID_REUSE' USING ERRCODE='EN407'; END IF;
 INSERT INTO knowledge.structured_record_catalog(organization_id,record_kind,record_id,classification,owner_membership_id,parent_record_id,alive) VALUES(NEW.organization_id,'object_record',NEW.id,NEW.classification,NEW.owner_membership_id,NEW.type_id,NEW.deleted_at IS NULL)
 ON CONFLICT(organization_id,record_kind,record_id) DO UPDATE SET classification=EXCLUDED.classification,owner_membership_id=EXCLUDED.owner_membership_id,parent_record_id=EXCLUDED.parent_record_id,alive=EXCLUDED.alive;
 IF NEW.deleted_at IS NOT NULL THEN INSERT INTO platform.tombstones(organization_id,target_type,target_id,reason_code) VALUES(NEW.organization_id,'object_record',NEW.id,'OBJECT_DELETED') ON CONFLICT DO NOTHING; END IF;
 END IF; RETURN NEW;
 END $$;
REVOKE ALL ON FUNCTION objects.track_record_acl() FROM PUBLIC;
CREATE POLICY object_trigger_tombstone ON platform.tombstones FOR INSERT TO ensemus_migrator WITH CHECK(organization_id=app.current_organization_id() AND target_type='object_record' AND pg_trigger_depth()>0);
CREATE TRIGGER zz_object_type_catalog BEFORE INSERT OR UPDATE OF classification ON objects.types FOR EACH ROW EXECUTE FUNCTION objects.track_record_acl();
CREATE TRIGGER zz_object_record_catalog BEFORE INSERT OR UPDATE ON objects.records FOR EACH ROW EXECUTE FUNCTION objects.track_record_acl();
--> statement-breakpoint
CREATE FUNCTION objects.text_units(p_text text) RETURNS integer LANGUAGE sql IMMUTABLE AS $$
 SELECT char_length(p_text)+count(*) FILTER(WHERE ascii(substr(p_text,i,1))>65535)::integer FROM generate_series(1,char_length(p_text)) g(i)
$$;
REVOKE ALL ON FUNCTION objects.text_units(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION objects.text_units(text) TO ensemus_app;
CREATE FUNCTION objects.attributes_valid(p_fields jsonb,p_attributes jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
 DECLARE f jsonb; k text; v jsonb; txt text; parsed date; max_len integer;
 BEGIN
 IF jsonb_typeof(p_fields)<>'array' OR jsonb_typeof(p_attributes)<>'object' OR octet_length(p_attributes::text)>256000 THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_attributes) key WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_fields) x WHERE x->>'key'=key)) THEN RETURN false; END IF;
 FOR f IN SELECT * FROM jsonb_array_elements(p_fields) LOOP
 k:=f->>'key'; v:=p_attributes->k;
 IF v IS NULL OR v='null'::jsonb OR (jsonb_typeof(v)='string' AND btrim(v#>>'{}')='') THEN IF (f->>'required')::boolean THEN RETURN false; END IF; IF v IS NULL OR v='null'::jsonb THEN CONTINUE; END IF; END IF;
 IF f->>'kind'='number' THEN IF jsonb_typeof(v)<>'number' OR (v#>>'{}')::double precision IN ('Infinity'::double precision,'-Infinity'::double precision,'NaN'::double precision) THEN RETURN false; END IF;
 ELSIF f->>'kind'='boolean' THEN IF jsonb_typeof(v)<>'boolean' THEN RETURN false; END IF;
 ELSE
 IF jsonb_typeof(v)<>'string' THEN RETURN false; END IF; txt:=v#>>'{}';
 max_len:=CASE WHEN f->>'kind'='long_text' THEN 50000 ELSE 2000 END;
 IF f ? 'maxLength' THEN max_len:=least(max_len,(f->>'maxLength')::integer); END IF;
 IF objects.text_units(txt)>max_len OR ((f->>'indexed')::boolean AND octet_length(txt)>2000) THEN RETURN false; END IF;
 IF f->>'kind'='enum' AND NOT (f->'options' ? txt) THEN RETURN false; END IF;
 IF f->>'kind'='email' AND txt !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN RETURN false; END IF;
 IF f->>'kind'='url' AND (txt !~* '^https?://[^[:space:]/?#]+' OR txt ~ '[[:cntrl:][:space:]]') THEN RETURN false; END IF;
 IF f->>'kind'='date' THEN IF txt !~ '^\d{4}-\d{2}-\d{2}($|T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$)' THEN RETURN false; END IF; parsed:=left(txt,10)::date; IF to_char(parsed,'YYYY-MM-DD')<>left(txt,10) OR extract(year FROM parsed)<100 THEN RETURN false; END IF; IF length(txt)>10 THEN PERFORM txt::timestamptz; END IF; END IF;
 END IF;
 END LOOP; RETURN true;
 EXCEPTION WHEN OTHERS THEN RETURN false;
 END $$;
REVOKE ALL ON FUNCTION objects.attributes_valid(jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION objects.attributes_valid(jsonb,jsonb) TO ensemus_app;
--> statement-breakpoint
CREATE FUNCTION objects.guard_record_write() RETURNS trigger LANGUAGE plpgsql AS $$
 DECLARE t objects.types%ROWTYPE; fields jsonb; role_name text; worker boolean; floor_raise boolean;
 BEGIN
 IF NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN RAISE EXCEPTION 'OBJECT_AUTHORITY_DENIED' USING ERRCODE='42501'; END IF;
 SELECT * INTO t FROM objects.types WHERE organization_id=NEW.organization_id AND id=NEW.type_id FOR SHARE NOWAIT;
 IF NOT FOUND OR NEW.classification NOT IN ('public','internal','confidential','restricted') OR app.classification_rank(NEW.classification)<app.classification_rank(t.classification) THEN RAISE EXCEPTION 'OBJECT_CLASSIFICATION_FLOOR' USING ERRCODE='EN403'; END IF;
 floor_raise:=TG_OP='UPDATE' AND pg_trigger_depth()>1 AND NEW.classification=t.classification AND NEW.attributes=OLD.attributes AND NEW.type_version_number=OLD.type_version_number AND NEW.display_name=OLD.display_name AND NEW.owner_membership_id=OLD.owner_membership_id AND NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at;
 IF TG_OP='UPDATE' THEN
 IF (NEW.organization_id,NEW.id,NEW.type_id,NEW.owner_membership_id,NEW.created_by_membership_id,NEW.created_at) IS DISTINCT FROM (OLD.organization_id,OLD.id,OLD.type_id,OLD.owner_membership_id,OLD.created_by_membership_id,OLD.created_at) OR OLD.deleted_at IS NOT NULL OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'OBJECT_IDENTITY_IMMUTABLE' USING ERRCODE='42501'; END IF;
 END IF;
 worker:=TG_OP='UPDATE' AND app.current_actor_type()='service' AND NEW.attributes=OLD.attributes AND NEW.display_name=OLD.display_name AND NEW.classification=OLD.classification AND NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at AND EXISTS(SELECT 1 FROM objects.migrations m WHERE m.organization_id=NEW.organization_id AND m.type_id=NEW.type_id AND m.status='running' AND m.to_version_number=NEW.type_version_number AND OLD.type_version_number<NEW.type_version_number);
 IF NOT floor_raise AND NOT worker THEN
 IF NOT objects.active_person() THEN RAISE EXCEPTION 'OBJECT_AUTHORITY_DENIED' USING ERRCODE='42501'; END IF;
 SELECT role INTO role_name FROM org.memberships WHERE organization_id=NEW.organization_id AND id=app.current_membership_id() AND user_id=app.current_user_id() AND status='active' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'OBJECT_AUTHORITY_DENIED' USING ERRCODE='42501'; END IF;
 IF TG_OP='INSERT' THEN
 IF NEW.owner_membership_id<>app.current_membership_id() OR NEW.created_by_membership_id<>app.current_membership_id() OR NEW.type_version_number<>t.current_version_number OR NEW.version<>1 OR NEW.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'OBJECT_INSERT_INVALID' USING ERRCODE='42501'; END IF;
 ELSE
 IF NOT objects.record_readable(OLD.id,app.current_membership_id()) OR NOT (OLD.owner_membership_id=app.current_membership_id() OR role_name IN ('owner','admin')) OR NEW.type_version_number<>OLD.type_version_number THEN RAISE EXCEPTION 'OBJECT_AUTHORITY_DENIED' USING ERRCODE='42501'; END IF;
 IF app.classification_rank(NEW.classification)<app.classification_rank(OLD.classification) THEN
 IF role_name NOT IN ('owner','admin') THEN RAISE EXCEPTION 'OBJECT_CLASSIFICATION_ROLE_REQUIRED' USING ERRCODE='42501'; END IF;
 IF NOT app.interactive_privilege_allowed('object_type.lower_scope',app.current_interactive_session_id()) THEN RAISE EXCEPTION 'MFA_REQUIRED' USING ERRCODE='EN405'; END IF;
 END IF;
 END IF;
 IF t.state<>'active' AND NEW.deleted_at IS NULL THEN RAISE EXCEPTION 'OBJECT_TYPE_INACTIVE' USING ERRCODE='EN407'; END IF;
 END IF;
 SELECT v.fields INTO fields FROM objects.type_versions v WHERE v.organization_id=NEW.organization_id AND v.type_id=NEW.type_id AND v.version_number=NEW.type_version_number;
 IF NOT FOUND OR NOT objects.attributes_valid(fields,NEW.attributes) OR length(btrim(NEW.display_name))=0 OR objects.text_units(NEW.display_name)>200 THEN RAISE EXCEPTION 'OBJECT_RECORD_INVALID' USING ERRCODE='EN403'; END IF;
 RETURN NEW;
 END $$;
REVOKE ALL ON FUNCTION objects.guard_record_write() FROM PUBLIC;
CREATE TRIGGER aa_object_record_authority BEFORE INSERT OR UPDATE ON objects.records FOR EACH ROW EXECUTE FUNCTION objects.guard_record_write();
-- A normal UPDATE must keep the restrictive SELECT policy true for its new row. Deletion makes
-- that policy false by design. Use one fixed effect rather than exposing deleted bodies through
-- a caller-set GUC. Only the non-BYPASSRLS function owner can use these exact-target policies.
CREATE POLICY object_delete_read ON objects.records FOR SELECT TO ensemus_migrator USING(
 session_user='ensemus_app' AND app.current_actor_type()='user' AND organization_id=app.current_organization_id()
 AND id::text=current_setting('objects.soft_delete_record_id',true));
CREATE POLICY object_delete_write ON objects.records FOR UPDATE TO ensemus_migrator USING(
 session_user='ensemus_app' AND app.current_actor_type()='user' AND organization_id=app.current_organization_id()
 AND id::text=current_setting('objects.soft_delete_record_id',true)) WITH CHECK(
 session_user='ensemus_app' AND app.current_actor_type()='user' AND organization_id=app.current_organization_id()
 AND id::text=current_setting('objects.soft_delete_record_id',true) AND deleted_at IS NOT NULL);
CREATE POLICY object_delete_person ON org.memberships FOR SELECT TO ensemus_migrator USING(
 session_user='ensemus_app' AND app.current_actor_type()='user' AND organization_id=app.current_organization_id()
 AND id=app.current_membership_id() AND user_id=app.current_user_id()
 AND nullif(current_setting('objects.soft_delete_record_id',true),'') IS NOT NULL);
CREATE POLICY object_delete_person_lock ON org.memberships FOR UPDATE TO ensemus_migrator USING(
 session_user='ensemus_app' AND app.current_actor_type()='user' AND organization_id=app.current_organization_id()
 AND id=app.current_membership_id() AND user_id=app.current_user_id()
 AND nullif(current_setting('objects.soft_delete_record_id',true),'') IS NOT NULL) WITH CHECK(false);
CREATE POLICY object_delete_policy ON org.security_policies FOR SELECT TO ensemus_migrator USING(
 session_user='ensemus_app' AND app.current_actor_type()='user' AND organization_id=app.current_organization_id()
 AND nullif(current_setting('objects.soft_delete_record_id',true),'') IS NOT NULL);
CREATE POLICY object_delete_policy_lock ON org.security_policies FOR UPDATE TO ensemus_migrator USING(
 session_user='ensemus_app' AND app.current_actor_type()='user' AND organization_id=app.current_organization_id()
 AND nullif(current_setting('objects.soft_delete_record_id',true),'') IS NOT NULL) WITH CHECK(false);
CREATE POLICY object_delete_sso ON org.sso_connections FOR SELECT TO ensemus_migrator USING(
 session_user='ensemus_app' AND app.current_actor_type()='user' AND organization_id=app.current_organization_id()
 AND nullif(current_setting('objects.soft_delete_record_id',true),'') IS NOT NULL);
CREATE POLICY object_delete_type ON objects.types FOR SELECT TO ensemus_migrator USING(
 session_user='ensemus_app' AND app.current_actor_type()='user' AND organization_id=app.current_organization_id()
 AND EXISTS(SELECT 1 FROM knowledge.structured_record_catalog c WHERE c.organization_id=objects.types.organization_id
 AND c.record_kind='object_record' AND c.record_id::text=current_setting('objects.soft_delete_record_id',true)
 AND c.parent_record_id=objects.types.id AND c.alive));
CREATE POLICY object_delete_type_lock ON objects.types FOR UPDATE TO ensemus_migrator USING(
 session_user='ensemus_app' AND app.current_actor_type()='user' AND organization_id=app.current_organization_id()
 AND EXISTS(SELECT 1 FROM knowledge.structured_record_catalog c WHERE c.organization_id=objects.types.organization_id
 AND c.record_kind='object_record' AND c.record_id::text=current_setting('objects.soft_delete_record_id',true)
 AND c.parent_record_id=objects.types.id AND c.alive)) WITH CHECK(false);
-- The existing record trigger reads the exact retained version while the fixed effect runs.
CREATE POLICY object_delete_shape ON objects.type_versions FOR SELECT TO ensemus_migrator USING(
 session_user='ensemus_app' AND app.current_actor_type()='user' AND organization_id=app.current_organization_id()
 AND EXISTS(SELECT 1 FROM knowledge.structured_record_catalog c WHERE c.organization_id=objects.type_versions.organization_id
 AND c.record_kind='object_record' AND c.record_id::text=current_setting('objects.soft_delete_record_id',true)
 AND c.parent_record_id=objects.type_versions.type_id AND c.alive));
CREATE FUNCTION objects.soft_delete_record(p_id uuid,p_expected integer) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE previous text:=current_setting('objects.soft_delete_record_id',true);person org.memberships%ROWTYPE;
 record_row objects.records%ROWTYPE;parent_type uuid;enforcement text;changed integer;
BEGIN
 IF current_user<>'ensemus_migrator' OR session_user<>'ensemus_app'
 OR app.current_actor_type() IS DISTINCT FROM 'user' OR app.current_organization_id() IS NULL
 OR p_id IS NULL OR p_expected IS NULL OR p_expected<1 THEN
 RAISE EXCEPTION 'OBJECT_DELETE_DENIED' USING ERRCODE='42501';END IF;
 PERFORM set_config('objects.soft_delete_record_id',p_id::text,true);
 BEGIN
   PERFORM pg_advisory_xact_lock(hashtextextended('interactive_policy:'||app.current_organization_id()::text,0));
   SELECT * INTO person FROM org.memberships WHERE organization_id=app.current_organization_id()
   AND id=app.current_membership_id() AND user_id=app.current_user_id() AND status='active' FOR SHARE;
   IF person.id IS NULL OR person.role NOT IN ('owner','admin','member') THEN
   RAISE EXCEPTION 'OBJECT_DELETE_DENIED' USING ERRCODE='42501';END IF;
   SELECT sso_enforcement INTO enforcement FROM org.security_policies WHERE organization_id=person.organization_id FOR SHARE;
   IF enforcement='required' AND person.role<>'owner' AND EXISTS(SELECT 1 FROM org.sso_connections
   WHERE organization_id=person.organization_id AND state='active') AND NOT identity.lock_required_sso_effect(
   person.organization_id,person.id,person.user_id,app.current_interactive_session_id()) THEN
   RAISE EXCEPTION 'SSO_REQUIRED' USING ERRCODE='EN410';END IF;
   IF NOT identity.lock_studio_session(person.user_id,app.current_interactive_session_id()) THEN
   RAISE EXCEPTION 'OBJECT_DELETE_DENIED' USING ERRCODE='42501';END IF;
   SELECT parent_record_id INTO parent_type FROM knowledge.structured_record_catalog
   WHERE organization_id=person.organization_id AND record_kind='object_record' AND record_id=p_id AND alive;
   IF parent_type IS NULL THEN RAISE EXCEPTION 'OBJECT_DELETE_DENIED' USING ERRCODE='42501';END IF;
   PERFORM 1 FROM objects.types WHERE organization_id=person.organization_id AND id=parent_type FOR SHARE NOWAIT;
   IF NOT FOUND THEN RAISE EXCEPTION 'OBJECT_DELETE_DENIED' USING ERRCODE='42501';END IF;
   SELECT * INTO record_row FROM objects.records WHERE organization_id=person.organization_id AND id=p_id AND deleted_at IS NULL FOR UPDATE NOWAIT;
   IF record_row.id IS NULL OR NOT coalesce(objects.record_readable(p_id,person.id),false)
   OR NOT (record_row.owner_membership_id=person.id OR person.role IN ('owner','admin')) THEN
   RAISE EXCEPTION 'OBJECT_DELETE_DENIED' USING ERRCODE='42501';END IF;
   IF record_row.version<>p_expected THEN RAISE EXCEPTION 'OBJECT_VERSION_CONFLICT' USING ERRCODE='EN407';END IF;
   UPDATE objects.records SET deleted_at=clock_timestamp(),updated_at=clock_timestamp(),version=version+1
   WHERE organization_id=person.organization_id AND id=p_id AND version=p_expected AND deleted_at IS NULL;
   GET DIAGNOSTICS changed=ROW_COUNT;
   IF changed<>1 THEN RAISE EXCEPTION 'OBJECT_VERSION_CONFLICT' USING ERRCODE='EN407';END IF;
 EXCEPTION WHEN OTHERS THEN
   PERFORM set_config('objects.soft_delete_record_id',coalesce(previous,''),true);RAISE;
 END;
 PERFORM set_config('objects.soft_delete_record_id',coalesce(previous,''),true);
END $$;
REVOKE ALL ON FUNCTION objects.soft_delete_record(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION objects.soft_delete_record(uuid,integer) TO ensemus_app;
--> statement-breakpoint
-- Raising a type is the only privileged cascade, preserves bodies/owners, and invalidates optimistic edits.
CREATE OR REPLACE FUNCTION objects.check_type_change() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
 IF NOT objects.active_person(true) OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.id<>OLD.id OR NEW.slug<>OLD.slug OR NEW.created_by_membership_id<>OLD.created_by_membership_id OR NEW.from_pack_installation_id IS DISTINCT FROM OLD.from_pack_installation_id OR NEW.created_at<>OLD.created_at OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'OBJECT_TYPE_AUTHORITY_DENIED' USING ERRCODE='42501'; END IF;
 IF length(btrim(NEW.display_name))=0 OR objects.text_units(NEW.display_name)>200 THEN RAISE EXCEPTION 'OBJECT_TYPE_INVALID' USING ERRCODE='EN403'; END IF;
 PERFORM 1 FROM org.memberships WHERE organization_id=NEW.organization_id AND id=app.current_membership_id() AND user_id=app.current_user_id() AND status='active' AND role IN ('owner','admin') FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'OBJECT_TYPE_AUTHORITY_DENIED' USING ERRCODE='42501'; END IF;
 IF app.classification_rank(NEW.classification)<app.classification_rank(OLD.classification) THEN RAISE EXCEPTION 'OBJECT_CLASSIFICATION_FLOOR' USING ERRCODE='EN403'; END IF;
 IF NEW.current_version_number NOT IN (OLD.current_version_number,OLD.current_version_number+1) OR NOT EXISTS(SELECT 1 FROM objects.type_versions v WHERE v.organization_id=NEW.organization_id AND v.type_id=NEW.id AND v.version_number=NEW.current_version_number) THEN RAISE EXCEPTION 'OBJECT_VERSION_INVALID' USING ERRCODE='EN407'; END IF;
 RETURN NEW;
 END $$;
-- AFTER ensures the floor metadata and actual type are new before cascading private rows.
CREATE FUNCTION objects.raise_record_floors() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 BEGIN
 IF TG_RELID<>'objects.types'::regclass OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() OR app.classification_rank(NEW.classification)<app.classification_rank(OLD.classification) THEN RAISE EXCEPTION 'OBJECT_CASCADE_INVALID' USING ERRCODE='42501'; END IF;
 UPDATE objects.records SET classification=NEW.classification,version=version+1,updated_at=now() WHERE organization_id=NEW.organization_id AND type_id=NEW.id AND deleted_at IS NULL AND app.classification_rank(classification)<app.classification_rank(NEW.classification);
 RETURN NEW;
 END $$;
REVOKE ALL ON FUNCTION objects.raise_record_floors() FROM PUBLIC;
CREATE POLICY object_cascade_read ON objects.records FOR SELECT TO ensemus_migrator USING(organization_id=app.current_organization_id() AND pg_trigger_depth()>0);
CREATE POLICY object_cascade_write ON objects.records FOR UPDATE TO ensemus_migrator USING(organization_id=app.current_organization_id() AND pg_trigger_depth()>0) WITH CHECK(organization_id=app.current_organization_id() AND pg_trigger_depth()>0);
CREATE POLICY object_trigger_read ON objects.types FOR SELECT TO ensemus_migrator USING(organization_id=app.current_organization_id() AND pg_trigger_depth()>0);
CREATE POLICY object_trigger_lock ON objects.types FOR UPDATE TO ensemus_migrator USING(organization_id=app.current_organization_id() AND pg_trigger_depth()>0) WITH CHECK(false);
CREATE POLICY object_trigger_read ON objects.type_versions FOR SELECT TO ensemus_migrator USING(organization_id=app.current_organization_id() AND pg_trigger_depth()>0);
CREATE TRIGGER object_type_floor_cascade AFTER UPDATE OF classification ON objects.types FOR EACH ROW WHEN(NEW.classification IS DISTINCT FROM OLD.classification) EXECUTE FUNCTION objects.raise_record_floors();
--> statement-breakpoint
-- The index is an exact derived projection, not a second writable copy with weaker ACLs.
CREATE FUNCTION objects.refresh_record_values() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE f jsonb; v jsonb; kind text;
 BEGIN
 IF TG_RELID<>'objects.records'::regclass OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN RAISE EXCEPTION 'OBJECT_INDEX_TARGET_INVALID' USING ERRCODE='42501'; END IF;
 DELETE FROM objects.record_values WHERE organization_id=NEW.organization_id AND record_id=NEW.id;
 IF NEW.deleted_at IS NOT NULL THEN RETURN NEW; END IF;
 FOR f IN SELECT jsonb_array_elements(fields) FROM objects.type_versions WHERE organization_id=NEW.organization_id AND type_id=NEW.type_id AND version_number=NEW.type_version_number LOOP
 v:=NEW.attributes->(f->>'key'); kind:=f->>'kind';
 IF (f->>'indexed')::boolean AND v IS NOT NULL AND v<>'null'::jsonb THEN
 INSERT INTO objects.record_values(organization_id,record_id,field_key,value_text,value_number,value_time,value_boolean) VALUES(NEW.organization_id,NEW.id,f->>'key',CASE WHEN kind NOT IN ('number','date','boolean') THEN v#>>'{}' END,CASE WHEN kind='number' THEN (v#>>'{}')::numeric END,CASE WHEN kind='date' THEN CASE WHEN length(v#>>'{}')=10 THEN (v#>>'{}')::date::timestamp AT TIME ZONE 'UTC' ELSE (v#>>'{}')::timestamptz END END,CASE WHEN kind='boolean' THEN (v#>>'{}')::boolean END);
 END IF; END LOOP; RETURN NEW;
 END $$;
REVOKE ALL ON FUNCTION objects.refresh_record_values() FROM PUBLIC;
CREATE POLICY object_index_writer ON objects.record_values TO ensemus_migrator USING(organization_id=app.current_organization_id() AND pg_trigger_depth()>0) WITH CHECK(organization_id=app.current_organization_id() AND pg_trigger_depth()>0);
CREATE TRIGGER object_record_index AFTER INSERT OR UPDATE ON objects.records FOR EACH ROW EXECUTE FUNCTION objects.refresh_record_values();
--> statement-breakpoint
CREATE FUNCTION objects.safe_shape_change(p_before jsonb,p_after jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_typeof(p_before)='array' AND jsonb_typeof(p_after)='array'
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_before) old_field WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_after) new_field WHERE new_field->>'key'=old_field->>'key'
 AND new_field->>'kind'=old_field->>'kind'
 AND (NOT coalesce((new_field->>'required')::boolean,false) OR coalesce((old_field->>'required')::boolean,false))
 AND coalesce((new_field->>'maxLength')::integer,CASE WHEN new_field->>'kind'='long_text' THEN 50000 ELSE 2000 END)>=coalesce((old_field->>'maxLength')::integer,CASE WHEN old_field->>'kind'='long_text' THEN 50000 ELSE 2000 END)
 AND (old_field->>'kind'<>'enum' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(old_field->'options') option WHERE NOT (new_field->'options' ? option)))))
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_after) new_field WHERE coalesce((new_field->>'required')::boolean,false) AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_before) old_field WHERE old_field->>'key'=new_field->>'key'))
$$;
REVOKE ALL ON FUNCTION objects.safe_shape_change(jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION objects.safe_shape_change(jsonb,jsonb) TO ensemus_app;
CREATE FUNCTION objects.schema_valid(p_fields jsonb,p_relations jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
 DECLARE f jsonb; option_value jsonb; k text; seen text[]:='{}'; indexed_count integer:=0; text_limit integer;
 BEGIN
 IF jsonb_typeof(p_fields) IS DISTINCT FROM 'array' OR jsonb_typeof(p_relations) IS DISTINCT FROM 'array' OR jsonb_array_length(p_fields)>64 OR jsonb_array_length(p_relations)>16 THEN RETURN false; END IF;
 FOR f IN SELECT * FROM jsonb_array_elements(p_fields) LOOP
 k:=f->>'key';
 IF jsonb_typeof(f) IS DISTINCT FROM 'object' OR k IS NULL OR k !~ '^[a-z][a-z0-9_]{0,62}$' OR k=ANY(seen) OR jsonb_typeof(f->'label') IS DISTINCT FROM 'string' OR length(btrim(f->>'label'))=0 OR objects.text_units(f->>'label')>120 OR f->>'kind' IS NULL OR f->>'kind' NOT IN ('text','long_text','number','boolean','date','enum','email','url') OR jsonb_typeof(f->'required') IS DISTINCT FROM 'boolean' OR jsonb_typeof(f->'indexed') IS DISTINCT FROM 'boolean' THEN RETURN false; END IF;
 seen:=array_append(seen,k);
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(f) property WHERE property NOT IN ('key','label','kind','required','indexed','options','maxLength')) THEN RETURN false; END IF;
 IF (f->>'indexed')::boolean THEN indexed_count:=indexed_count+1; IF f->>'kind'='long_text' THEN RETURN false; END IF; END IF;
 IF f->>'kind'='enum' THEN
 IF jsonb_typeof(f->'options') IS DISTINCT FROM 'array' OR jsonb_array_length(f->'options') NOT BETWEEN 1 AND 64 OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(f->'options'))<>jsonb_array_length(f->'options') THEN RETURN false; END IF;
 FOR option_value IN SELECT * FROM jsonb_array_elements(f->'options') LOOP IF jsonb_typeof(option_value) IS DISTINCT FROM 'string' OR length(btrim(option_value#>>'{}'))=0 OR objects.text_units(option_value#>>'{}')>120 THEN RETURN false; END IF; END LOOP;
 ELSIF f ? 'options' THEN RETURN false; END IF;
 IF f ? 'maxLength' THEN text_limit:=CASE WHEN f->>'kind'='long_text' THEN 50000 WHEN f->>'kind' IN ('text','email','url') THEN 2000 ELSE 0 END;
 IF jsonb_typeof(f->'maxLength') IS DISTINCT FROM 'number' OR (f->>'maxLength')::numeric<>trunc((f->>'maxLength')::numeric) OR (f->>'maxLength')::integer NOT BETWEEN 1 AND text_limit THEN RETURN false; END IF; END IF;
 END LOOP;
 IF indexed_count>8 THEN RETURN false; END IF;
 FOR f IN SELECT * FROM jsonb_array_elements(p_relations) LOOP
 k:=f->>'key'; IF jsonb_typeof(f) IS DISTINCT FROM 'object' OR k IS NULL OR k !~ '^[a-z][a-z0-9_]{0,62}$' OR k=ANY(seen) OR jsonb_typeof(f->'label') IS DISTINCT FROM 'string' OR length(btrim(f->>'label'))=0 OR objects.text_units(f->>'label')>120 OR f->>'toTypeSlug' IS NULL OR f->>'toTypeSlug' !~ '^[a-z][a-z0-9_]{1,63}$' OR f->>'toTypeSlug' IN ('work_unit','approval','grant','invoice','billing','membership','organization','agent','secret') OR f->>'cardinality' IS NULL OR f->>'cardinality' NOT IN ('one','many') THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(f) property WHERE property NOT IN ('key','label','toTypeSlug','cardinality')) THEN RETURN false; END IF; seen:=array_append(seen,k);
 END LOOP; RETURN true;
 EXCEPTION WHEN OTHERS THEN RETURN false;
 END $$;
REVOKE ALL ON FUNCTION objects.schema_valid(jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION objects.schema_valid(jsonb,jsonb) TO ensemus_app;
CREATE FUNCTION objects.guard_type_insert() RETURNS trigger LANGUAGE plpgsql AS $$
 DECLARE old_shape objects.type_versions%ROWTYPE; t objects.types%ROWTYPE;
 BEGIN
 IF NOT objects.active_person(true) OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() OR NEW.created_by_membership_id<>app.current_membership_id() THEN RAISE EXCEPTION 'OBJECT_TYPE_AUTHORITY_DENIED' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM org.memberships WHERE organization_id=NEW.organization_id AND id=app.current_membership_id() AND user_id=app.current_user_id() AND status='active' AND role IN ('owner','admin') FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'OBJECT_TYPE_AUTHORITY_DENIED' USING ERRCODE='42501'; END IF;
 IF TG_RELID='objects.types'::regclass THEN
 IF NEW.slug IN ('work_unit','approval','grant','invoice','billing','membership','organization','agent','secret') OR NEW.version<>1 OR NEW.current_version_number<>1 OR NEW.state<>'active' OR length(btrim(NEW.display_name))=0 OR objects.text_units(NEW.display_name)>200 THEN RAISE EXCEPTION 'OBJECT_TYPE_INVALID' USING ERRCODE='EN403'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('ensemus:object-types:'||NEW.organization_id::text,0));
 IF (SELECT count(*) FROM objects.types WHERE organization_id=NEW.organization_id)>=200 THEN RAISE EXCEPTION 'OBJECT_TYPE_LIMIT' USING ERRCODE='EN403'; END IF;
 ELSE
 SELECT * INTO t FROM objects.types WHERE organization_id=NEW.organization_id AND id=NEW.type_id FOR UPDATE;
 IF NOT FOUND OR t.state<>'active' OR NEW.version_number NOT IN (1,t.current_version_number+1) OR NEW.schema_sha256 !~ '^[0-9a-f]{64}$' OR NOT objects.schema_valid(NEW.fields,NEW.relations) THEN RAISE EXCEPTION 'OBJECT_SHAPE_INVALID' USING ERRCODE='EN403'; END IF;
 SELECT * INTO old_shape FROM objects.type_versions WHERE organization_id=NEW.organization_id AND type_id=NEW.type_id AND version_number=t.current_version_number;
 IF FOUND AND (NOT objects.safe_shape_change(old_shape.fields,NEW.fields) OR NOT NEW.relations @> old_shape.relations) THEN RAISE EXCEPTION 'OBJECT_UNSAFE_MIGRATION' USING ERRCODE='EN403'; END IF;
 END IF; RETURN NEW;
 END $$;
REVOKE ALL ON FUNCTION objects.guard_type_insert() FROM PUBLIC;
CREATE TRIGGER aa_object_type_insert BEFORE INSERT ON objects.types FOR EACH ROW EXECUTE FUNCTION objects.guard_type_insert();
CREATE TRIGGER object_shape_insert_authority BEFORE INSERT ON objects.type_versions FOR EACH ROW EXECUTE FUNCTION objects.guard_type_insert();
CREATE FUNCTION objects.guard_migration_progress() RETURNS trigger LANGUAGE plpgsql AS $$
 DECLARE m objects.migrations%ROWTYPE; record_row objects.records%ROWTYPE; fields jsonb;
 BEGIN
 IF NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN RAISE EXCEPTION 'OBJECT_MIGRATION_DENIED' USING ERRCODE='42501'; END IF;
 IF TG_RELID='objects.migration_results'::regclass THEN
 IF app.current_actor_type()<>'service' THEN RAISE EXCEPTION 'OBJECT_MIGRATION_DENIED' USING ERRCODE='42501'; END IF;
 SELECT * INTO m FROM objects.migrations WHERE organization_id=NEW.organization_id AND id=NEW.migration_id FOR UPDATE;
 SELECT * INTO record_row FROM objects.records WHERE organization_id=NEW.organization_id AND id=NEW.record_id FOR UPDATE;
 SELECT v.fields INTO fields FROM objects.type_versions v WHERE v.organization_id=m.organization_id AND v.type_id=m.type_id AND v.version_number=m.to_version_number;
 IF m.id IS NULL OR record_row.id IS NULL OR record_row.type_id<>m.type_id OR m.status<>'running' OR (NEW.outcome='migrated' AND (record_row.type_version_number<>m.to_version_number OR NOT objects.attributes_valid(fields,record_row.attributes) OR NEW.error_code IS NOT NULL)) OR (NEW.outcome='failed' AND (record_row.type_version_number>=m.to_version_number OR objects.attributes_valid(fields,record_row.attributes) OR NEW.error_code IS DISTINCT FROM 'OBJECT_RECORD_INVALID')) THEN RAISE EXCEPTION 'OBJECT_MIGRATION_RESULT_INVALID' USING ERRCODE='42501'; END IF;
 ELSIF TG_OP='INSERT' THEN
 IF NOT objects.active_person(true) OR NEW.requested_by_membership_id<>app.current_membership_id() OR NEW.to_version_number<>(SELECT current_version_number FROM objects.types WHERE organization_id=NEW.organization_id AND id=NEW.type_id) OR NEW.from_version_number<>NEW.to_version_number-1 THEN RAISE EXCEPTION 'OBJECT_MIGRATION_DENIED' USING ERRCODE='42501'; END IF;
 ELSE
 IF app.current_actor_type()<>'service' OR OLD.status IN ('completed','failed') OR (NEW.organization_id,NEW.id,NEW.type_id,NEW.from_version_number,NEW.to_version_number,NEW.requested_by_membership_id,NEW.created_at) IS DISTINCT FROM (OLD.organization_id,OLD.id,OLD.type_id,OLD.from_version_number,OLD.to_version_number,OLD.requested_by_membership_id,OLD.created_at) OR NEW.migrated_count<>(SELECT count(*) FROM objects.migration_results WHERE organization_id=NEW.organization_id AND migration_id=NEW.id AND outcome='migrated') OR NEW.failed_count<>(SELECT count(*) FROM objects.migration_results WHERE organization_id=NEW.organization_id AND migration_id=NEW.id AND outcome='failed') THEN RAISE EXCEPTION 'OBJECT_MIGRATION_PROGRESS_INVALID' USING ERRCODE='42501'; END IF;
 IF NEW.status='completed' AND EXISTS(SELECT 1 FROM objects.records r WHERE r.organization_id=NEW.organization_id AND r.type_id=NEW.type_id AND r.deleted_at IS NULL AND r.type_version_number<NEW.to_version_number AND NOT EXISTS(SELECT 1 FROM objects.migration_results x WHERE x.organization_id=r.organization_id AND x.migration_id=NEW.id AND x.record_id=r.id)) THEN RAISE EXCEPTION 'OBJECT_MIGRATION_INCOMPLETE' USING ERRCODE='EN407'; END IF;
 IF (NEW.status='completed' AND (NEW.failed_count<>0 OR NEW.error_code IS NOT NULL)) OR (NEW.status='failed' AND (NEW.error_code IS NULL OR NEW.error_code NOT IN ('OBJECT_RECORD_INVALID','MIGRATION_FAILED'))) THEN RAISE EXCEPTION 'OBJECT_MIGRATION_OUTCOME_INVALID' USING ERRCODE='EN407'; END IF;
 END IF; RETURN NEW;
 END $$;
REVOKE ALL ON FUNCTION objects.guard_migration_progress() FROM PUBLIC;
CREATE TRIGGER object_migration_authority BEFORE INSERT OR UPDATE ON objects.migrations FOR EACH ROW EXECUTE FUNCTION objects.guard_migration_progress();
CREATE TRIGGER object_migration_result_authority BEFORE INSERT ON objects.migration_results FOR EACH ROW EXECUTE FUNCTION objects.guard_migration_progress();
--> statement-breakpoint
CREATE FUNCTION objects.guard_relation_write() RETURNS trigger LANGUAGE plpgsql AS $$
 DECLARE edge objects.relations%ROWTYPE; origin objects.records%ROWTYPE; target objects.records%ROWTYPE; definition jsonb; target_slug text;
 BEGIN
 edge:=CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
 -- A distinct restricted eraser role has a later fixed grant/policy whitelist. This is not a
 -- service-actor exception. Missing lifecycle helper refuses; lineage/physical guards still apply.
 IF TG_OP='DELETE' AND current_user='ensemus_eraser' THEN
 IF OLD.organization_id IS DISTINCT FROM app.current_organization_id() OR lifecycle.erasure_open(OLD.organization_id) IS DISTINCT FROM true THEN RAISE EXCEPTION 'OBJECT_ERASURE_DENIED' USING ERRCODE='42501'; END IF;
 RETURN OLD;
 END IF;
 IF NOT objects.active_person() OR edge.organization_id IS DISTINCT FROM app.current_organization_id() OR (TG_OP='INSERT' AND edge.created_by_membership_id<>app.current_membership_id()) THEN RAISE EXCEPTION 'OBJECT_RELATION_DENIED' USING ERRCODE='42501'; END IF;
 -- NOWAIT avoids inverse order against a concurrent type-floor cascade or record edit.
 PERFORM 1 FROM objects.records WHERE organization_id=edge.organization_id AND id IN(edge.from_record_id,edge.to_record_id) ORDER BY id FOR UPDATE NOWAIT;
 SELECT * INTO origin FROM objects.records WHERE organization_id=edge.organization_id AND id=edge.from_record_id;
 SELECT * INTO target FROM objects.records WHERE organization_id=edge.organization_id AND id=edge.to_record_id;
 IF origin.id IS NULL OR target.id IS NULL OR NOT objects.record_readable(origin.id,app.current_membership_id()) OR NOT objects.record_readable(target.id,app.current_membership_id()) OR NOT(origin.owner_membership_id=app.current_membership_id() OR objects.active_person(true)) THEN RAISE EXCEPTION 'OBJECT_RELATION_DENIED' USING ERRCODE='42501'; END IF;
 IF TG_OP='INSERT' THEN
 SELECT v.relations INTO definition FROM objects.types t JOIN objects.type_versions v ON v.organization_id=t.organization_id AND v.type_id=t.id AND v.version_number=t.current_version_number WHERE t.organization_id=edge.organization_id AND t.id=origin.type_id AND t.state='active' FOR SHARE OF t NOWAIT;
 SELECT slug INTO target_slug FROM objects.types WHERE organization_id=edge.organization_id AND id=target.type_id AND state='active' FOR SHARE NOWAIT;
 SELECT d INTO definition FROM jsonb_array_elements(definition) d WHERE d->>'key'=edge.relation_key AND d->>'toTypeSlug'=target_slug;
 IF definition IS NULL THEN RAISE EXCEPTION 'OBJECT_RELATION_UNDECLARED' USING ERRCODE='EN403'; END IF;
 IF definition->>'cardinality'='one' AND EXISTS(SELECT 1 FROM objects.relations WHERE organization_id=edge.organization_id AND from_record_id=origin.id AND relation_key=edge.relation_key) THEN RAISE EXCEPTION 'OBJECT_RELATION_CARDINALITY' USING ERRCODE='EN407'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
 END $$;
REVOKE ALL ON FUNCTION objects.guard_relation_write() FROM PUBLIC;
CREATE TRIGGER object_relation_authority BEFORE INSERT OR DELETE ON objects.relations FOR EACH ROW EXECUTE FUNCTION objects.guard_relation_write();
-- A single-valued slot includes hidden endpoints too. Application SELECT cannot shrink its inventory.
CREATE TABLE objects.relation_slots (
 organization_id uuid NOT NULL, from_record_id uuid NOT NULL, relation_key text NOT NULL, relation_id uuid NOT NULL,
 PRIMARY KEY(organization_id,from_record_id,relation_key), UNIQUE(organization_id,relation_id),
 FOREIGN KEY(organization_id,from_record_id) REFERENCES objects.records(organization_id,id)
);
ALTER TABLE objects.relation_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE objects.relation_slots FORCE ROW LEVEL SECURITY;
CREATE POLICY slot_trigger ON objects.relation_slots TO ensemus_migrator USING(organization_id=app.current_organization_id() AND pg_trigger_depth()>0) WITH CHECK(organization_id=app.current_organization_id() AND pg_trigger_depth()>0);
-- Retain existing single-valued inventory too. Conflicting old slots refuse migration atomically;
-- a hidden endpoint never disappears from the cardinality basis. No body/history is synthesized.
CREATE POLICY object_slot_backfill ON objects.relations FOR SELECT TO ensemus_migrator USING(true);
CREATE POLICY object_slot_backfill ON objects.records FOR SELECT TO ensemus_migrator USING(true);
CREATE POLICY object_slot_backfill ON objects.types FOR SELECT TO ensemus_migrator USING(true);
CREATE POLICY object_slot_backfill ON objects.type_versions FOR SELECT TO ensemus_migrator USING(true);
CREATE POLICY object_slot_backfill ON objects.relation_slots FOR INSERT TO ensemus_migrator WITH CHECK(true);
INSERT INTO objects.relation_slots(organization_id,from_record_id,relation_key,relation_id)
 SELECT e.organization_id,e.from_record_id,e.relation_key,e.id FROM objects.relations e
 JOIN objects.records r ON r.organization_id=e.organization_id AND r.id=e.from_record_id
 JOIN objects.types t ON t.organization_id=r.organization_id AND t.id=r.type_id
 JOIN objects.type_versions v ON v.organization_id=t.organization_id AND v.type_id=t.id AND v.version_number=t.current_version_number
 CROSS JOIN LATERAL jsonb_array_elements(v.relations) d WHERE d->>'key'=e.relation_key AND d->>'cardinality'='one';
DROP POLICY object_slot_backfill ON objects.relations;
DROP POLICY object_slot_backfill ON objects.records;
DROP POLICY object_slot_backfill ON objects.types;
DROP POLICY object_slot_backfill ON objects.type_versions;
DROP POLICY object_slot_backfill ON objects.relation_slots;
CREATE FUNCTION objects.track_relation_slot() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE definition jsonb;
 BEGIN
 IF TG_RELID<>'objects.relations'::regclass OR (TG_OP='INSERT' AND NEW.organization_id IS DISTINCT FROM app.current_organization_id()) OR (TG_OP='DELETE' AND OLD.organization_id IS DISTINCT FROM app.current_organization_id()) THEN RAISE EXCEPTION 'OBJECT_SLOT_TARGET_INVALID' USING ERRCODE='42501'; END IF;
 IF TG_OP='DELETE' THEN DELETE FROM objects.relation_slots WHERE organization_id=OLD.organization_id AND relation_id=OLD.id; RETURN OLD; END IF;
 SELECT d INTO definition FROM objects.records r JOIN objects.types t ON t.organization_id=r.organization_id AND t.id=r.type_id JOIN objects.type_versions v ON v.organization_id=t.organization_id AND v.type_id=t.id AND v.version_number=t.current_version_number CROSS JOIN LATERAL jsonb_array_elements(v.relations) d WHERE r.organization_id=NEW.organization_id AND r.id=NEW.from_record_id AND d->>'key'=NEW.relation_key;
 IF definition->>'cardinality'='one' THEN INSERT INTO objects.relation_slots VALUES(NEW.organization_id,NEW.from_record_id,NEW.relation_key,NEW.id); END IF; RETURN NEW;
 END $$;
REVOKE ALL ON FUNCTION objects.track_relation_slot() FROM PUBLIC;
CREATE TRIGGER zz_object_relation_slot BEFORE INSERT OR DELETE ON objects.relations FOR EACH ROW EXECUTE FUNCTION objects.track_relation_slot();
