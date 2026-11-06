-- Generated from packages/database/src/schema-knowledge.ts, numbered for M5, plus this check. pgvector is
-- created by a superuser in provision.sql, and the migrator cannot create it, so say so clearly (ADR-029).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    RAISE EXCEPTION 'The vector extension is missing. A superuser has to run: CREATE EXTENSION vector';
  END IF;
END $$;
--> statement-breakpoint
CREATE SCHEMA "knowledge";
--> statement-breakpoint
CREATE TABLE "work"."client_onboardings" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"deal_ref" text NOT NULL,
	"client_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"work_unit_id" uuid NOT NULL,
	"state" text DEFAULT 'started' NOT NULL,
	"state_code" text,
	"cost_micros" bigint,
	"requested_by_membership_id" uuid NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "client_onboardings_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "client_onboardings_deal" UNIQUE("organization_id","deal_ref"),
	CONSTRAINT "client_onboardings_state" CHECK ("work"."client_onboardings"."state" in ('started','waiting_for_brief','waiting_for_acceptance','waiting_for_send','completed','failed','unknown')),
	CONSTRAINT "client_onboardings_deal_size" CHECK (length("work"."client_onboardings"."deal_ref") between 1 and 128),
	CONSTRAINT "client_onboardings_version_check" CHECK ("work"."client_onboardings"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "knowledge"."answer_citations" (
	"organization_id" uuid NOT NULL,
	"answer_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"chunk_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"answer_start" integer NOT NULL,
	"answer_end" integer NOT NULL,
	CONSTRAINT "answer_citations_organization_id_answer_id_ordinal_pk" PRIMARY KEY("organization_id","answer_id","ordinal"),
	CONSTRAINT "knowledge_answer_citations_span" CHECK ("knowledge"."answer_citations"."answer_start" >= 0 and "knowledge"."answer_citations"."answer_end" > "knowledge"."answer_citations"."answer_start")
);
--> statement-breakpoint
CREATE TABLE "knowledge"."answer_sources" (
	"organization_id" uuid NOT NULL,
	"answer_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	CONSTRAINT "answer_sources_organization_id_answer_id_source_id_pk" PRIMARY KEY("organization_id","answer_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "knowledge"."answers" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"requester_membership_id" uuid NOT NULL,
	"question" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"refusal_code" text,
	"package_id" uuid,
	"answer_text" text,
	"model_profile_ref" uuid,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_micros" bigint,
	"strongest_classification" text,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "answers_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "knowledge_answers_state" CHECK ("knowledge"."answers"."state" in ('queued','running','answered','no_evidence','refused','failed')),
	CONSTRAINT "knowledge_answers_question_size" CHECK (length("knowledge"."answers"."question") between 1 and 4000),
	CONSTRAINT "knowledge_answers_answer_size" CHECK ("knowledge"."answers"."answer_text" is null or length("knowledge"."answers"."answer_text") <= 65536),
	CONSTRAINT "knowledge_answers_version_check" CHECK ("knowledge"."answers"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "knowledge"."artifact_citations" (
	"organization_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"chunk_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"content_sha256" text NOT NULL,
	"artifact_start" integer NOT NULL,
	"artifact_end" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_citations_organization_id_artifact_id_ordinal_pk" PRIMARY KEY("organization_id","artifact_id","ordinal"),
	CONSTRAINT "knowledge_artifact_citations_span" CHECK ("knowledge"."artifact_citations"."artifact_start" >= 0 and "knowledge"."artifact_citations"."artifact_end" > "knowledge"."artifact_citations"."artifact_start")
);
--> statement-breakpoint
CREATE TABLE "knowledge"."artifact_verifications" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"artifact_id" uuid NOT NULL,
	"work_unit_id" uuid NOT NULL,
	"artifact_sha256" text NOT NULL,
	"objective_sha256" text NOT NULL,
	"kind" text NOT NULL,
	"verdict" text NOT NULL,
	"reason_code" text,
	"reason" text,
	"decided_by_membership_id" uuid,
	"package_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_verifications_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "knowledge_artifact_verifications_kind" CHECK ("knowledge"."artifact_verifications"."kind" in ('grounding','human')),
	CONSTRAINT "knowledge_artifact_verifications_verdict" CHECK (("knowledge"."artifact_verifications"."kind" = 'grounding' and "knowledge"."artifact_verifications"."verdict" in ('passed','failed')) or ("knowledge"."artifact_verifications"."kind" = 'human' and "knowledge"."artifact_verifications"."verdict" in ('accepted','rejected'))),
	CONSTRAINT "knowledge_artifact_verifications_person" CHECK (("knowledge"."artifact_verifications"."kind" = 'human') = ("knowledge"."artifact_verifications"."decided_by_membership_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "knowledge"."chunks" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"text_body" text NOT NULL,
	"lexemes" "tsvector" GENERATED ALWAYS AS (to_tsvector('english'::regconfig, text_body)) STORED,
	"content_sha256" text NOT NULL,
	"token_estimate" integer NOT NULL,
	"char_start" integer NOT NULL,
	"char_end" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chunks_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "knowledge_chunks_ordinal" UNIQUE("organization_id","document_id","ordinal"),
	CONSTRAINT "knowledge_chunks_id_source" UNIQUE("organization_id","id","source_id"),
	CONSTRAINT "knowledge_chunks_ordinal_check" CHECK ("knowledge"."chunks"."ordinal" >= 0),
	CONSTRAINT "knowledge_chunks_size" CHECK (octet_length("knowledge"."chunks"."text_body") between 1 and 32768),
	CONSTRAINT "knowledge_chunks_span" CHECK ("knowledge"."chunks"."char_start" >= 0 and "knowledge"."chunks"."char_end" > "knowledge"."chunks"."char_start"),
	CONSTRAINT "knowledge_chunks_sha_check" CHECK ("knowledge"."chunks"."content_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "knowledge"."document_staging" (
	"organization_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"body" "bytea" NOT NULL,
	"size_bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_staging_organization_id_document_id_pk" PRIMARY KEY("organization_id","document_id"),
	CONSTRAINT "knowledge_document_staging_bound" CHECK (octet_length("knowledge"."document_staging"."body") <= 26214400)
);
--> statement-breakpoint
CREATE TABLE "knowledge"."documents" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"title" text NOT NULL,
	"source_version" text,
	"source_url" text,
	"source_modified_at" timestamp with time zone,
	"content_sha256" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"media_type" text NOT NULL,
	"object_key" text,
	"classification" text NOT NULL,
	"scan_state" text DEFAULT 'not_scanned' NOT NULL,
	"state" text DEFAULT 'received' NOT NULL,
	"reject_code" text,
	"parser_version" text,
	"chunker_version" text,
	"embedding_state" text DEFAULT 'pending' NOT NULL,
	"embedding_reason" text,
	"searchable_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"created_by_membership_id" uuid,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "knowledge_documents_version" UNIQUE("organization_id","source_id","version_no"),
	CONSTRAINT "knowledge_documents_id_source" UNIQUE("organization_id","id","source_id"),
	CONSTRAINT "knowledge_documents_state_check" CHECK ("knowledge"."documents"."state" in ('received','parsing','searchable','rejected','failed','purged')),
	CONSTRAINT "knowledge_documents_embedding_check" CHECK ("knowledge"."documents"."embedding_state" in ('pending','embedding','embedded','denied','failed')),
	CONSTRAINT "knowledge_documents_scan_check" CHECK ("knowledge"."documents"."scan_state" in ('not_scanned','clean','flagged')),
	CONSTRAINT "knowledge_documents_classification_check" CHECK ("knowledge"."documents"."classification" in ('public','internal','confidential','restricted')),
	CONSTRAINT "knowledge_documents_sha_check" CHECK ("knowledge"."documents"."content_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "knowledge_documents_url_check" CHECK ("knowledge"."documents"."source_url" is null or "knowledge"."documents"."source_url" ~ '^https://'),
	CONSTRAINT "knowledge_documents_title_size" CHECK (length("knowledge"."documents"."title") between 1 and 512),
	CONSTRAINT "knowledge_documents_size_check" CHECK ("knowledge"."documents"."size_bytes" between 0 and 26214400),
	CONSTRAINT "knowledge_documents_version_check" CHECK ("knowledge"."documents"."version" > 0 and "knowledge"."documents"."version_no" > 0)
);
--> statement-breakpoint
CREATE TABLE "knowledge"."edges" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"from_type" text NOT NULL,
	"from_id" uuid NOT NULL,
	"relation" text NOT NULL,
	"to_type" text NOT NULL,
	"to_id" uuid NOT NULL,
	"origin" text NOT NULL,
	"fact_id" uuid,
	"created_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edges_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "knowledge_edges_identity" UNIQUE("organization_id","from_type","from_id","relation","to_type","to_id"),
	CONSTRAINT "knowledge_edges_from_type" CHECK ("knowledge"."edges"."from_type" in ('client','project','membership','team','work_unit','knowledge_source')),
	CONSTRAINT "knowledge_edges_to_type" CHECK ("knowledge"."edges"."to_type" in ('client','project','membership','team','work_unit','knowledge_source')),
	CONSTRAINT "knowledge_edges_relation_format" CHECK ("knowledge"."edges"."relation" ~ '^[a-z][a-z0-9_]{0,63}$'),
	CONSTRAINT "knowledge_edges_origin" CHECK ("knowledge"."edges"."origin" in ('person','fact')),
	CONSTRAINT "knowledge_edges_origin_shape" CHECK (("knowledge"."edges"."origin" = 'fact') = ("knowledge"."edges"."fact_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "knowledge"."embedding_spaces" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"model_profile_ref" uuid,
	"model_profile_version" bigint,
	"model_id" text NOT NULL,
	"dimension" integer NOT NULL,
	"vector_space_version" text NOT NULL,
	"distance" text DEFAULT 'cosine' NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "embedding_spaces_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "knowledge_embedding_spaces_identity" UNIQUE("organization_id","model_id","dimension","vector_space_version"),
	CONSTRAINT "knowledge_embedding_spaces_dimension" UNIQUE("organization_id","id","dimension"),
	CONSTRAINT "knowledge_embedding_spaces_state" CHECK ("knowledge"."embedding_spaces"."state" in ('active','retired')),
	CONSTRAINT "knowledge_embedding_spaces_dimension_range" CHECK ("knowledge"."embedding_spaces"."dimension" between 1 and 8192),
	CONSTRAINT "knowledge_embedding_spaces_distance" CHECK ("knowledge"."embedding_spaces"."distance" in ('cosine'))
);
--> statement-breakpoint
CREATE TABLE "knowledge"."embeddings" (
	"organization_id" uuid NOT NULL,
	"chunk_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"dimension" integer NOT NULL,
	"embedding" vector NOT NULL,
	"content_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "embeddings_organization_id_chunk_id_space_id_pk" PRIMARY KEY("organization_id","chunk_id","space_id"),
	CONSTRAINT "knowledge_embeddings_size" CHECK (vector_dims("knowledge"."embeddings"."embedding") = "knowledge"."embeddings"."dimension")
);
--> statement-breakpoint
CREATE TABLE "knowledge"."evidence_items" (
	"organization_id" uuid NOT NULL,
	"package_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"chunk_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"content_sha256" text NOT NULL,
	"classification" text NOT NULL,
	"token_estimate" integer NOT NULL,
	"lexical_rank" integer,
	"vector_rank" integer,
	CONSTRAINT "evidence_items_organization_id_package_id_ordinal_pk" PRIMARY KEY("organization_id","package_id","ordinal"),
	CONSTRAINT "knowledge_evidence_items_class" CHECK ("knowledge"."evidence_items"."classification" in ('public','internal','confidential','restricted'))
);
--> statement-breakpoint
CREATE TABLE "knowledge"."evidence_packages" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"purpose" text NOT NULL,
	"work_unit_id" uuid,
	"run_id" uuid,
	"viewer_membership_id" uuid NOT NULL,
	"query_sha256" text NOT NULL,
	"policy_version" text NOT NULL,
	"space_id" uuid,
	"budget_tokens" integer NOT NULL,
	"used_tokens" integer NOT NULL,
	"strongest_classification" text NOT NULL,
	"package_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_packages_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "knowledge_evidence_packages_purpose" CHECK ("knowledge"."evidence_packages"."purpose" in ('answer','agent_turn')),
	CONSTRAINT "knowledge_evidence_packages_class" CHECK ("knowledge"."evidence_packages"."strongest_classification" in ('public','internal','confidential','restricted')),
	CONSTRAINT "knowledge_evidence_packages_budget" CHECK ("knowledge"."evidence_packages"."budget_tokens" > 0 and "knowledge"."evidence_packages"."used_tokens" >= 0 and "knowledge"."evidence_packages"."used_tokens" <= "knowledge"."evidence_packages"."budget_tokens")
);
--> statement-breakpoint
CREATE TABLE "knowledge"."fact_evidence" (
	"organization_id" uuid NOT NULL,
	"fact_id" uuid NOT NULL,
	"chunk_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"content_sha256" text NOT NULL,
	"quote_start" integer NOT NULL,
	"quote_end" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fact_evidence_organization_id_fact_id_chunk_id_pk" PRIMARY KEY("organization_id","fact_id","chunk_id"),
	CONSTRAINT "knowledge_fact_evidence_span" CHECK ("knowledge"."fact_evidence"."quote_start" >= 0 and "knowledge"."fact_evidence"."quote_end" > "knowledge"."fact_evidence"."quote_start")
);
--> statement-breakpoint
CREATE TABLE "knowledge"."facts" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"subject_ref" text NOT NULL,
	"predicate" text NOT NULL,
	"claim" jsonb NOT NULL,
	"trust_state" text DEFAULT 'proposed' NOT NULL,
	"origin" text NOT NULL,
	"classification" text NOT NULL,
	"proposed_by_membership_id" uuid,
	"proposed_by_run_id" uuid,
	"conflict_ref" text,
	"reviewed_by_membership_id" uuid,
	"reviewed_at" timestamp with time zone,
	"review_reason" text,
	"superseded_by_id" uuid,
	"valid_from" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "facts_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "knowledge_facts_trust_state" CHECK ("knowledge"."facts"."trust_state" in ('proposed','verified','disputed','superseded','rejected')),
	CONSTRAINT "knowledge_facts_origin" CHECK ("knowledge"."facts"."origin" in ('model','person')),
	CONSTRAINT "knowledge_facts_classification" CHECK ("knowledge"."facts"."classification" in ('public','internal','confidential','restricted')),
	CONSTRAINT "knowledge_facts_subject_format" CHECK ("knowledge"."facts"."subject_ref" ~ '^(client|project|membership|team|work_unit|knowledge_source):[0-9a-f-]{36}$'),
	CONSTRAINT "knowledge_facts_predicate_format" CHECK ("knowledge"."facts"."predicate" ~ '^[a-z][a-z0-9_.]{0,63}$'),
	CONSTRAINT "knowledge_facts_claim_size" CHECK (octet_length("knowledge"."facts"."claim"::text) <= 16384),
	CONSTRAINT "knowledge_facts_version_check" CHECK ("knowledge"."facts"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "knowledge"."model_calls" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"purpose" text NOT NULL,
	"data_class" text NOT NULL,
	"model_profile_ref" uuid,
	"model_profile_version" bigint,
	"provider_kind" text,
	"destination_host" text,
	"decision" text NOT NULL,
	"reason_code" text NOT NULL,
	"policy_version" text NOT NULL,
	"request_sha256" text NOT NULL,
	"document_id" uuid,
	"answer_id" uuid,
	"input_count" integer DEFAULT 0 NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_calls_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "knowledge_model_calls_purpose" CHECK ("knowledge"."model_calls"."purpose" in ('embed','rerank','answer')),
	CONSTRAINT "knowledge_model_calls_class" CHECK ("knowledge"."model_calls"."data_class" in ('public','internal','confidential','restricted')),
	CONSTRAINT "knowledge_model_calls_decision" CHECK ("knowledge"."model_calls"."decision" in ('allow','deny')),
	CONSTRAINT "knowledge_model_calls_shape" CHECK ("knowledge"."model_calls"."decision" = 'deny' or ("knowledge"."model_calls"."model_profile_ref" is not null and "knowledge"."model_calls"."destination_host" is not null))
);
--> statement-breakpoint
CREATE TABLE "knowledge"."purge_jobs" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"documents_removed" integer DEFAULT 0 NOT NULL,
	"chunks_removed" integer DEFAULT 0 NOT NULL,
	"embeddings_removed" integer DEFAULT 0 NOT NULL,
	"facts_removed" integer DEFAULT 0 NOT NULL,
	"answers_removed" integer DEFAULT 0 NOT NULL,
	"blobs_removed" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "purge_jobs_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "knowledge_purge_jobs_source" UNIQUE("organization_id","source_id"),
	CONSTRAINT "knowledge_purge_jobs_reason" CHECK ("knowledge"."purge_jobs"."reason" in ('deleted','revoked','connection_revoked','resource_gone','restore_reapply')),
	CONSTRAINT "knowledge_purge_jobs_state_check" CHECK ("knowledge"."purge_jobs"."state" in ('pending','running','completed','failed')),
	CONSTRAINT "knowledge_purge_jobs_completed" CHECK (("knowledge"."purge_jobs"."state" = 'completed') = ("knowledge"."purge_jobs"."completed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "knowledge"."source_grants" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"principal_kind" text NOT NULL,
	"membership_id" uuid,
	"team_id" uuid,
	"granted_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_grants_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "knowledge_source_grants_kind" CHECK ("knowledge"."source_grants"."principal_kind" in ('membership','team','organization')),
	CONSTRAINT "knowledge_source_grants_shape" CHECK (("knowledge"."source_grants"."principal_kind" = 'membership') = ("knowledge"."source_grants"."membership_id" is not null) and ("knowledge"."source_grants"."principal_kind" = 'team') = ("knowledge"."source_grants"."team_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "knowledge"."sources" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"connection_id" uuid,
	"external_resource_id" uuid,
	"classification" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"acl_revision" bigint DEFAULT 1 NOT NULL,
	"owner_membership_id" uuid,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "sources_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "knowledge_sources_kind_check" CHECK ("knowledge"."sources"."kind" in ('upload','connector')),
	CONSTRAINT "knowledge_sources_shape" CHECK (("knowledge"."sources"."kind" = 'connector') = ("knowledge"."sources"."connection_id" is not null) and ("knowledge"."sources"."kind" = 'connector') = ("knowledge"."sources"."external_resource_id" is not null)),
	CONSTRAINT "knowledge_sources_state_check" CHECK ("knowledge"."sources"."state" in ('active','revoked','deleted')),
	CONSTRAINT "knowledge_sources_classification_check" CHECK ("knowledge"."sources"."classification" in ('public','internal','confidential','restricted')),
	CONSTRAINT "knowledge_sources_version_check" CHECK ("knowledge"."sources"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "integrations"."mcp_tools" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"tool_name" text NOT NULL,
	"definition" jsonb NOT NULL,
	"definition_sha256" text NOT NULL,
	"status" text DEFAULT 'pending_review' NOT NULL,
	"side_effect_level" text,
	"allowed_classes" text[] DEFAULT '{}'::text[] NOT NULL,
	"reviewed_by_membership_id" uuid,
	"reviewed_at" timestamp with time zone,
	"version" bigint DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_tools_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "mcp_tools_name" UNIQUE("organization_id","connection_id","tool_name"),
	CONSTRAINT "mcp_tools_status" CHECK ("integrations"."mcp_tools"."status" in ('pending_review','approved','rejected','removed')),
	CONSTRAINT "mcp_tools_side_effect" CHECK ("integrations"."mcp_tools"."side_effect_level" is null or "integrations"."mcp_tools"."side_effect_level" in ('read_only','external_write')),
	CONSTRAINT "mcp_tools_approved_shape" CHECK ("integrations"."mcp_tools"."status" <> 'approved' or ("integrations"."mcp_tools"."side_effect_level" is not null and "integrations"."mcp_tools"."reviewed_by_membership_id" is not null and "integrations"."mcp_tools"."reviewed_at" is not null)),
	CONSTRAINT "mcp_tools_name_size" CHECK (length("integrations"."mcp_tools"."tool_name") between 1 and 128),
	CONSTRAINT "mcp_tools_definition_size" CHECK (octet_length("integrations"."mcp_tools"."definition"::text) <= 65536),
	CONSTRAINT "mcp_tools_sha_check" CHECK ("integrations"."mcp_tools"."definition_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "mcp_tools_version_check" CHECK ("integrations"."mcp_tools"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "work"."client_onboardings" ADD CONSTRAINT "client_onboardings_organization_id_client_id_clients_organization_id_id_fk" FOREIGN KEY ("organization_id","client_id") REFERENCES "work"."clients"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work"."client_onboardings" ADD CONSTRAINT "client_onboardings_organization_id_project_id_projects_organization_id_id_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "work"."projects"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work"."client_onboardings" ADD CONSTRAINT "client_onboardings_organization_id_work_unit_id_work_units_organization_id_id_fk" FOREIGN KEY ("organization_id","work_unit_id") REFERENCES "work"."work_units"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work"."client_onboardings" ADD CONSTRAINT "client_onboardings_organization_id_requested_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","requested_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."answer_citations" ADD CONSTRAINT "answer_citations_organization_id_answer_id_answers_organization_id_id_fk" FOREIGN KEY ("organization_id","answer_id") REFERENCES "knowledge"."answers"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."answer_citations" ADD CONSTRAINT "answer_citations_organization_id_chunk_id_source_id_chunks_organization_id_id_source_id_fk" FOREIGN KEY ("organization_id","chunk_id","source_id") REFERENCES "knowledge"."chunks"("organization_id","id","source_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."answer_sources" ADD CONSTRAINT "answer_sources_organization_id_answer_id_answers_organization_id_id_fk" FOREIGN KEY ("organization_id","answer_id") REFERENCES "knowledge"."answers"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."answer_sources" ADD CONSTRAINT "answer_sources_organization_id_source_id_sources_organization_id_id_fk" FOREIGN KEY ("organization_id","source_id") REFERENCES "knowledge"."sources"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."answers" ADD CONSTRAINT "answers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."answers" ADD CONSTRAINT "answers_organization_id_requester_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","requester_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."answers" ADD CONSTRAINT "answers_organization_id_package_id_evidence_packages_organization_id_id_fk" FOREIGN KEY ("organization_id","package_id") REFERENCES "knowledge"."evidence_packages"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."artifact_citations" ADD CONSTRAINT "artifact_citations_organization_id_artifact_id_artifacts_organization_id_id_fk" FOREIGN KEY ("organization_id","artifact_id") REFERENCES "work"."artifacts"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."artifact_verifications" ADD CONSTRAINT "artifact_verifications_organization_id_work_unit_id_work_units_organization_id_id_fk" FOREIGN KEY ("organization_id","work_unit_id") REFERENCES "work"."work_units"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."artifact_verifications" ADD CONSTRAINT "artifact_verifications_organization_id_decided_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","decided_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."artifact_verifications" ADD CONSTRAINT "artifact_verifications_organization_id_package_id_evidence_packages_organization_id_id_fk" FOREIGN KEY ("organization_id","package_id") REFERENCES "knowledge"."evidence_packages"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."chunks" ADD CONSTRAINT "chunks_organization_id_document_id_source_id_documents_organization_id_id_source_id_fk" FOREIGN KEY ("organization_id","document_id","source_id") REFERENCES "knowledge"."documents"("organization_id","id","source_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."document_staging" ADD CONSTRAINT "document_staging_organization_id_document_id_documents_organization_id_id_fk" FOREIGN KEY ("organization_id","document_id") REFERENCES "knowledge"."documents"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."documents" ADD CONSTRAINT "documents_organization_id_source_id_sources_organization_id_id_fk" FOREIGN KEY ("organization_id","source_id") REFERENCES "knowledge"."sources"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."documents" ADD CONSTRAINT "documents_organization_id_created_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","created_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."edges" ADD CONSTRAINT "edges_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."edges" ADD CONSTRAINT "edges_organization_id_fact_id_facts_organization_id_id_fk" FOREIGN KEY ("organization_id","fact_id") REFERENCES "knowledge"."facts"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."edges" ADD CONSTRAINT "edges_organization_id_created_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","created_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."embedding_spaces" ADD CONSTRAINT "embedding_spaces_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."embeddings" ADD CONSTRAINT "embeddings_organization_id_chunk_id_source_id_chunks_organization_id_id_source_id_fk" FOREIGN KEY ("organization_id","chunk_id","source_id") REFERENCES "knowledge"."chunks"("organization_id","id","source_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."embeddings" ADD CONSTRAINT "embeddings_organization_id_space_id_dimension_embedding_spaces_organization_id_id_dimension_fk" FOREIGN KEY ("organization_id","space_id","dimension") REFERENCES "knowledge"."embedding_spaces"("organization_id","id","dimension") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."evidence_items" ADD CONSTRAINT "evidence_items_organization_id_package_id_evidence_packages_organization_id_id_fk" FOREIGN KEY ("organization_id","package_id") REFERENCES "knowledge"."evidence_packages"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."evidence_packages" ADD CONSTRAINT "evidence_packages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."evidence_packages" ADD CONSTRAINT "evidence_packages_organization_id_viewer_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","viewer_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."evidence_packages" ADD CONSTRAINT "evidence_packages_organization_id_work_unit_id_work_units_organization_id_id_fk" FOREIGN KEY ("organization_id","work_unit_id") REFERENCES "work"."work_units"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."fact_evidence" ADD CONSTRAINT "fact_evidence_organization_id_fact_id_facts_organization_id_id_fk" FOREIGN KEY ("organization_id","fact_id") REFERENCES "knowledge"."facts"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."fact_evidence" ADD CONSTRAINT "fact_evidence_organization_id_chunk_id_source_id_chunks_organization_id_id_source_id_fk" FOREIGN KEY ("organization_id","chunk_id","source_id") REFERENCES "knowledge"."chunks"("organization_id","id","source_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."facts" ADD CONSTRAINT "facts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."facts" ADD CONSTRAINT "facts_organization_id_proposed_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","proposed_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."facts" ADD CONSTRAINT "facts_organization_id_reviewed_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","reviewed_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."facts" ADD CONSTRAINT "facts_organization_id_superseded_by_id_facts_organization_id_id_fk" FOREIGN KEY ("organization_id","superseded_by_id") REFERENCES "knowledge"."facts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."model_calls" ADD CONSTRAINT "model_calls_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."purge_jobs" ADD CONSTRAINT "purge_jobs_organization_id_source_id_sources_organization_id_id_fk" FOREIGN KEY ("organization_id","source_id") REFERENCES "knowledge"."sources"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."source_grants" ADD CONSTRAINT "source_grants_organization_id_source_id_sources_organization_id_id_fk" FOREIGN KEY ("organization_id","source_id") REFERENCES "knowledge"."sources"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."source_grants" ADD CONSTRAINT "source_grants_organization_id_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."source_grants" ADD CONSTRAINT "source_grants_organization_id_team_id_teams_organization_id_id_fk" FOREIGN KEY ("organization_id","team_id") REFERENCES "org"."teams"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."source_grants" ADD CONSTRAINT "source_grants_organization_id_granted_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","granted_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."sources" ADD CONSTRAINT "sources_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."sources" ADD CONSTRAINT "sources_organization_id_connection_id_connections_organization_id_id_fk" FOREIGN KEY ("organization_id","connection_id") REFERENCES "integrations"."connections"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."sources" ADD CONSTRAINT "sources_organization_id_external_resource_id_external_resources_organization_id_id_fk" FOREIGN KEY ("organization_id","external_resource_id") REFERENCES "integrations"."external_resources"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."sources" ADD CONSTRAINT "sources_organization_id_owner_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","owner_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations"."mcp_tools" ADD CONSTRAINT "mcp_tools_organization_id_connection_id_connections_organization_id_id_fk" FOREIGN KEY ("organization_id","connection_id") REFERENCES "integrations"."connections"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations"."mcp_tools" ADD CONSTRAINT "mcp_tools_organization_id_reviewed_by_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","reviewed_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_answer_sources_source_idx" ON "knowledge"."answer_sources" USING btree ("organization_id","source_id");--> statement-breakpoint
CREATE INDEX "knowledge_answers_requester_idx" ON "knowledge"."answers" USING btree ("organization_id","requester_membership_id","created_at");--> statement-breakpoint
CREATE INDEX "knowledge_artifact_citations_source_idx" ON "knowledge"."artifact_citations" USING btree ("organization_id","source_id");--> statement-breakpoint
CREATE INDEX "knowledge_artifact_verifications_artifact_idx" ON "knowledge"."artifact_verifications" USING btree ("organization_id","artifact_id","created_at");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_lexemes_idx" ON "knowledge"."chunks" USING gin ("lexemes");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_source_idx" ON "knowledge"."chunks" USING btree ("organization_id","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_documents_one_current" ON "knowledge"."documents" USING btree ("organization_id","source_id") WHERE "knowledge"."documents"."superseded_at" is null and "knowledge"."documents"."state" <> 'purged';--> statement-breakpoint
CREATE INDEX "knowledge_documents_state_idx" ON "knowledge"."documents" USING btree ("organization_id","state","updated_at");--> statement-breakpoint
CREATE INDEX "knowledge_edges_from_idx" ON "knowledge"."edges" USING btree ("organization_id","from_type","from_id");--> statement-breakpoint
CREATE INDEX "knowledge_edges_to_idx" ON "knowledge"."edges" USING btree ("organization_id","to_type","to_id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_embedding_spaces_one_active" ON "knowledge"."embedding_spaces" USING btree ("organization_id") WHERE "knowledge"."embedding_spaces"."state" = 'active';--> statement-breakpoint
CREATE INDEX "knowledge_embeddings_space_source_idx" ON "knowledge"."embeddings" USING btree ("organization_id","space_id","source_id");--> statement-breakpoint
CREATE INDEX "knowledge_evidence_items_source_idx" ON "knowledge"."evidence_items" USING btree ("organization_id","source_id");--> statement-breakpoint
CREATE INDEX "knowledge_fact_evidence_source_idx" ON "knowledge"."fact_evidence" USING btree ("organization_id","source_id");--> statement-breakpoint
CREATE INDEX "knowledge_fact_evidence_chunk_idx" ON "knowledge"."fact_evidence" USING btree ("organization_id","chunk_id");--> statement-breakpoint
CREATE INDEX "knowledge_facts_subject_idx" ON "knowledge"."facts" USING btree ("organization_id","subject_ref","trust_state");--> statement-breakpoint
CREATE INDEX "knowledge_model_calls_time_idx" ON "knowledge"."model_calls" USING btree ("organization_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "knowledge_purge_jobs_state_idx" ON "knowledge"."purge_jobs" USING btree ("organization_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_source_grants_member" ON "knowledge"."source_grants" USING btree ("organization_id","source_id","membership_id") WHERE "knowledge"."source_grants"."membership_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_source_grants_team" ON "knowledge"."source_grants" USING btree ("organization_id","source_id","team_id") WHERE "knowledge"."source_grants"."team_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_source_grants_organization" ON "knowledge"."source_grants" USING btree ("organization_id","source_id") WHERE "knowledge"."source_grants"."principal_kind" = 'organization';--> statement-breakpoint
CREATE INDEX "knowledge_source_grants_member_idx" ON "knowledge"."source_grants" USING btree ("organization_id","membership_id");--> statement-breakpoint
CREATE INDEX "knowledge_source_grants_team_idx" ON "knowledge"."source_grants" USING btree ("organization_id","team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_sources_one_live_per_resource" ON "knowledge"."sources" USING btree ("organization_id","external_resource_id") WHERE "knowledge"."sources"."state" = 'active' and "knowledge"."sources"."external_resource_id" is not null;--> statement-breakpoint
CREATE INDEX "knowledge_sources_state_idx" ON "knowledge"."sources" USING btree ("organization_id","state");