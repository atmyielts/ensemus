-- REVIEWED SECURITY SQL (ADR-032 D7). Changes here need human review, never agent approval.
-- Additive repair to 0516. lifecycle.admit_raw_put is SECURITY DEFINER, so for a person's upload its
-- call to knowledge.assert_human_source_authority(source,true) evaluates knowledge.readable_source_ids
-- as ensemus_migrator. 0516 gave that role raw-scoped SELECT on sources and on the caller's own
-- membership, but none on source_grants or team_memberships, so FORCE ROW LEVEL SECURITY hid every
-- grant, no upload source was readable, and every person's upload failed with
-- SOURCE_READABLE_UPLOAD_REQUIRED. These two SELECT-only policies let the definer see exactly the grant
-- metadata readable_source_ids needs, for the tenant the raw protocol has pinned, and only the rows that
-- could name the caller. The readable rule itself (class narrowing, restricted named-only, team and
-- organization grants) is unchanged, and no write, body or cross-tenant reach is added.
DO $$ BEGIN
 IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND(rolsuper OR rolbypassrls))
  OR to_regprocedure('lifecycle.raw_metadata_scope(uuid)') IS NULL
  OR to_regprocedure('lifecycle.admit_raw_put(uuid,uuid,bigint)') IS NULL
  OR to_regprocedure('knowledge.readable_source_ids(uuid)') IS NULL THEN
  RAISE EXCEPTION 'RAW_SOURCE_PREREQUISITE_REQUIRED' USING ERRCODE='EN850';END IF;
END $$;
--> statement-breakpoint
CREATE POLICY raw_person_grant_metadata ON knowledge.source_grants FOR SELECT TO ensemus_migrator
 USING(lifecycle.raw_metadata_scope(organization_id)
  AND(membership_id=app.current_membership_id() OR principal_kind IN('organization','team')));
--> statement-breakpoint
CREATE POLICY raw_person_team_metadata ON org.team_memberships FOR SELECT TO ensemus_migrator
 USING(lifecycle.raw_metadata_scope(organization_id) AND membership_id=app.current_membership_id());
