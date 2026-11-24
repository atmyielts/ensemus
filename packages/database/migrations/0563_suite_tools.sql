-- FLAGGED FOR HUMAN SECURITY REVIEW
-- REVIEWED SECURITY SQL (ADR-024 D4, ADR-027 D5, ADR-028 FD-4, ADR-038 D5, D6). Changes here need human
-- review, never agent approval. Not yet reviewed by a person. Error codes: EN125 a suite read that moves
-- or is written in a way ADR-038 D6 does not allow, EN126 a suite setting changed by anyone but a person
-- with connection.manage, EN121 (0561's) a member's consent for a capability the organization does not
-- allow members.

-- One suite read an agent asked for (ADR-038 D6, "D6 in detail"). Credentials live only in the connector
-- worker, and prompts and answers only in `ai.step_payloads`, which only the agent role reaches. So a
-- read crosses roles here, by IDs on Temporal and bytes in this row: the agent role writes the request,
-- the connector worker reads the arguments, does the read and writes the output, and the agent role moves
-- the output into the step's transcript and clears it from here.
CREATE TABLE "integrations"."suite_reads" (
	"organization_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"step_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"tool_id" text NOT NULL,
	"tool_version" text NOT NULL,
	"args" jsonb NOT NULL,
	"resource_external_id" text,
	"status" text DEFAULT 'requested' NOT NULL,
	"result_code" text,
	"output" bytea,
	"output_media_type" text,
	"output_classification" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suite_reads_organization_id_proposal_id_pk" PRIMARY KEY("organization_id","proposal_id"),
	CONSTRAINT "suite_reads_status_check" CHECK ("integrations"."suite_reads"."status" in ('requested','read','refused','collected')),
	CONSTRAINT "suite_reads_result_format" CHECK ("integrations"."suite_reads"."result_code" IS NULL OR "integrations"."suite_reads"."result_code" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
	CONSTRAINT "suite_reads_output_size" CHECK ("integrations"."suite_reads"."output" IS NULL OR octet_length("integrations"."suite_reads"."output") <= 1048576),
	CONSTRAINT "suite_reads_output_class" CHECK ("integrations"."suite_reads"."output_classification" IS NULL OR "integrations"."suite_reads"."output_classification" in ('public','internal','confidential','restricted')),
	CONSTRAINT "suite_reads_output_only_when_read" CHECK (("integrations"."suite_reads"."output" IS NOT NULL) = ("integrations"."suite_reads"."status" = 'read')),
	CONSTRAINT "suite_reads_tool_format" CHECK ("integrations"."suite_reads"."tool_id" ~ '^[a-z][a-z0-9_.]{1,63}$')
);
--> statement-breakpoint
ALTER TABLE "integrations"."suite_reads" ADD CONSTRAINT "suite_reads_organization_id_connection_id_connections_organization_id_id_fk" FOREIGN KEY ("organization_id","connection_id") REFERENCES "integrations"."connections"("organization_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "suite_reads_run_idx" ON "integrations"."suite_reads" USING btree ("organization_id","run_id");
--> statement-breakpoint

-- Which capabilities a member may connect with their own account (ADR-038 D5). No row means the default,
-- mail and calendar. Only capabilities a member can own are allowed at all.
CREATE TABLE "integrations"."suite_settings" (
	"organization_id" uuid NOT NULL,
	"member_capabilities" text[] DEFAULT '{mail,calendar}'::text[] NOT NULL,
	"updated_by_membership_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suite_settings_organization_id_pk" PRIMARY KEY("organization_id"),
	CONSTRAINT "suite_settings_member_capabilities" CHECK ("integrations"."suite_settings"."member_capabilities" <@ ARRAY['mail','calendar','documents','chat']::text[])
);
--> statement-breakpoint
ALTER TABLE "integrations"."suite_settings" ADD CONSTRAINT "suite_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "integrations"."suite_settings" ADD CONSTRAINT "suite_settings_updated_by_fk" FOREIGN KEY ("organization_id","updated_by_membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

-- Forced RLS and the tenant policy, as on every other integrations table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['suite_reads','suite_settings'] LOOP
    EXECUTE format('ALTER TABLE integrations.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE integrations.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_scoped ON integrations.%I TO ensemus_app '
      'USING (organization_id = app.current_organization_id()) '
      'WITH CHECK (organization_id = app.current_organization_id())',
      t);
  END LOOP;
END $$;
--> statement-breakpoint

-- The arguments are a model's words and the output is provider content, so neither reaches the web tier,
-- which shares ensemus_app. Only the agent role, and the connector worker's service context, see a row.
CREATE POLICY suite_reads_actor ON integrations.suite_reads AS RESTRICTIVE TO ensemus_app
  USING (current_user = 'ensemus_agent' OR knowledge.is_service_actor())
  WITH CHECK (current_user = 'ensemus_agent' OR knowledge.is_service_actor());
--> statement-breakpoint

-- The connector worker reads everything but the output, and writes only the result. The agent role alone
-- writes a request and reads the output back. Nobody deletes a row but the tenant eraser.
GRANT SELECT (organization_id, proposal_id, run_id, step_id, connection_id, tool_id, tool_version, args,
              resource_external_id, status, result_code, output_media_type, output_classification,
              created_at, updated_at)
  ON integrations.suite_reads TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (status, result_code, output, output_media_type, output_classification, updated_at)
  ON integrations.suite_reads TO ensemus_app;
--> statement-breakpoint
GRANT INSERT ON integrations.suite_reads TO ensemus_agent;
--> statement-breakpoint
GRANT SELECT (output) ON integrations.suite_reads TO ensemus_agent;
--> statement-breakpoint

-- What may happen to a suite read. A request is born by the agent role, for a proposal of that run and
-- tool that the gateway has just moved to running. Only the connector worker's service context answers
-- it, once. Only the agent role collects the answer, and collecting clears the output. Nothing about what
-- was asked ever changes.
CREATE FUNCTION integrations.check_suite_read() RETURNS trigger
  LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  service boolean;
  agent boolean;
BEGIN
  IF TG_RELID<>'integrations.suite_reads'::regclass OR TG_OP NOT IN ('INSERT','UPDATE') THEN
    RAISE EXCEPTION 'SUITE_READ_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
  service := current_user='ensemus_app' AND knowledge.is_service_actor();
  agent := current_user='ensemus_agent' AND app.current_actor_type()='agent';
  IF TG_OP='INSERT' THEN
    IF NOT agent OR NEW.status<>'requested' OR NEW.result_code IS NOT NULL OR NEW.output IS NOT NULL
      OR NEW.output_media_type IS NOT NULL OR NEW.output_classification IS NOT NULL
      OR NEW.organization_id IS DISTINCT FROM app.current_organization_id()
      OR NOT EXISTS (
        SELECT 1 FROM ai.tool_proposals p
         WHERE p.organization_id=NEW.organization_id AND p.id=NEW.proposal_id AND p.run_id=NEW.run_id
           AND p.tool_id=NEW.tool_id AND p.tool_version=NEW.tool_version AND p.status='running'
           AND p.external_action_id IS NULL)
      OR NOT EXISTS (
        SELECT 1 FROM ai.execution_steps e
         WHERE e.organization_id=NEW.organization_id AND e.id=NEW.step_id AND e.run_id=NEW.run_id) THEN
      RAISE EXCEPTION 'SUITE_READ_INVALID_START' USING ERRCODE='EN125';END IF;
    NEW.created_at:=now();
    NEW.updated_at:=now();
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)-ARRAY['status','result_code','output','output_media_type','output_classification','updated_at'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','result_code','output','output_media_type','output_classification','updated_at']) THEN
    RAISE EXCEPTION 'SUITE_READ_IMMUTABLE' USING ERRCODE='EN125';END IF;
  IF NEW.status=OLD.status THEN
    IF (to_jsonb(NEW)-ARRAY['updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['updated_at']) THEN
      RAISE EXCEPTION 'SUITE_READ_INVALID_CHANGE' USING ERRCODE='EN125';END IF;
    RETURN NEW;
  END IF;
  IF NOT (
    (OLD.status='requested' AND NEW.status='read' AND service AND NEW.result_code IS NULL
      AND NEW.output IS NOT NULL AND NEW.output_media_type IS NOT NULL AND NEW.output_classification IS NOT NULL)
    OR (OLD.status='requested' AND NEW.status='refused' AND (service OR agent) AND NEW.result_code IS NOT NULL
      AND NEW.output IS NULL AND NEW.output_media_type IS NULL AND NEW.output_classification IS NULL)
    OR (OLD.status IN ('read','refused') AND NEW.status='collected' AND agent AND NEW.output IS NULL)
  ) THEN
    RAISE EXCEPTION 'SUITE_READ_INVALID_CHANGE' USING ERRCODE='EN125';END IF;
  NEW.updated_at:=now();
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION integrations.check_suite_read() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER suite_reads_check
  BEFORE INSERT OR UPDATE ON integrations.suite_reads
  FOR EACH ROW EXECUTE FUNCTION integrations.check_suite_read();
--> statement-breakpoint

-- An admin decides what members may connect for themselves. An agent decides nothing here.
GRANT SELECT, INSERT ON integrations.suite_settings TO ensemus_app;
--> statement-breakpoint
GRANT UPDATE (member_capabilities, updated_by_membership_id, updated_at)
  ON integrations.suite_settings TO ensemus_app;
--> statement-breakpoint
CREATE FUNCTION integrations.check_suite_settings() RETURNS trigger
  LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_RELID<>'integrations.suite_settings'::regclass OR TG_OP NOT IN ('INSERT','UPDATE') THEN
    RAISE EXCEPTION 'SUITE_SETTINGS_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
  IF current_user NOT IN ('ensemus_app','ensemus_agent') THEN RETURN NEW;END IF;
  IF current_user='ensemus_agent' OR app.current_actor_type() IS DISTINCT FROM 'user'
    OR NEW.organization_id IS DISTINCT FROM app.current_organization_id()
    OR NEW.updated_by_membership_id IS DISTINCT FROM app.current_membership_id() THEN
    RAISE EXCEPTION 'SUITE_SETTINGS_INVALID_CHANGE' USING ERRCODE='EN126';END IF;
  IF NOT app.interactive_privilege_allowed('connection.manage') THEN
    RAISE EXCEPTION 'MFA_REQUIRED' USING ERRCODE='EN405';END IF;
  NEW.updated_at:=now();
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION integrations.check_suite_settings() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER suite_settings_check
  BEFORE INSERT OR UPDATE ON integrations.suite_settings
  FOR EACH ROW EXECUTE FUNCTION integrations.check_suite_settings();
--> statement-breakpoint

-- 0561's consent start, with one addition: a member's own consent may ask only for capabilities the
-- organization allows members (no settings row means mail and calendar), and only ones a member can own.
-- Everything else is 0561's text unchanged.
CREATE OR REPLACE FUNCTION integrations.check_new_oauth_authorization() RETURNS trigger
  LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE allowed text[];
BEGIN
  IF TG_RELID<>'integrations.oauth_authorizations'::regclass OR TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'OAUTH_GUARD_TARGET_INVALID' USING ERRCODE='42501';END IF;
  IF current_user='ensemus_agent' THEN
    RAISE EXCEPTION 'OAUTH_AUTHORIZATION_INVALID_START' USING ERRCODE='EN121';END IF;
  IF NEW.status<>'pending' OR NEW.code_secret_id IS NOT NULL OR NEW.connection_id IS NOT NULL
    OR NEW.error_code IS NOT NULL THEN
    RAISE EXCEPTION 'OAUTH_AUTHORIZATION_INVALID_START' USING ERRCODE='EN121';END IF;
  NEW.created_at:=now();
  NEW.updated_at:=now();
  NEW.expires_at:=now()+interval '10 minutes';
  IF current_user='ensemus_app' THEN
    IF app.current_actor_type() IS DISTINCT FROM 'user'
      OR NEW.organization_id IS DISTINCT FROM app.current_organization_id()
      OR NEW.started_by_membership_id IS DISTINCT FROM app.current_membership_id() THEN
      RAISE EXCEPTION 'OAUTH_AUTHORIZATION_INVALID_START' USING ERRCODE='EN121';END IF;
    IF NEW.owner_membership_id IS NULL AND NOT app.interactive_privilege_allowed('connection.manage') THEN
      RAISE EXCEPTION 'MFA_REQUIRED' USING ERRCODE='EN405';END IF;
    IF NEW.owner_membership_id IS NOT NULL THEN
      SELECT s.member_capabilities INTO allowed FROM integrations.suite_settings s
       WHERE s.organization_id=NEW.organization_id;
      IF NOT FOUND THEN allowed:=ARRAY['mail','calendar']::text[];END IF;
      IF cardinality(NEW.requested_capabilities)=0
        OR NOT (NEW.requested_capabilities <@ allowed)
        OR NOT (NEW.requested_capabilities <@ ARRAY['mail','calendar','documents','chat']::text[]) THEN
        RAISE EXCEPTION 'OAUTH_AUTHORIZATION_INVALID_START' USING ERRCODE='EN121';END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION integrations.check_new_oauth_authorization() FROM PUBLIC;
--> statement-breakpoint

-- Tenant content, so the eraser reaches both tables, the counts-only erasure projection knows them, and
-- restore admission covers that reach, exactly as 0561 did for its two.
SELECT lifecycle.extend_eraser_reach();
--> statement-breakpoint
DO $$
DECLARE
  definition text;
  header constant text := 'CREATE OR REPLACE FUNCTION lifecycle.install_erasure_count_projection(';
  anchor constant text := '''integrations.oauth_authorizations'',';
  widened constant text := '''integrations.oauth_authorizations'',''integrations.suite_reads'',''integrations.suite_settings'',';
BEGIN
  definition := pg_get_functiondef('lifecycle.install_erasure_count_projection()'::regprocedure);
  IF strpos(definition, header)<>1
    OR (length(definition)-length(replace(definition, anchor, '')))/length(anchor)<>1
    OR strpos(definition, '''integrations.suite_reads''')<>0
    OR strpos(definition, '''integrations.suite_settings''')<>0 THEN
    RAISE EXCEPTION 'ERASURE_INVENTORY_DEFINITION_CHANGED' USING ERRCODE='EN850';END IF;
  EXECUTE replace(definition, anchor, widened);
END $$;
--> statement-breakpoint
SELECT lifecycle.install_erasure_count_projection();
--> statement-breakpoint
SELECT identity.extend_auth_restore_admission();
