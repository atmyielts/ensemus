-- REVIEWED SECURITY SQL (ADR-024 D4, ADR-029). Changes here need human review, never agent approval.

-- The type lives in public, which provision.sql closes to everyone, so the application role has to be
-- let in to use it. Nothing else of ours is in that schema.
GRANT USAGE ON SCHEMA public TO ensemus_app;
--> statement-breakpoint
GRANT USAGE ON SCHEMA knowledge TO ensemus_app;
--> statement-breakpoint

-- Who a transaction is acting for. withTenantTx binds both. Anything else, such as a webhook's context or
-- a transaction with nothing bound, has no membership and is not a service, so it reads no document.
CREATE FUNCTION app.current_membership_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.membership_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE FUNCTION app.current_actor_type() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.actor_type', true), '') $$;
--> statement-breakpoint
CREATE FUNCTION knowledge.is_service_actor() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$ SELECT coalesce(app.current_actor_type() = 'service' AND app.current_membership_id() IS NULL, false) $$;
--> statement-breakpoint

-- The one definition of who may read a source (ADR-029 D2). Everything that holds a document's words
-- filters through this, inside the query, by row-level security below. Being an owner or an admin grants
-- nothing here: a source is read by those its ACL names, as the source says.
--
-- A connector's source reads the provider's permissions live from M3's tables, so a sync committing a
-- changed ACL, a resource going, or a connection being revoked takes effect in that same commit. An
-- `unmapped` resource reads nothing, and a grant nobody could map has no target, so it matches nobody
-- (ADR-027 D3). A class that has risen since a grant was made narrows it at once: `organization` covers
-- public and internal only, and `restricted` is for named people only.
CREATE FUNCTION knowledge.readable_source_ids(p_membership uuid) RETURNS SETOF uuid
  LANGUAGE sql STABLE
  AS $$
  SELECT s.id
    FROM knowledge.sources s
   WHERE s.organization_id = app.current_organization_id()
     AND s.state = 'active'
     AND EXISTS (
       SELECT 1 FROM org.memberships m
        WHERE m.organization_id = s.organization_id AND m.id = p_membership AND m.status = 'active')
     AND (
       (s.kind = 'upload' AND EXISTS (
         SELECT 1 FROM knowledge.source_grants g
          WHERE g.organization_id = s.organization_id
            AND g.source_id = s.id
            AND (g.membership_id = p_membership
                 OR (g.principal_kind = 'organization' AND s.classification IN ('public', 'internal'))
                 OR (s.classification <> 'restricted' AND g.team_id IN (
                       SELECT tm.team_id FROM org.team_memberships tm
                        WHERE tm.organization_id = s.organization_id
                          AND tm.membership_id = p_membership)))))
       OR
       (s.kind = 'connector' AND EXISTS (
         SELECT 1
           FROM integrations.external_resources r
           JOIN integrations.connections c
             ON c.organization_id = r.organization_id AND c.id = r.connection_id
           JOIN integrations.external_resource_acl a
             ON a.organization_id = r.organization_id AND a.resource_id = r.id
          WHERE r.organization_id = s.organization_id
            AND r.id = s.external_resource_id
            AND r.deleted_at IS NULL
            AND r.acl_state <> 'unmapped'
            AND c.state = 'active'
            AND (a.membership_id = p_membership
                 OR (s.classification <> 'restricted' AND a.team_id IN (
                       SELECT tm.team_id FROM org.team_memberships tm
                        WHERE tm.organization_id = s.organization_id
                          AND tm.membership_id = p_membership)))))
     )
$$;
--> statement-breakpoint

-- canReadWork in @ensemus/domain/policy, in SQL, so a graph traversal and company search can filter inside
-- the query. A test holds the two together.
CREATE FUNCTION knowledge.can_read_work(p_work_unit uuid, p_membership uuid) RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
  SELECT EXISTS (
    SELECT 1
      FROM work.work_units w
      JOIN org.memberships m
        ON m.organization_id = w.organization_id AND m.id = p_membership AND m.status = 'active'
     WHERE w.organization_id = app.current_organization_id()
       AND w.id = p_work_unit
       AND (w.classification IN ('public', 'internal')
            OR w.owner_membership_id = p_membership
            OR EXISTS (
              SELECT 1 FROM work.work_assignments a
               WHERE a.organization_id = w.organization_id
                 AND a.work_unit_id = w.id
                 AND a.membership_id = p_membership)
            OR (w.classification = 'confidential' AND m.role IN ('owner', 'admin'))))
$$;
--> statement-breakpoint

CREATE FUNCTION knowledge.class_rank(p_class text) RETURNS integer
  LANGUAGE sql IMMUTABLE
  AS $$ SELECT array_position(ARRAY['public', 'internal', 'confidential', 'restricted'], p_class) $$;
--> statement-breakpoint

-- Forced RLS on every table in the schema, and a tenant policy on those holding only IDs, hashes and
-- counts. A test fails if a table misses it. The tables holding words get narrower policies below.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'knowledge' LOOP
    EXECUTE format('ALTER TABLE knowledge.%I ENABLE ROW LEVEL SECURITY', t.tablename);
    EXECUTE format('ALTER TABLE knowledge.%I FORCE ROW LEVEL SECURITY', t.tablename);
    IF t.tablename NOT IN ('documents', 'document_staging', 'chunks', 'embeddings', 'facts', 'answers') THEN
      EXECUTE format(
        'CREATE POLICY tenant_scoped ON knowledge.%I TO ensemus_app '
        'USING (organization_id = app.current_organization_id()) '
        'WITH CHECK (organization_id = app.current_organization_id())',
        t.tablename);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint

-- Documents and their derived words: read through the ACL. A person's upload writes a document row, and
-- only a service context, which is the worker's, changes one or writes what is derived from it.
CREATE POLICY acl_read ON knowledge.documents FOR SELECT TO ensemus_app
  USING (organization_id = app.current_organization_id()
         AND (knowledge.is_service_actor()
              OR source_id IN (SELECT knowledge.readable_source_ids(app.current_membership_id()))));
--> statement-breakpoint
CREATE POLICY tenant_insert ON knowledge.documents FOR INSERT TO ensemus_app
  WITH CHECK (organization_id = app.current_organization_id());
--> statement-breakpoint
CREATE POLICY service_update ON knowledge.documents FOR UPDATE TO ensemus_app
  USING (organization_id = app.current_organization_id() AND knowledge.is_service_actor())
  WITH CHECK (organization_id = app.current_organization_id());
--> statement-breakpoint
CREATE POLICY service_delete ON knowledge.documents FOR DELETE TO ensemus_app
  USING (organization_id = app.current_organization_id() AND knowledge.is_service_actor());
--> statement-breakpoint

CREATE POLICY acl_read ON knowledge.chunks FOR SELECT TO ensemus_app
  USING (organization_id = app.current_organization_id()
         AND (knowledge.is_service_actor()
              OR source_id IN (SELECT knowledge.readable_source_ids(app.current_membership_id()))));
--> statement-breakpoint
CREATE POLICY service_insert ON knowledge.chunks FOR INSERT TO ensemus_app
  WITH CHECK (organization_id = app.current_organization_id() AND knowledge.is_service_actor());
--> statement-breakpoint
CREATE POLICY service_delete ON knowledge.chunks FOR DELETE TO ensemus_app
  USING (organization_id = app.current_organization_id() AND knowledge.is_service_actor());
--> statement-breakpoint

CREATE POLICY acl_read ON knowledge.embeddings FOR SELECT TO ensemus_app
  USING (organization_id = app.current_organization_id()
         AND (knowledge.is_service_actor()
              OR source_id IN (SELECT knowledge.readable_source_ids(app.current_membership_id()))));
--> statement-breakpoint
CREATE POLICY service_insert ON knowledge.embeddings FOR INSERT TO ensemus_app
  WITH CHECK (organization_id = app.current_organization_id() AND knowledge.is_service_actor());
--> statement-breakpoint
CREATE POLICY service_delete ON knowledge.embeddings FOR DELETE TO ensemus_app
  USING (organization_id = app.current_organization_id() AND knowledge.is_service_actor());
--> statement-breakpoint

-- A connector's bytes on their way through. Only the workers go near them.
CREATE POLICY service_only ON knowledge.document_staging TO ensemus_app
  USING (organization_id = app.current_organization_id() AND knowledge.is_service_actor())
  WITH CHECK (organization_id = app.current_organization_id() AND knowledge.is_service_actor());
--> statement-breakpoint

-- A fact can say something about every source behind it, so it takes all of them to read it. Evidence
-- rows hold no words, and they stay tenant-scoped: if this subquery were filtered by the same ACL, an
-- unreadable source would vanish from it and the fact would look fine.
CREATE POLICY acl_read ON knowledge.facts FOR SELECT TO ensemus_app
  USING (organization_id = app.current_organization_id()
         AND (knowledge.is_service_actor()
              OR (app.current_membership_id() IS NOT NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM knowledge.fact_evidence e
                     WHERE e.organization_id = facts.organization_id
                       AND e.fact_id = facts.id
                       AND e.source_id NOT IN (
                         SELECT knowledge.readable_source_ids(app.current_membership_id()))))));
--> statement-breakpoint
CREATE POLICY tenant_insert ON knowledge.facts FOR INSERT TO ensemus_app
  WITH CHECK (organization_id = app.current_organization_id());
--> statement-breakpoint
CREATE POLICY tenant_update ON knowledge.facts FOR UPDATE TO ensemus_app
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
--> statement-breakpoint
CREATE POLICY service_delete ON knowledge.facts FOR DELETE TO ensemus_app
  USING (organization_id = app.current_organization_id() AND knowledge.is_service_actor());
--> statement-breakpoint

-- An answer is for the person who asked, and only while they can read everything that went into it. The
-- same point about the subquery applies. Only a worker writes the result.
CREATE POLICY requester_read ON knowledge.answers FOR SELECT TO ensemus_app
  USING (organization_id = app.current_organization_id()
         AND (knowledge.is_service_actor()
              OR (requester_membership_id = app.current_membership_id()
                  AND NOT EXISTS (
                    SELECT 1 FROM knowledge.answer_sources x
                     WHERE x.organization_id = answers.organization_id
                       AND x.answer_id = answers.id
                       AND x.source_id NOT IN (
                         SELECT knowledge.readable_source_ids(app.current_membership_id()))))));
--> statement-breakpoint
CREATE POLICY requester_insert ON knowledge.answers FOR INSERT TO ensemus_app
  WITH CHECK (organization_id = app.current_organization_id()
              AND requester_membership_id = app.current_membership_id());
--> statement-breakpoint
CREATE POLICY service_update ON knowledge.answers FOR UPDATE TO ensemus_app
  USING (organization_id = app.current_organization_id() AND knowledge.is_service_actor())
  WITH CHECK (organization_id = app.current_organization_id());
--> statement-breakpoint
CREATE POLICY service_delete ON knowledge.answers FOR DELETE TO ensemus_app
  USING (organization_id = app.current_organization_id() AND knowledge.is_service_actor());
--> statement-breakpoint

-- The two M5 tables outside this schema.
ALTER TABLE integrations.mcp_tools ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE integrations.mcp_tools FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_scoped ON integrations.mcp_tools TO ensemus_app
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
--> statement-breakpoint
ALTER TABLE work.client_onboardings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE work.client_onboardings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_scoped ON work.client_onboardings TO ensemus_app
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
--> statement-breakpoint

-- Grants. No other role comes here: the dispatcher sees event metadata, the secrets role sealed values.
GRANT SELECT, INSERT ON knowledge.sources TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (classification, state, acl_revision, owner_membership_id, version, updated_at, revoked_at)
  ON knowledge.sources TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON knowledge.source_grants TO ensemus_app;
--> statement-breakpoint
-- What a document is, its hash and whose source it belongs to, is fixed. Only how far along it is moves.
GRANT SELECT, INSERT, DELETE ON knowledge.documents TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (object_key, classification, scan_state, state, reject_code, parser_version,
              chunker_version, embedding_state, embedding_reason, searchable_at, superseded_at,
              version, updated_at)
  ON knowledge.documents TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON knowledge.document_staging TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON knowledge.chunks, knowledge.embeddings TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON knowledge.embedding_spaces TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (state, retired_at) ON knowledge.embedding_spaces TO ensemus_app;
--> statement-breakpoint
-- A claim, its subject and who proposed it cannot be edited, so a verified claim stays what was verified.
GRANT SELECT, INSERT, DELETE ON knowledge.facts TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (trust_state, conflict_ref, reviewed_by_membership_id, reviewed_at, review_reason,
              superseded_by_id, valid_until, version, updated_at)
  ON knowledge.facts TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON knowledge.fact_evidence, knowledge.edges TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON knowledge.evidence_packages, knowledge.evidence_items, knowledge.model_calls,
                        knowledge.artifact_verifications
  TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON knowledge.answers TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (state, refusal_code, package_id, answer_text, model_profile_ref, input_tokens,
              output_tokens, cost_micros, strongest_classification, version, finished_at)
  ON knowledge.answers TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON knowledge.answer_sources, knowledge.answer_citations,
                                knowledge.artifact_citations
  TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON knowledge.purge_jobs TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (state, documents_removed, chunks_removed, embeddings_removed, facts_removed,
              answers_removed, blobs_removed, attempts, last_error_code, completed_at)
  ON knowledge.purge_jobs TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON integrations.mcp_tools TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (definition, definition_sha256, status, side_effect_level, allowed_classes,
              reviewed_by_membership_id, reviewed_at, version, updated_at)
  ON integrations.mcp_tools TO ensemus_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON work.client_onboardings TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (state, state_code, cost_micros, version, finished_at)
  ON work.client_onboardings TO ensemus_app;
--> statement-breakpoint

-- Records, kept as written, for everyone including the owner.
CREATE TRIGGER evidence_packages_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON knowledge.evidence_packages
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
CREATE TRIGGER evidence_items_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON knowledge.evidence_items
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
CREATE TRIGGER model_calls_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON knowledge.model_calls
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
CREATE TRIGGER artifact_verifications_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON knowledge.artifact_verifications
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
-- A source row outlives its content, as the record that it existed and what happened to it.
CREATE TRIGGER sources_keep
  BEFORE DELETE OR TRUNCATE ON knowledge.sources
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint

-- A source only ever closes, and its class only ever rises. Coming back after a revoke would be how a
-- restore or a bug silently re-exposed something (QA-025), so a re-added source is a new row.
CREATE FUNCTION knowledge.check_source_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.state <> OLD.state AND NOT (
       (OLD.state = 'active' AND NEW.state IN ('revoked', 'deleted'))
       OR (OLD.state = 'revoked' AND NEW.state = 'deleted')) THEN
    RAISE EXCEPTION 'KNOWLEDGE_SOURCE_INVALID_TRANSITION' USING ERRCODE = 'EN101';
  END IF;
  IF knowledge.class_rank(NEW.classification) < knowledge.class_rank(OLD.classification) THEN
    RAISE EXCEPTION 'KNOWLEDGE_CLASS_CANNOT_FALL' USING ERRCODE = 'EN102';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER sources_check_change
  BEFORE UPDATE ON knowledge.sources
  FOR EACH ROW EXECUTE FUNCTION knowledge.check_source_change();
--> statement-breakpoint

-- Who may be granted what. A connector's permissions are the provider's, so nobody here can widen them.
CREATE FUNCTION knowledge.check_new_grant() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE source record;
BEGIN
  SELECT s.state, s.kind, s.classification INTO source
    FROM knowledge.sources s
   WHERE s.organization_id = NEW.organization_id AND s.id = NEW.source_id
     FOR SHARE;
  IF NOT FOUND OR source.state <> 'active' THEN
    RAISE EXCEPTION 'KNOWLEDGE_SOURCE_NOT_ACTIVE' USING ERRCODE = 'EN103';
  END IF;
  IF source.kind <> 'upload' THEN
    RAISE EXCEPTION 'KNOWLEDGE_GRANT_ON_CONNECTOR_SOURCE' USING ERRCODE = 'EN104';
  END IF;
  IF (NEW.principal_kind = 'organization' AND source.classification NOT IN ('public', 'internal'))
     OR (NEW.principal_kind = 'team' AND source.classification = 'restricted') THEN
    RAISE EXCEPTION 'KNOWLEDGE_GRANT_TOO_WIDE' USING ERRCODE = 'EN105';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER source_grants_check_new
  BEFORE INSERT ON knowledge.source_grants
  FOR EACH ROW EXECUTE FUNCTION knowledge.check_new_grant();
--> statement-breakpoint
CREATE FUNCTION knowledge.bump_acl_revision() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE row_org uuid; row_source uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    row_org := OLD.organization_id; row_source := OLD.source_id;
  ELSE
    row_org := NEW.organization_id; row_source := NEW.source_id;
  END IF;
  UPDATE knowledge.sources s SET acl_revision = s.acl_revision + 1
   WHERE s.organization_id = row_org AND s.id = row_source;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER source_grants_bump_revision
  AFTER INSERT OR DELETE ON knowledge.source_grants
  FOR EACH ROW EXECUTE FUNCTION knowledge.bump_acl_revision();
--> statement-breakpoint

-- Nothing derived can arrive once a source has closed, whatever a worker that started earlier is still
-- doing. A share lock means a revoke waits for an ingest transaction, or that ingest finds it closed, so
-- a purge's work cannot be undone behind it (ADR-029 D3).
CREATE FUNCTION knowledge.check_source_live() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE live text;
BEGIN
  SELECT s.state INTO live
    FROM knowledge.sources s
   WHERE s.organization_id = NEW.organization_id AND s.id = NEW.source_id
     FOR SHARE;
  IF live IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'KNOWLEDGE_SOURCE_NOT_ACTIVE' USING ERRCODE = 'EN103';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER documents_check_new
  BEFORE INSERT ON knowledge.documents
  FOR EACH ROW EXECUTE FUNCTION knowledge.check_source_live();
--> statement-breakpoint
CREATE TRIGGER chunks_check_new
  BEFORE INSERT ON knowledge.chunks
  FOR EACH ROW EXECUTE FUNCTION knowledge.check_source_live();
--> statement-breakpoint
CREATE TRIGGER embeddings_check_new
  BEFORE INSERT ON knowledge.embeddings
  FOR EACH ROW EXECUTE FUNCTION knowledge.check_source_live();
--> statement-breakpoint

-- A document's lifecycle, matching DOCUMENT_TRANSITIONS in @ensemus/domain/knowledge, with a test holding
-- the two together. Its class only rises.
CREATE FUNCTION knowledge.check_document_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE allowed boolean;
BEGIN
  IF knowledge.class_rank(NEW.classification) < knowledge.class_rank(OLD.classification) THEN
    RAISE EXCEPTION 'KNOWLEDGE_CLASS_CANNOT_FALL' USING ERRCODE = 'EN102';
  END IF;
  IF NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;
  allowed := CASE OLD.state
    WHEN 'received' THEN NEW.state IN ('parsing', 'rejected', 'failed', 'purged')
    WHEN 'parsing' THEN NEW.state IN ('searchable', 'rejected', 'failed', 'purged')
    WHEN 'failed' THEN NEW.state IN ('parsing', 'purged')
    WHEN 'rejected' THEN NEW.state = 'purged'
    WHEN 'searchable' THEN NEW.state = 'purged'
    ELSE false
  END;
  IF NOT allowed THEN
    RAISE EXCEPTION 'KNOWLEDGE_DOCUMENT_INVALID_TRANSITION' USING ERRCODE = 'EN106';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER documents_check_change
  BEFORE UPDATE ON knowledge.documents
  FOR EACH ROW EXECUTE FUNCTION knowledge.check_document_change();
--> statement-breakpoint

-- A source is at least as sensitive as anything in it, because the ACL rules read the source's class. So
-- a scan raising a document raises its source in the same statement.
CREATE FUNCTION knowledge.raise_source_class() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  UPDATE knowledge.sources s SET classification = NEW.classification, updated_at = now()
   WHERE s.organization_id = NEW.organization_id
     AND s.id = NEW.source_id
     AND knowledge.class_rank(s.classification) < knowledge.class_rank(NEW.classification);
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER documents_raise_source_class
  AFTER INSERT OR UPDATE OF classification ON knowledge.documents
  FOR EACH ROW EXECUTE FUNCTION knowledge.raise_source_class();
--> statement-breakpoint

-- A new fact starts as proposed, whoever or whatever it came from.
CREATE FUNCTION knowledge.check_new_fact() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.trust_state <> 'proposed' OR NEW.version <> 1
     OR NEW.reviewed_by_membership_id IS NOT NULL OR NEW.reviewed_at IS NOT NULL
     OR NEW.superseded_by_id IS NOT NULL THEN
    RAISE EXCEPTION 'KNOWLEDGE_FACT_INVALID_START' USING ERRCODE = 'EN107';
  END IF;
  IF NEW.origin = 'person' AND NEW.proposed_by_membership_id IS NULL THEN
    RAISE EXCEPTION 'KNOWLEDGE_FACT_INVALID_START' USING ERRCODE = 'EN107';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER facts_check_new
  BEFORE INSERT ON knowledge.facts
  FOR EACH ROW EXECUTE FUNCTION knowledge.check_new_fact();
--> statement-breakpoint

-- The trust gate (KNOW-04, SEC-009, QA-016). Matching FACT_TRANSITIONS in @ensemus/domain/knowledge. Only
-- a person, acting as themselves, can make a claim `verified`: not a model, not an agent acting for its
-- initiator, not a worker, and not whoever proposed it. It takes evidence on a source still open.
CREATE FUNCTION knowledge.check_fact_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  allowed boolean;
  backed boolean;
BEGIN
  IF NEW.trust_state = OLD.trust_state THEN
    RETURN NEW;
  END IF;
  allowed := CASE OLD.trust_state
    WHEN 'proposed' THEN NEW.trust_state IN ('verified', 'disputed', 'rejected', 'superseded')
    WHEN 'disputed' THEN NEW.trust_state IN ('verified', 'rejected', 'superseded')
    WHEN 'verified' THEN NEW.trust_state IN ('disputed', 'superseded')
    ELSE false
  END;
  IF NOT allowed THEN
    RAISE EXCEPTION 'KNOWLEDGE_FACT_INVALID_TRANSITION' USING ERRCODE = 'EN108';
  END IF;
  IF NEW.trust_state = 'disputed' AND NEW.conflict_ref IS NULL THEN
    RAISE EXCEPTION 'KNOWLEDGE_FACT_INVALID_TRANSITION' USING ERRCODE = 'EN108';
  END IF;
  IF NEW.trust_state = 'verified' THEN
    IF app.current_actor_type() IS DISTINCT FROM 'user'
       OR NEW.reviewed_by_membership_id IS NULL
       OR NEW.reviewed_by_membership_id IS DISTINCT FROM app.current_membership_id()
       OR NEW.reviewed_at IS NULL
       OR NEW.reviewed_by_membership_id = OLD.proposed_by_membership_id THEN
      RAISE EXCEPTION 'KNOWLEDGE_FACT_NEEDS_PERSON' USING ERRCODE = 'EN109';
    END IF;
    SELECT EXISTS (SELECT 1 FROM knowledge.fact_evidence e
                     WHERE e.organization_id = NEW.organization_id AND e.fact_id = NEW.id)
       AND NOT EXISTS (
             SELECT 1 FROM knowledge.fact_evidence e
               JOIN knowledge.sources s
                 ON s.organization_id = e.organization_id AND s.id = e.source_id
              WHERE e.organization_id = NEW.organization_id
                AND e.fact_id = NEW.id
                AND s.state <> 'active')
      INTO backed;
    IF NOT backed THEN
      RAISE EXCEPTION 'KNOWLEDGE_FACT_NEEDS_EVIDENCE' USING ERRCODE = 'EN110';
    END IF;
  END IF;
  IF NEW.trust_state = 'superseded' AND NEW.superseded_by_id IS NULL THEN
    RAISE EXCEPTION 'KNOWLEDGE_FACT_INVALID_TRANSITION' USING ERRCODE = 'EN108';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER facts_check_change
  BEFORE UPDATE ON knowledge.facts
  FOR EACH ROW EXECUTE FUNCTION knowledge.check_fact_change();
--> statement-breakpoint

-- A claim with nothing behind it cannot be stored at all. Deferred, so the fact and its evidence can be
-- written in one transaction, in that order.
CREATE FUNCTION knowledge.check_fact_has_evidence() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM knowledge.facts f
              WHERE f.organization_id = NEW.organization_id AND f.id = NEW.id)
     AND NOT EXISTS (SELECT 1 FROM knowledge.fact_evidence e
                      WHERE e.organization_id = NEW.organization_id AND e.fact_id = NEW.id) THEN
    RAISE EXCEPTION 'KNOWLEDGE_FACT_NEEDS_EVIDENCE' USING ERRCODE = 'EN110';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER facts_has_evidence
  AFTER INSERT ON knowledge.facts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION knowledge.check_fact_has_evidence();
--> statement-breakpoint

-- Evidence has to be a real passage, unchanged, that whoever wrote this can read, and the quote has to fit
-- inside it. Row-level security on `chunks` is what limits a person or an agent to what they can read, so
-- a run cannot cite a passage its initiator could not open. That stops invented citations at the door.
CREATE FUNCTION knowledge.check_new_evidence() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE passage record;
BEGIN
  SELECT c.content_sha256, c.source_id, c.char_end - c.char_start AS length INTO passage
    FROM knowledge.chunks c
   WHERE c.organization_id = NEW.organization_id AND c.id = NEW.chunk_id;
  IF NOT FOUND
     OR passage.source_id <> NEW.source_id
     OR passage.content_sha256 <> NEW.content_sha256
     OR NEW.quote_end > passage.length THEN
    RAISE EXCEPTION 'KNOWLEDGE_EVIDENCE_INVALID' USING ERRCODE = 'EN111';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER fact_evidence_check_new
  BEFORE INSERT ON knowledge.fact_evidence
  FOR EACH ROW EXECUTE FUNCTION knowledge.check_new_evidence();
--> statement-breakpoint

-- A polymorphic ID can have no foreign key, so a link's two ends are checked here, in this tenant.
CREATE FUNCTION knowledge.node_exists(p_type text, p_id uuid) RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
  SELECT CASE p_type
    WHEN 'client' THEN EXISTS (SELECT 1 FROM work.clients x WHERE x.id = p_id)
    WHEN 'project' THEN EXISTS (SELECT 1 FROM work.projects x WHERE x.id = p_id)
    WHEN 'work_unit' THEN EXISTS (SELECT 1 FROM work.work_units x WHERE x.id = p_id)
    WHEN 'membership' THEN EXISTS (SELECT 1 FROM org.memberships x
                                    WHERE x.organization_id = app.current_organization_id()
                                      AND x.id = p_id)
    WHEN 'team' THEN EXISTS (SELECT 1 FROM org.teams x WHERE x.id = p_id)
    WHEN 'knowledge_source' THEN EXISTS (SELECT 1 FROM knowledge.sources x WHERE x.id = p_id)
    ELSE false
  END
$$;
--> statement-breakpoint
CREATE FUNCTION knowledge.check_new_edge() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT knowledge.node_exists(NEW.from_type, NEW.from_id)
     OR NOT knowledge.node_exists(NEW.to_type, NEW.to_id) THEN
    RAISE EXCEPTION 'KNOWLEDGE_EDGE_NODE_MISSING' USING ERRCODE = 'EN112';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER edges_check_new
  BEFORE INSERT ON knowledge.edges
  FOR EACH ROW EXECUTE FUNCTION knowledge.check_new_edge();
--> statement-breakpoint

-- The relational model is the source of truth for structure, so these links are read live and are never
-- copied into `edges`, and they cannot go stale. A view that runs with the caller's rights, so row-level
-- security on the tables under it still applies. A traversal filters each node as well (ADR-029 D7).
CREATE VIEW knowledge.graph_links WITH (security_invoker = true) AS
  SELECT p.organization_id, 'project'::text AS from_type, p.id AS from_id,
         'for_client'::text AS relation, 'client'::text AS to_type, p.client_id AS to_id,
         'record'::text AS origin
    FROM work.projects p WHERE p.client_id IS NOT NULL
  UNION ALL
  SELECT w.organization_id, 'work_unit', w.id, 'in_project', 'project', w.project_id, 'record'
    FROM work.work_units w WHERE w.project_id IS NOT NULL
  UNION ALL
  SELECT w.organization_id, 'work_unit', w.id, 'part_of', 'work_unit', w.parent_id, 'record'
    FROM work.work_units w WHERE w.parent_id IS NOT NULL
  UNION ALL
  SELECT w.organization_id, 'membership', w.owner_membership_id, 'accountable_for', 'work_unit', w.id,
         'record'
    FROM work.work_units w
  UNION ALL
  SELECT a.organization_id, 'membership', a.membership_id, 'assigned_to', 'work_unit', a.work_unit_id,
         'record'
    FROM work.work_assignments a
  UNION ALL
  SELECT m.organization_id, 'membership', m.membership_id, 'member_of', 'team', m.team_id, 'record'
    FROM org.team_memberships m
  UNION ALL
  SELECT t.organization_id, 'team', t.id, 'part_of', 'team', t.parent_id, 'record'
    FROM org.teams t WHERE t.parent_id IS NOT NULL
  UNION ALL
  SELECT e.organization_id, e.from_type, e.from_id, e.relation, e.to_type, e.to_id, e.origin
    FROM knowledge.edges e;
--> statement-breakpoint
GRANT SELECT ON knowledge.graph_links TO ensemus_app;
--> statement-breakpoint

-- A person acting as themselves accepts an artifact, and only one that passed grounding as these exact
-- bytes. A grounding verdict comes from a worker. Neither can be written for someone else (AGENT-07).
CREATE FUNCTION knowledge.check_new_verification() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.kind = 'grounding' AND NOT knowledge.is_service_actor() THEN
    RAISE EXCEPTION 'KNOWLEDGE_VERIFICATION_NOT_ALLOWED' USING ERRCODE = 'EN113';
  END IF;
  IF NEW.kind = 'human' THEN
    IF app.current_actor_type() IS DISTINCT FROM 'user'
       OR NEW.decided_by_membership_id IS DISTINCT FROM app.current_membership_id() THEN
      RAISE EXCEPTION 'KNOWLEDGE_VERIFICATION_NOT_ALLOWED' USING ERRCODE = 'EN113';
    END IF;
    IF NEW.verdict = 'accepted' AND NOT EXISTS (
         SELECT 1 FROM knowledge.artifact_verifications v
          WHERE v.organization_id = NEW.organization_id
            AND v.artifact_id = NEW.artifact_id
            AND v.artifact_sha256 = NEW.artifact_sha256
            AND v.kind = 'grounding'
            AND v.verdict = 'passed') THEN
      RAISE EXCEPTION 'KNOWLEDGE_ARTIFACT_NOT_GROUNDED' USING ERRCODE = 'EN114';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER artifact_verifications_check_new
  BEFORE INSERT ON knowledge.artifact_verifications
  FOR EACH ROW EXECUTE FUNCTION knowledge.check_new_verification();
--> statement-breakpoint

-- An MCP server's words confer nothing (CONNECT-03). A tool starts unreviewed. Only a person, as
-- themselves, approves it. A changed definition loses any approval in the same statement, so a server
-- cannot change what a tool does under an approval it was given for something else.
CREATE FUNCTION integrations.check_new_mcp_tool() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.status <> 'pending_review' OR NEW.side_effect_level IS NOT NULL
     OR NEW.reviewed_by_membership_id IS NOT NULL OR cardinality(NEW.allowed_classes) <> 0 THEN
    RAISE EXCEPTION 'MCP_TOOL_INVALID_START' USING ERRCODE = 'EN115';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER mcp_tools_check_new
  BEFORE INSERT ON integrations.mcp_tools
  FOR EACH ROW EXECUTE FUNCTION integrations.check_new_mcp_tool();
--> statement-breakpoint
CREATE FUNCTION integrations.check_mcp_tool_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.definition_sha256 IS DISTINCT FROM OLD.definition_sha256 THEN
    NEW.status := 'pending_review';
    NEW.side_effect_level := NULL;
    NEW.allowed_classes := '{}';
    NEW.reviewed_by_membership_id := NULL;
    NEW.reviewed_at := NULL;
    RETURN NEW;
  END IF;
  IF NEW.status = 'approved' AND (OLD.status <> 'approved'
       OR NEW.side_effect_level IS DISTINCT FROM OLD.side_effect_level
       OR NEW.allowed_classes IS DISTINCT FROM OLD.allowed_classes)
     AND (app.current_actor_type() IS DISTINCT FROM 'user'
          OR NEW.reviewed_by_membership_id IS DISTINCT FROM app.current_membership_id()) THEN
    RAISE EXCEPTION 'MCP_TOOL_NEEDS_PERSON' USING ERRCODE = 'EN116';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER mcp_tools_check_change
  BEFORE UPDATE ON integrations.mcp_tools
  FOR EACH ROW EXECUTE FUNCTION integrations.check_mcp_tool_change();
--> statement-breakpoint

-- Company search over names (UX-22). `simple`, because these are names, not prose.
CREATE INDEX work_units_title_search_idx ON work.work_units
  USING gin (to_tsvector('simple'::regconfig, title));
--> statement-breakpoint
CREATE INDEX clients_name_search_idx ON work.clients
  USING gin (to_tsvector('simple'::regconfig, display_name));
--> statement-breakpoint
CREATE INDEX projects_name_search_idx ON work.projects
  USING gin (to_tsvector('simple'::regconfig, name));
--> statement-breakpoint

REVOKE ALL ON FUNCTION knowledge.readable_source_ids(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION knowledge.readable_source_ids(uuid) TO ensemus_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION knowledge.can_read_work(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION knowledge.can_read_work(uuid, uuid) TO ensemus_app;
