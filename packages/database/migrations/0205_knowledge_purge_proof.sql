-- A local projection purge cannot certify M4's separately owned transcript payloads. Its proof binds
-- to the permanently closed source and the complete set of runs recorded by immutable provenance.
ALTER TABLE knowledge.documents ADD COLUMN object_purge_observed boolean NOT NULL DEFAULT false;
--> statement-breakpoint
GRANT UPDATE(object_purge_observed) ON knowledge.documents TO ensemus_app;
--> statement-breakpoint
ALTER TABLE knowledge.purge_jobs
  ADD COLUMN retry_requests integer NOT NULL DEFAULT 0,
  ADD COLUMN next_retry_at timestamptz DEFAULT now()+interval '10 minutes',
  ADD COLUMN last_attempt_at timestamptz,
  ADD COLUMN transcripts_removed integer NOT NULL DEFAULT 0,
  ADD COLUMN derived_artifacts_removed integer NOT NULL DEFAULT 0,
  ADD COLUMN derived_artifacts_held integer NOT NULL DEFAULT 0,
  ADD COLUMN artifacts_checked_at timestamptz,
  ADD COLUMN transcripts_checked_at timestamptz,
  ADD COLUMN transcript_source_version bigint,
  ADD COLUMN transcript_runs_sha256 text;
--> statement-breakpoint
ALTER TABLE knowledge.purge_jobs ADD CONSTRAINT knowledge_purge_retry_requests CHECK(retry_requests>=0);
--> statement-breakpoint
GRANT UPDATE(retry_requests,next_retry_at,last_attempt_at) ON knowledge.purge_jobs TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE(derived_artifacts_removed,derived_artifacts_held,artifacts_checked_at) ON knowledge.purge_jobs TO ensemus_app;
--> statement-breakpoint
-- Older completion had no generated-file erasure proof. Retain its counts and permanently closed
-- source, but require the lifecycle adapter to attest before reporting complete under this contract.
UPDATE knowledge.purge_jobs SET state='failed',completed_at=NULL,last_error_code='ARTIFACT_PURGE_UNCONFIRMED'
  WHERE state='completed';
--> statement-breakpoint
ALTER TABLE knowledge.purge_jobs ADD CONSTRAINT knowledge_purge_transcript_proof CHECK (
  transcripts_removed >= 0 AND
  ((transcripts_checked_at IS NULL AND transcript_source_version IS NULL AND transcript_runs_sha256 IS NULL)
   OR (transcripts_checked_at IS NOT NULL AND transcript_source_version > 0
       AND transcript_runs_sha256 ~ '^[0-9a-f]{64}$'))
);
--> statement-breakpoint
GRANT UPDATE (transcripts_removed, transcripts_checked_at, transcript_source_version, transcript_runs_sha256)
  ON knowledge.purge_jobs TO ensemus_app;
--> statement-breakpoint
CREATE TABLE knowledge.object_writers (
  organization_id uuid NOT NULL, document_id uuid NOT NULL, source_id uuid NOT NULL,
  generation bigint NOT NULL, write_id uuid NOT NULL, state text NOT NULL, started_by_membership_id uuid,
  started_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(organization_id,document_id),
  FOREIGN KEY(organization_id,document_id,source_id) REFERENCES knowledge.documents(organization_id,id,source_id),
  FOREIGN KEY(organization_id,started_by_membership_id) REFERENCES org.memberships(organization_id,id),
  CONSTRAINT knowledge_object_writer_state CHECK(state IN ('active','settled') AND generation>0)
);
--> statement-breakpoint
CREATE INDEX knowledge_object_writers_source_idx ON knowledge.object_writers(organization_id,source_id,state);
--> statement-breakpoint
ALTER TABLE knowledge.object_writers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE knowledge.object_writers FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_scoped ON knowledge.object_writers TO ensemus_app
  USING(organization_id=app.current_organization_id()) WITH CHECK(organization_id=app.current_organization_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge.object_writers TO ensemus_app;
--> statement-breakpoint
CREATE FUNCTION knowledge.check_object_writer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF NOT knowledge.is_service_actor() OR OLD.state<>'settled' THEN
      RAISE EXCEPTION 'KNOWLEDGE_OBJECT_WRITER_UNCONFIRMED' USING ERRCODE='42501';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' AND OLD.state='active' THEN
    IF NEW.state<>'settled' OR ROW(NEW.organization_id,NEW.document_id,NEW.source_id,NEW.generation,NEW.write_id,NEW.started_at,NEW.started_by_membership_id)
      IS DISTINCT FROM ROW(OLD.organization_id,OLD.document_id,OLD.source_id,OLD.generation,OLD.write_id,OLD.started_at,OLD.started_by_membership_id)
      OR (NOT knowledge.is_service_actor() AND OLD.started_by_membership_id IS DISTINCT FROM app.current_membership_id()) THEN
      RAISE EXCEPTION 'KNOWLEDGE_OBJECT_WRITER_UNCONFIRMED' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM 1 FROM knowledge.sources WHERE organization_id=NEW.organization_id AND id=NEW.source_id
    AND state='active' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'KNOWLEDGE_OBJECT_WRITER_UNCONFIRMED' USING ERRCODE='42501';
  END IF;
  IF NEW.state<>'active' OR (TG_OP='INSERT' AND NEW.generation<>1)
    OR (TG_OP='UPDATE' AND (NEW.generation<>OLD.generation+1 OR NEW.write_id=OLD.write_id
      OR ROW(NEW.organization_id,NEW.document_id,NEW.source_id) IS DISTINCT FROM ROW(OLD.organization_id,OLD.document_id,OLD.source_id)))
    OR NOT EXISTS(SELECT 1 FROM knowledge.sources s JOIN knowledge.documents d
      ON d.organization_id=s.organization_id AND d.source_id=s.id
      WHERE s.organization_id=NEW.organization_id AND s.id=NEW.source_id AND s.state='active'
        AND d.id=NEW.document_id AND d.state IN ('received','failed','parsing'))
    OR (NOT knowledge.is_service_actor() AND (app.current_actor_type()<>'user'
      OR NEW.started_by_membership_id IS DISTINCT FROM app.current_membership_id())) THEN
    RAISE EXCEPTION 'KNOWLEDGE_OBJECT_WRITER_UNCONFIRMED' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER object_writers_check BEFORE INSERT OR UPDATE OR DELETE ON knowledge.object_writers
  FOR EACH ROW EXECUTE FUNCTION knowledge.check_object_writer();
--> statement-breakpoint
CREATE FUNCTION knowledge.check_purge_proof() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'pending' OR NEW.transcripts_checked_at IS NOT NULL OR NEW.transcripts_removed<>0
      OR NEW.transcript_source_version IS NOT NULL OR NEW.transcript_runs_sha256 IS NOT NULL OR NEW.retry_requests<>0
      OR NEW.derived_artifacts_removed<>0 OR NEW.derived_artifacts_held<>0 OR NEW.artifacts_checked_at IS NOT NULL THEN
      RAISE EXCEPTION 'KNOWLEDGE_PURGE_UNCONFIRMED' USING ERRCODE='42501';
    END IF;
    NEW.next_retry_at:=now()+interval '10 minutes';
    RETURN NEW;
  END IF;
  IF NEW.derived_artifacts_removed<OLD.derived_artifacts_removed OR NEW.derived_artifacts_held<0 THEN
    RAISE EXCEPTION 'KNOWLEDGE_PURGE_UNCONFIRMED' USING ERRCODE='42501';
  END IF;
  IF ROW(NEW.derived_artifacts_removed,NEW.derived_artifacts_held,NEW.artifacts_checked_at)
    IS DISTINCT FROM ROW(OLD.derived_artifacts_removed,OLD.derived_artifacts_held,OLD.artifacts_checked_at)
    AND NOT knowledge.is_service_actor() THEN
    RAISE EXCEPTION 'KNOWLEDGE_PURGE_NEEDS_SERVICE' USING ERRCODE='42501';
  END IF;
  IF NEW.retry_requests<OLD.retry_requests OR NEW.retry_requests>OLD.retry_requests+1 THEN
    RAISE EXCEPTION 'KNOWLEDGE_PURGE_UNCONFIRMED' USING ERRCODE='42501';
  END IF;
  IF ROW(NEW.retry_requests,NEW.next_retry_at,NEW.last_attempt_at)
    IS DISTINCT FROM ROW(OLD.retry_requests,OLD.next_retry_at,OLD.last_attempt_at)
    AND NOT knowledge.is_service_actor() THEN
    RAISE EXCEPTION 'KNOWLEDGE_PURGE_NEEDS_SERVICE' USING ERRCODE='42501';
  END IF;
  IF (NEW.state IN ('running','completed') OR ROW(NEW.transcripts_removed,NEW.transcripts_checked_at,NEW.transcript_source_version,NEW.transcript_runs_sha256)
    IS DISTINCT FROM ROW(OLD.transcripts_removed,OLD.transcripts_checked_at,OLD.transcript_source_version,OLD.transcript_runs_sha256))
    AND NOT knowledge.is_service_actor() THEN
    RAISE EXCEPTION 'KNOWLEDGE_PURGE_NEEDS_SERVICE' USING ERRCODE='42501';
  END IF;
  IF NEW.state='completed' AND (NEW.transcripts_checked_at IS NULL OR NEW.artifacts_checked_at IS NULL OR NEW.derived_artifacts_held<>0
    OR EXISTS(SELECT 1 FROM knowledge.object_writers w WHERE w.organization_id=NEW.organization_id AND w.source_id=NEW.source_id AND w.state='active')) THEN
    RAISE EXCEPTION 'KNOWLEDGE_PURGE_UNCONFIRMED' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER purge_jobs_proof BEFORE INSERT OR UPDATE ON knowledge.purge_jobs
  FOR EACH ROW EXECUTE FUNCTION knowledge.check_purge_proof();
