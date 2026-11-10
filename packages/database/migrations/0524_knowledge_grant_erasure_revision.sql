-- REVIEWED SECURITY SQL (ADR-032 D7). Changes here need human review, never agent approval.
-- 0524: additive repair for registered 0201 under the restricted eraser (0501, 0999). 0201's
-- source_grants_bump_revision trigger answers every grant INSERT or DELETE by updating
-- knowledge.sources.acl_revision. The eraser deletes tenant tables in catalog order, so it reaches
-- knowledge.source_grants while the tenant's knowledge.sources rows still exist, and that UPDATE is
-- refused: the eraser holds DELETE and SELECT(organization_id) only, never UPDATE on a content table.
-- eraseTenantRows then failed with "permission denied for table sources" (42501) for any tenant that
-- ever held a source grant (CI run 42587577445, knowledge-raw-objects: "erases genuine source/job and
-- ordered raw metadata from its native seal").
--
-- The repair leaves the bump out for exactly one caller: the restricted eraser role deleting a grant
-- of the tenant it is bound to, while that tenant's erasure is open (offboarding 'erasing' and no
-- active hold, the same lifecycle.erasure_open test the eraser's own policies use). The source row
-- is itself about to be erased, and nothing can be served from an erasing tenant, so there is no
-- live ACL decision for the revision to invalidate. Every other caller, operation and tenant takes
-- 0201's path unchanged, so a grant change by a person or service still bumps the revision (and
-- 0303's export epoch). No grant changes: the eraser gains no UPDATE, SELECT or EXECUTE.
DO $$ BEGIN
 IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND(rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'GRANT_REVISION_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 IF to_regprocedure('knowledge.bump_acl_revision()') IS NULL OR to_regprocedure('lifecycle.erasure_open(uuid)') IS NULL
  OR to_regclass('knowledge.source_grants') IS NULL OR to_regclass('knowledge.sources') IS NULL THEN
  RAISE EXCEPTION 'GRANT_REVISION_SOURCE_REQUIRED' USING ERRCODE='EN850';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger g WHERE g.tgrelid='knowledge.source_grants'::regclass AND g.tgname='source_grants_bump_revision'
  AND g.tgfoid='knowledge.bump_acl_revision()'::regprocedure AND g.tgenabled IN('O','A') AND NOT g.tgisinternal) THEN
  RAISE EXCEPTION 'GRANT_REVISION_TRIGGER_REQUIRED' USING ERRCODE='EN850';END IF;
END $$;
--> statement-breakpoint
-- 0201's body, with one added branch before the UPDATE. The function stays SECURITY INVOKER, so
-- current_user is the actual deleting role and cannot be assumed by another caller.
CREATE OR REPLACE FUNCTION knowledge.bump_acl_revision() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE row_org uuid; row_source uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    row_org := OLD.organization_id; row_source := OLD.source_id;
    IF current_user = 'ensemus_eraser' AND row_org = app.current_organization_id()
      AND lifecycle.erasure_open(row_org) IS TRUE THEN
      RETURN NULL;
    END IF;
  ELSE
    row_org := NEW.organization_id; row_source := NEW.source_id;
  END IF;
  UPDATE knowledge.sources s SET acl_revision = s.acl_revision + 1
   WHERE s.organization_id = row_org AND s.id = row_source;
  RETURN NULL;
END $$;
