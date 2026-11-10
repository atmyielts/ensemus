-- Source draft, unrun. A conservative tenant fence supplements every current RLS/reader check.
-- Missing joined tables are a migration refusal, never an unobserved revocation path.
DO $$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['knowledge.sources','knowledge.source_grants','integrations.external_resources',
    'integrations.external_resource_acl','integrations.connections','org.memberships','org.team_memberships',
    'org.teams','work.work_units','work.work_assignments','work.clients','work.client_readers','work.projects',
    'platform.tombstones','work.artifacts','work.work_artifacts','knowledge.artifact_citations'] LOOP
    IF to_regclass(name) IS NULL THEN RAISE EXCEPTION 'EXPORT_EPOCH_REQUIRED_TABLE_MISSING: %',name USING ERRCODE='EN301'; END IF;
  END LOOP;
END $$;
--> statement-breakpoint
CREATE TABLE sovereign.export_epochs(
  organization_id uuid PRIMARY KEY REFERENCES org.organizations(id),
  epoch bigint NOT NULL CHECK(epoch>0)
);
ALTER TABLE sovereign.export_epochs ENABLE ROW LEVEL SECURITY;
ALTER TABLE sovereign.export_epochs FORCE ROW LEVEL SECURITY;
CREATE POLICY export_epoch_tenant_read ON sovereign.export_epochs FOR SELECT TO ensemus_app
  USING(organization_id=app.current_organization_id());
CREATE POLICY export_epoch_fixed_writer ON sovereign.export_epochs TO ensemus_migrator
  USING(organization_id=app.current_organization_id()) WITH CHECK(organization_id=app.current_organization_id());
GRANT SELECT ON sovereign.export_epochs TO ensemus_app;
--> statement-breakpoint
-- These two policies exist only during the migration transaction, for ID/epoch backfill.
CREATE POLICY export_epoch_org_backfill ON org.organizations FOR SELECT TO ensemus_migrator USING(true);
CREATE POLICY export_epoch_backfill ON sovereign.export_epochs TO ensemus_migrator USING(true) WITH CHECK(true);
INSERT INTO sovereign.export_epochs(organization_id,epoch) SELECT id,1 FROM org.organizations;
DROP POLICY export_epoch_org_backfill ON org.organizations;
DROP POLICY export_epoch_backfill ON sovereign.export_epochs;
--> statement-breakpoint
CREATE FUNCTION sovereign.advance_export_epoch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid; before_row jsonb; after_row jsonb; tracked text[]; key text; changed boolean:=false;
BEGIN
  before_row:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  after_row:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END;
  tenant:=CASE WHEN TG_TABLE_SCHEMA='org' AND TG_TABLE_NAME='organizations'
    THEN (coalesce(after_row,before_row)->>'id')::uuid ELSE (coalesce(after_row,before_row)->>'organization_id')::uuid END;
  IF tenant IS NULL OR tenant IS DISTINCT FROM app.current_organization_id() THEN
    RAISE EXCEPTION 'EXPORT_EPOCH_TENANT_REQUIRED' USING ERRCODE='42501'; END IF;
  IF TG_OP='UPDATE' THEN
    tracked:=TG_ARGV;
    FOREACH key IN ARRAY tracked LOOP
      IF before_row->key IS DISTINCT FROM after_row->key THEN changed:=true; EXIT; END IF;
    END LOOP;
    IF NOT changed THEN RETURN NEW; END IF;
  END IF;
  INSERT INTO sovereign.export_epochs(organization_id,epoch) VALUES(tenant,1)
    ON CONFLICT(organization_id) DO UPDATE SET epoch=sovereign.export_epochs.epoch+1;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
REVOKE ALL ON FUNCTION sovereign.advance_export_epoch() FROM PUBLIC;
--> statement-breakpoint
-- AFTER triggers take the epoch lock last. Archive readers never lock the epoch row, so they cannot
-- hold it while waiting for a body/grant lock or storage I/O. Routine Work progress is not revocation.
CREATE TRIGGER export_epoch_org AFTER INSERT ON org.organizations FOR EACH ROW EXECUTE FUNCTION sovereign.advance_export_epoch();
CREATE TRIGGER export_epoch_sources AFTER INSERT OR UPDATE OR DELETE ON knowledge.sources FOR EACH ROW
  EXECUTE FUNCTION sovereign.advance_export_epoch('state','classification','owner_membership_id','acl_revision','connection_id','external_resource_id');
CREATE TRIGGER export_epoch_source_grants AFTER INSERT OR UPDATE OR DELETE ON knowledge.source_grants FOR EACH ROW
  EXECUTE FUNCTION sovereign.advance_export_epoch('source_id','principal_kind','membership_id','team_id');
CREATE TRIGGER export_epoch_resources AFTER INSERT OR UPDATE OR DELETE ON integrations.external_resources FOR EACH ROW
  EXECUTE FUNCTION sovereign.advance_export_epoch('connection_id','classification','acl_state','deleted_at');
CREATE TRIGGER export_epoch_provider_acl AFTER INSERT OR UPDATE OR DELETE ON integrations.external_resource_acl FOR EACH ROW
  EXECUTE FUNCTION sovereign.advance_export_epoch('resource_id','principal_kind','principal_external_id','access','membership_id','team_id');
CREATE TRIGGER export_epoch_connections AFTER INSERT OR UPDATE OR DELETE ON integrations.connections FOR EACH ROW
  EXECUTE FUNCTION sovereign.advance_export_epoch('state','granted_scopes','credential_secret_id');
CREATE TRIGGER export_epoch_members AFTER INSERT OR UPDATE OR DELETE ON org.memberships FOR EACH ROW
  EXECUTE FUNCTION sovereign.advance_export_epoch('status','role','user_id');
CREATE TRIGGER export_epoch_teams AFTER INSERT OR UPDATE OR DELETE ON org.teams FOR EACH ROW
  EXECUTE FUNCTION sovereign.advance_export_epoch('parent_id');
CREATE TRIGGER export_epoch_team_members AFTER INSERT OR UPDATE OR DELETE ON org.team_memberships FOR EACH ROW
  EXECUTE FUNCTION sovereign.advance_export_epoch('team_id','membership_id');
CREATE TRIGGER export_epoch_work AFTER INSERT OR UPDATE OR DELETE ON work.work_units FOR EACH ROW
  EXECUTE FUNCTION sovereign.advance_export_epoch('classification','owner_membership_id','project_id','parent_id');
CREATE TRIGGER export_epoch_work_access AFTER INSERT OR UPDATE OR DELETE ON work.work_assignments FOR EACH ROW
  EXECUTE FUNCTION sovereign.advance_export_epoch('work_unit_id','membership_id','responsibility','actor_type');
CREATE TRIGGER export_epoch_clients AFTER INSERT OR UPDATE OR DELETE ON work.clients FOR EACH ROW
  EXECUTE FUNCTION sovereign.advance_export_epoch('classification','owner_membership_id');
CREATE TRIGGER export_epoch_client_readers AFTER INSERT OR UPDATE OR DELETE ON work.client_readers FOR EACH ROW
  EXECUTE FUNCTION sovereign.advance_export_epoch('client_id','membership_id');
CREATE TRIGGER export_epoch_projects AFTER INSERT OR UPDATE OR DELETE ON work.projects FOR EACH ROW
  EXECUTE FUNCTION sovereign.advance_export_epoch('client_id');
CREATE TRIGGER export_epoch_tombstones AFTER INSERT ON platform.tombstones FOR EACH ROW
  EXECUTE FUNCTION sovereign.advance_export_epoch();
CREATE TRIGGER export_epoch_artifacts AFTER INSERT OR UPDATE OR DELETE ON work.artifacts FOR EACH ROW
  EXECUTE FUNCTION sovereign.advance_export_epoch('classification');
CREATE TRIGGER export_epoch_artifact_links AFTER INSERT OR UPDATE OR DELETE ON work.work_artifacts FOR EACH ROW
  EXECUTE FUNCTION sovereign.advance_export_epoch('artifact_id','work_unit_id');
CREATE TRIGGER export_epoch_citations AFTER INSERT OR UPDATE OR DELETE ON knowledge.artifact_citations FOR EACH ROW
  EXECUTE FUNCTION sovereign.advance_export_epoch('artifact_id','source_id','document_id','chunk_id');
--> statement-breakpoint
ALTER TABLE sovereign.organization_exports ADD COLUMN export_epoch bigint CHECK(export_epoch>0);
GRANT UPDATE(export_epoch) ON sovereign.organization_exports TO ensemus_app;
CREATE FUNCTION sovereign.guard_export_epoch_pin() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_epoch bigint;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.export_epoch IS NOT NULL THEN RAISE EXCEPTION 'EXPORT_EPOCH_NOT_PINNED' USING ERRCODE='EN301'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.export_epoch IS NULL AND OLD.status='requested' AND NEW.status='running' THEN
    SELECT epoch INTO current_epoch FROM sovereign.export_epochs WHERE organization_id=NEW.organization_id;
    IF current_epoch IS NULL OR NEW.export_epoch IS DISTINCT FROM current_epoch THEN
      RAISE EXCEPTION 'EXPORT_EPOCH_NOT_PINNED' USING ERRCODE='EN301'; END IF;
  ELSIF NEW.export_epoch IS DISTINCT FROM OLD.export_epoch THEN
    RAISE EXCEPTION 'EXPORT_EPOCH_IMMUTABLE' USING ERRCODE='EN301';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION sovereign.guard_export_epoch_pin() FROM PUBLIC;
CREATE TRIGGER export_epoch_pin BEFORE INSERT OR UPDATE ON sovereign.organization_exports
  FOR EACH ROW EXECUTE FUNCTION sovereign.guard_export_epoch_pin();
