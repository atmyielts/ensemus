-- AGENT-07 / ADR-029 D12. Legacy unbound proofs remain history and cannot authorize new acceptance.
ALTER TABLE knowledge.artifact_citations ADD COLUMN recorded_by_membership_id uuid;
ALTER TABLE knowledge.artifact_citations ADD CONSTRAINT artifact_citations_recorded_by_fk
  FOREIGN KEY (organization_id, recorded_by_membership_id) REFERENCES org.memberships(organization_id,id);
ALTER TABLE knowledge.artifact_verifications ADD COLUMN citations_sha256 text;
ALTER TABLE knowledge.artifact_verifications ADD COLUMN proof_order bigint;
ALTER TABLE knowledge.artifact_verifications ADD CONSTRAINT artifact_verifications_citation_digest
  CHECK (citations_sha256 IS NULL OR citations_sha256 ~ '^[0-9a-f]{64}$');
CREATE UNIQUE INDEX artifact_verifications_proof_order
  ON knowledge.artifact_verifications(organization_id,artifact_id,proof_order) WHERE proof_order IS NOT NULL;
--> statement-breakpoint

-- Same fixed-field encoding as verification-proof.ts; UUIDs/hashes/numbers contain no ':' or newline.
CREATE FUNCTION knowledge.artifact_citation_digest(p_artifact uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT encode(sha256(convert_to(coalesce(string_agg(
    concat_ws(':', c.ordinal::text, c.chunk_id::text, c.document_id::text, c.source_id::text,
      c.content_sha256, c.artifact_start::text, c.artifact_end::text,
      coalesce(c.recorded_by_membership_id::text, '-')), E'\n' ORDER BY c.ordinal), ''), 'UTF8')), 'hex')
  FROM knowledge.artifact_citations c
  WHERE c.organization_id = app.current_organization_id() AND c.artifact_id = p_artifact
$$;
REVOKE ALL ON FUNCTION knowledge.artifact_citation_digest(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.artifact_citation_digest(uuid) TO ensemus_app;
--> statement-breakpoint

CREATE FUNCTION knowledge.preserve_artifact_citations() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE file work.artifacts%ROWTYPE; actor org.memberships%ROWTYPE; passage record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'KNOWLEDGE_ARTIFACT_NOT_GROUNDED' USING ERRCODE = 'EN114';
  END IF;
  SELECT * INTO file FROM work.artifacts a
    WHERE a.organization_id = app.current_organization_id()
      AND a.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.artifact_id ELSE NEW.artifact_id END FOR UPDATE;
  -- The parent's deletion cascades its citations, while verification history deliberately survives.
  IF NOT FOUND AND TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NOT FOUND OR EXISTS (SELECT 1 FROM platform.tombstones t
      WHERE t.organization_id = file.organization_id AND t.target_type = 'artifact' AND t.target_id = file.id)
    OR EXISTS (SELECT 1 FROM knowledge.artifact_verifications v
      WHERE v.organization_id = file.organization_id AND v.artifact_id = file.id) THEN
    RAISE EXCEPTION 'KNOWLEDGE_ARTIFACT_NOT_GROUNDED' USING ERRCODE = 'EN114';
  END IF;
  SELECT * INTO actor FROM org.memberships m WHERE m.organization_id = file.organization_id
    AND m.id = app.current_membership_id() AND m.status = 'active' FOR SHARE;
  IF NOT FOUND OR app.current_actor_type() NOT IN ('user','delegated','agent')
    OR NOT EXISTS (SELECT 1 FROM work.work_artifacts wa JOIN work.work_units w
      ON w.organization_id = wa.organization_id AND w.id = wa.work_unit_id
      WHERE wa.organization_id = file.organization_id AND wa.artifact_id = file.id
        AND knowledge.can_read_work(w.id, actor.id)
        AND (w.owner_membership_id = actor.id OR actor.role IN ('owner','admin')
          OR EXISTS (SELECT 1 FROM work.work_assignments x WHERE x.organization_id = w.organization_id
            AND x.work_unit_id = w.id AND x.membership_id = actor.id)))
    THEN
    RAISE EXCEPTION 'KNOWLEDGE_VERIFICATION_NOT_ALLOWED' USING ERRCODE = 'EN113';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NEW.recorded_by_membership_id IS DISTINCT FROM actor.id THEN
    RAISE EXCEPTION 'KNOWLEDGE_VERIFICATION_NOT_ALLOWED' USING ERRCODE = 'EN113';
  END IF;
  IF NEW.ordinal NOT BETWEEN 1 AND 50 OR NEW.artifact_end > file.size_bytes
    OR EXISTS (SELECT 1 FROM knowledge.artifact_citations c
      WHERE c.organization_id = file.organization_id AND c.artifact_id = file.id
        AND c.recorded_by_membership_id IS DISTINCT FROM actor.id) THEN
    RAISE EXCEPTION 'KNOWLEDGE_ARTIFACT_NOT_GROUNDED' USING ERRCODE = 'EN114';
  END IF;
  SELECT c.id, c.content_sha256, c.text_body, c.document_id, c.source_id, d.state AS document_state,
         d.superseded_at, d.classification AS document_class, s.state AS source_state,
         s.classification AS source_class INTO passage
    FROM knowledge.chunks c JOIN knowledge.documents d
      ON d.organization_id = c.organization_id AND d.id = c.document_id
    JOIN knowledge.sources s ON s.organization_id = c.organization_id AND s.id = c.source_id
    WHERE c.organization_id = file.organization_id AND c.id = NEW.chunk_id FOR SHARE OF d,s;
  IF NOT FOUND OR passage.document_id <> NEW.document_id OR passage.source_id <> NEW.source_id
    OR passage.content_sha256 <> NEW.content_sha256
    OR encode(sha256(convert_to(passage.text_body, 'UTF8')), 'hex') <> NEW.content_sha256
    OR passage.document_state <> 'searchable' OR passage.source_state <> 'active'
    OR passage.superseded_at IS NOT NULL
    OR knowledge.class_rank(passage.source_class) > knowledge.class_rank(file.classification)
    OR knowledge.class_rank(passage.document_class) > knowledge.class_rank(file.classification)
    OR EXISTS (SELECT 1 FROM platform.tombstones t WHERE t.organization_id = file.organization_id
      AND t.target_type = 'knowledge_source' AND t.target_id = NEW.source_id) THEN
    RAISE EXCEPTION 'KNOWLEDGE_ARTIFACT_NOT_GROUNDED' USING ERRCODE = 'EN114';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER artifact_citations_preserve_proof BEFORE INSERT OR UPDATE OR DELETE ON knowledge.artifact_citations
  FOR EACH ROW EXECUTE FUNCTION knowledge.preserve_artifact_citations();
CREATE TRIGGER artifact_citations_no_truncate BEFORE TRUNCATE ON knowledge.artifact_citations
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION knowledge.check_new_verification() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_work work.work_units%ROWTYPE; file work.artifacts%ROWTYPE;
        actor org.memberships%ROWTYPE; recorder uuid; citation_count integer;
BEGIN
  IF NEW.proof_order IS NOT NULL THEN
    RAISE EXCEPTION 'KNOWLEDGE_VERIFICATION_NOT_ALLOWED' USING ERRCODE = 'EN113';
  END IF;
  IF NEW.kind = 'grounding' AND NOT knowledge.is_service_actor() THEN
    RAISE EXCEPTION 'KNOWLEDGE_VERIFICATION_NOT_ALLOWED' USING ERRCODE = 'EN113';
  END IF;
  SELECT * INTO current_work FROM work.work_units w
    WHERE w.organization_id = NEW.organization_id AND w.id = NEW.work_unit_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'KNOWLEDGE_ARTIFACT_NOT_GROUNDED' USING ERRCODE = 'EN114'; END IF;
  SELECT a.* INTO file FROM work.artifacts a JOIN work.work_artifacts wa
    ON wa.organization_id = a.organization_id AND wa.artifact_id = a.id
    WHERE a.organization_id = NEW.organization_id AND a.id = NEW.artifact_id
      AND wa.work_unit_id = NEW.work_unit_id FOR UPDATE OF a,wa;
  IF NOT FOUND OR NEW.artifact_sha256 <> file.sha256
    OR NEW.objective_sha256 <> encode(sha256(convert_to(coalesce(current_work.objective,''), 'UTF8')), 'hex')
    OR NEW.citations_sha256 IS NULL
    OR NEW.citations_sha256 <> knowledge.artifact_citation_digest(file.id)
    OR EXISTS (SELECT 1 FROM platform.tombstones t WHERE t.organization_id = file.organization_id
      AND t.target_type = 'artifact' AND t.target_id = file.id) THEN
    RAISE EXCEPTION 'KNOWLEDGE_ARTIFACT_NOT_GROUNDED' USING ERRCODE = 'EN114';
  END IF;
  -- This query runs after acquiring the artifact lock, so a transaction started earlier cannot
  -- publish an older logical decision after a later-started check. Caller clocks have no authority.
  SELECT coalesce(max(v.proof_order),0)+1 INTO NEW.proof_order FROM knowledge.artifact_verifications v
    WHERE v.organization_id = NEW.organization_id AND v.artifact_id = NEW.artifact_id;
  NEW.created_at := clock_timestamp();
  IF NEW.kind = 'human' THEN
    SELECT * INTO actor FROM org.memberships m WHERE m.organization_id = NEW.organization_id
      AND m.id = app.current_membership_id() AND m.status = 'active' FOR SHARE;
    IF NOT FOUND OR app.current_actor_type() IS DISTINCT FROM 'user'
      OR NEW.decided_by_membership_id IS DISTINCT FROM actor.id
      OR NOT knowledge.can_read_work(current_work.id, actor.id)
      OR NOT (current_work.owner_membership_id = actor.id OR actor.role IN ('owner','admin'))
      OR NEW.reason_code IS NOT NULL OR length(coalesce(NEW.reason,'')) > 2000
      OR (NEW.verdict = 'rejected' AND nullif(btrim(NEW.reason),'') IS NULL) THEN
      RAISE EXCEPTION 'KNOWLEDGE_VERIFICATION_NOT_ALLOWED' USING ERRCODE = 'EN113';
    END IF;
  ELSIF NEW.reason IS NOT NULL OR (NEW.verdict = 'passed' AND NEW.reason_code IS NOT NULL)
    OR (NEW.verdict = 'failed' AND (NEW.reason_code IS NULL OR NEW.reason_code NOT IN ('NOT_GROUNDED','CITATION_INVALID','SOURCE_CLOSED'))) THEN
    RAISE EXCEPTION 'KNOWLEDGE_VERIFICATION_NOT_ALLOWED' USING ERRCODE = 'EN113';
  END IF;
  IF NEW.verdict IN ('passed','accepted') THEN
    SELECT count(*), (array_agg(c.recorded_by_membership_id ORDER BY c.ordinal))[1]
      INTO citation_count, recorder FROM knowledge.artifact_citations c
      WHERE c.organization_id = file.organization_id AND c.artifact_id = file.id;
    IF citation_count < 1 OR citation_count > 50 OR recorder IS NULL
      OR NOT knowledge.can_read_work(current_work.id, recorder)
      OR EXISTS (SELECT 1 FROM knowledge.artifact_citations c
        LEFT JOIN knowledge.chunks ch ON ch.organization_id = c.organization_id AND ch.id = c.chunk_id
        LEFT JOIN knowledge.documents d ON d.organization_id = ch.organization_id AND d.id = ch.document_id
        LEFT JOIN knowledge.sources s ON s.organization_id = ch.organization_id AND s.id = ch.source_id
        WHERE c.organization_id = file.organization_id AND c.artifact_id = file.id AND (
          c.recorded_by_membership_id IS DISTINCT FROM recorder OR ch.id IS NULL
          OR c.document_id <> ch.document_id OR c.source_id <> ch.source_id
          OR c.content_sha256 <> ch.content_sha256 OR encode(sha256(convert_to(ch.text_body,'UTF8')),'hex') <> c.content_sha256
          OR s.state <> 'active' OR d.state <> 'searchable' OR d.superseded_at IS NOT NULL
          OR c.source_id NOT IN (SELECT knowledge.readable_source_ids(recorder))
          OR (NEW.kind = 'human' AND c.source_id NOT IN (SELECT knowledge.readable_source_ids(actor.id)))
          OR knowledge.class_rank(s.classification) > knowledge.class_rank(current_work.classification)
          OR knowledge.class_rank(s.classification) > knowledge.class_rank(file.classification)
          OR knowledge.class_rank(d.classification) > knowledge.class_rank(current_work.classification)
          OR knowledge.class_rank(d.classification) > knowledge.class_rank(file.classification)
          OR EXISTS (SELECT 1 FROM platform.tombstones t WHERE t.organization_id = c.organization_id
            AND t.target_type = 'knowledge_source' AND t.target_id = c.source_id))) THEN
      RAISE EXCEPTION 'KNOWLEDGE_ARTIFACT_NOT_GROUNDED' USING ERRCODE = 'EN114';
    END IF;
    IF NEW.kind = 'human' AND (SELECT v.verdict FROM knowledge.artifact_verifications v
      WHERE v.organization_id = NEW.organization_id AND v.artifact_id = NEW.artifact_id
        AND v.work_unit_id = NEW.work_unit_id AND v.artifact_sha256 = NEW.artifact_sha256
        AND v.objective_sha256 = NEW.objective_sha256 AND v.citations_sha256 = NEW.citations_sha256
        AND v.kind = 'grounding' AND v.proof_order IS NOT NULL ORDER BY v.proof_order DESC NULLS LAST LIMIT 1) IS DISTINCT FROM 'passed' THEN
      RAISE EXCEPTION 'KNOWLEDGE_ARTIFACT_NOT_GROUNDED' USING ERRCODE = 'EN114';
    END IF;
  END IF;
  RETURN NEW;
END $$;
