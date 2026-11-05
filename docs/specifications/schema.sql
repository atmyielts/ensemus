-- Ensemus reference PostgreSQL DDL v2.0 — 2026-11-05
-- Design reference, NOT a complete, reviewed production migration.
-- PostgreSQL 16+ recommended for planning; verify current production target.
-- Requires pgcrypto for gen_random_uuid on older releases and pgvector for vectors.
-- DO NOT run this unreviewed on production. Recreate as reviewed Drizzle migrations + SQL RLS/triggers, then test before production.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE SCHEMA IF NOT EXISTS identity;
CREATE SCHEMA IF NOT EXISTS org;
CREATE SCHEMA IF NOT EXISTS work;
CREATE SCHEMA IF NOT EXISTS ai;
CREATE SCHEMA IF NOT EXISTS knowledge;
CREATE SCHEMA IF NOT EXISTS integrations;
CREATE SCHEMA IF NOT EXISTS governance;
CREATE SCHEMA IF NOT EXISTS platform;

CREATE TABLE org.organizations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    commercial_mode text NOT NULL CHECK (commercial_mode IN ('cloud','byom','sovereign')),
    lifecycle text NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active','suspended','deleted')),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE identity.users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    oidc_subject text NOT NULL UNIQUE,
    email text,
    display_name text,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE org.memberships (
    organization_id uuid NOT NULL REFERENCES org.organizations(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES identity.users(id),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','disabled')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id,id),
    UNIQUE (organization_id,user_id)
);
CREATE TABLE org.teams (
    organization_id uuid NOT NULL REFERENCES org.organizations(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    parent_id uuid,
    name text NOT NULL,
    PRIMARY KEY (organization_id,id),
    FOREIGN KEY (organization_id,parent_id) REFERENCES org.teams(organization_id,id)
);
CREATE TABLE org.team_memberships (
    organization_id uuid NOT NULL,
    team_id uuid NOT NULL,
    membership_id uuid NOT NULL,
    PRIMARY KEY (organization_id,team_id,membership_id),
    FOREIGN KEY (organization_id,team_id) REFERENCES org.teams(organization_id,id),
    FOREIGN KEY (organization_id,membership_id) REFERENCES org.memberships(organization_id,id)
);
CREATE TABLE org.service_identities (
    organization_id uuid NOT NULL REFERENCES org.organizations(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    name text NOT NULL,
    owner_membership_id uuid NOT NULL,
    disabled_at timestamptz,
    expires_at timestamptz,
    PRIMARY KEY (organization_id,id),
    FOREIGN KEY (organization_id,owner_membership_id) REFERENCES org.memberships(organization_id,id)
);

CREATE TABLE work.clients (
    organization_id uuid NOT NULL REFERENCES org.organizations(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    display_name text NOT NULL,
    classification text NOT NULL DEFAULT 'internal'
        CHECK (classification IN ('public','internal','confidential','restricted')),
    PRIMARY KEY (organization_id,id)
);
CREATE TABLE work.projects (
    organization_id uuid NOT NULL REFERENCES org.organizations(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    client_id uuid,
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id,id),
    FOREIGN KEY (organization_id,client_id) REFERENCES work.clients(organization_id,id)
);
CREATE TABLE work.work_units (
    organization_id uuid NOT NULL REFERENCES org.organizations(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    project_id uuid,
    parent_id uuid,
    owner_membership_id uuid,
    title text NOT NULL,
    objective text,
    status text NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued','ready','running','blocked','awaiting_approval','verifying','completed','failed','cancelled')),
    completion_criteria jsonb NOT NULL DEFAULT '{}'::jsonb,
    classification text NOT NULL DEFAULT 'internal'
        CHECK (classification IN ('public','internal','confidential','restricted')),
    due_at timestamptz,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id,id),
    FOREIGN KEY (organization_id,project_id) REFERENCES work.projects(organization_id,id),
    FOREIGN KEY (organization_id,parent_id) REFERENCES work.work_units(organization_id,id),
    FOREIGN KEY (organization_id,owner_membership_id) REFERENCES org.memberships(organization_id,id)
);
CREATE INDEX work_units_status_idx ON work.work_units(organization_id,status,due_at);
CREATE TABLE work.work_dependencies (
    organization_id uuid NOT NULL,
    prerequisite_id uuid NOT NULL,
    dependent_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id,prerequisite_id,dependent_id),
    CHECK (prerequisite_id <> dependent_id),
    FOREIGN KEY (organization_id,prerequisite_id) REFERENCES work.work_units(organization_id,id),
    FOREIGN KEY (organization_id,dependent_id) REFERENCES work.work_units(organization_id,id)
);
CREATE INDEX work_dep_reverse_idx ON work.work_dependencies(organization_id,dependent_id);

-- Prevent inserting an edge (A -> B) when path (B -> A) already exists.
-- Advisory lock serializes edge insertions PER tenant, eliminating concurrent cycles.
-- Edge updates should be performed as delete+insert under authorization and transaction.
CREATE OR REPLACE FUNCTION work.prevent_dependency_cycle() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE has_cycle boolean;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text, 0));
    WITH RECURSIVE reachable(node_id, visited) AS (
        SELECT NEW.dependent_id, ARRAY[NEW.dependent_id]
        UNION ALL
        SELECT d.dependent_id, reachable.visited || d.dependent_id
        FROM reachable
        JOIN work.work_dependencies d
          ON d.organization_id = NEW.organization_id AND d.prerequisite_id = reachable.node_id
        WHERE NOT d.dependent_id = ANY(reachable.visited)
    )
    SELECT EXISTS(SELECT 1 FROM reachable WHERE node_id = NEW.prerequisite_id)
    INTO has_cycle;
    IF has_cycle THEN
        RAISE EXCEPTION 'INVALID_DEPENDENCY_CYCLE';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER check_work_dependency_cycle
    BEFORE INSERT ON work.work_dependencies
    FOR EACH ROW EXECUTE FUNCTION work.prevent_dependency_cycle();

CREATE TABLE work.artifacts (
    organization_id uuid NOT NULL REFERENCES org.organizations(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    object_key text NOT NULL,
    sha256 text NOT NULL,
    mime_type text NOT NULL,
    classification text NOT NULL CHECK (classification IN ('public','internal','confidential','restricted')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id,id)
);
CREATE TABLE work.work_artifacts (
    organization_id uuid NOT NULL,
    work_unit_id uuid NOT NULL,
    artifact_id uuid NOT NULL,
    PRIMARY KEY (organization_id,work_unit_id,artifact_id),
    FOREIGN KEY (organization_id,work_unit_id) REFERENCES work.work_units(organization_id,id),
    FOREIGN KEY (organization_id,artifact_id) REFERENCES work.artifacts(organization_id,id)
);
CREATE TABLE work.approvals (
    organization_id uuid NOT NULL REFERENCES org.organizations(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    work_unit_id uuid NOT NULL,
    tool_name text NOT NULL,
    action_hash text NOT NULL,
    target_account_ref text,
    approver_membership_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','approved','denied','expired','cancelled')),
    expires_at timestamptz NOT NULL,
    decided_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id,id),
    FOREIGN KEY (organization_id,work_unit_id) REFERENCES work.work_units(organization_id,id),
    FOREIGN KEY (organization_id,approver_membership_id) REFERENCES org.memberships(organization_id,id)
);

CREATE TABLE ai.agent_definitions (
    organization_id uuid NOT NULL REFERENCES org.organizations(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    name text NOT NULL,
    owner_membership_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id,id),
    FOREIGN KEY (organization_id,owner_membership_id) REFERENCES org.memberships(organization_id,id)
);
CREATE TABLE ai.agent_versions (
    organization_id uuid NOT NULL,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    agent_definition_id uuid NOT NULL,
    version_number integer NOT NULL CHECK (version_number > 0),
    spec jsonb NOT NULL,
    spec_sha256 text NOT NULL,
    published_at timestamptz,
    PRIMARY KEY (organization_id,id),
    UNIQUE (organization_id,agent_definition_id,version_number),
    FOREIGN KEY (organization_id,agent_definition_id) REFERENCES ai.agent_definitions(organization_id,id)
);
CREATE TABLE ai.agent_runs (
    organization_id uuid NOT NULL REFERENCES org.organizations(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    work_unit_id uuid NOT NULL,
    agent_version_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued','preparing','running','awaiting_approval','waiting_external','verifying','completed','failed','cancelled','budget_exhausted','policy_denied')),
    budget_usd numeric(14,6) NOT NULL CHECK (budget_usd >= 0),
    spent_usd numeric(14,6) NOT NULL DEFAULT 0 CHECK (spent_usd >= 0),
    temporal_workflow_id text,
    started_at timestamptz,
    finished_at timestamptz,
    PRIMARY KEY (organization_id,id),
    FOREIGN KEY (organization_id,work_unit_id) REFERENCES work.work_units(organization_id,id),
    FOREIGN KEY (organization_id,agent_version_id) REFERENCES ai.agent_versions(organization_id,id)
);
CREATE TABLE ai.execution_steps (
    organization_id uuid NOT NULL,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    agent_run_id uuid NOT NULL,
    step_number integer NOT NULL CHECK (step_number >= 0),
    kind text NOT NULL,
    state text NOT NULL,
    safe_summary text,
    diagnostic_ref text,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id,id),
    UNIQUE (organization_id,agent_run_id,step_number),
    FOREIGN KEY (organization_id,agent_run_id) REFERENCES ai.agent_runs(organization_id,id)
);
CREATE TABLE ai.model_profiles (
    organization_id uuid NOT NULL REFERENCES org.organizations(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    provider_name text NOT NULL,
    model_id text NOT NULL,
    endpoint_alias text NOT NULL,
    secret_ref text,
    allowed_classes text[] NOT NULL DEFAULT ARRAY['public','internal']::text[],
    allowed_region text,
    active boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id,id)
);

CREATE TABLE integrations.connections (
    organization_id uuid NOT NULL REFERENCES org.organizations(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    connector_type text NOT NULL,
    secret_ref text NOT NULL,
    scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
    status text NOT NULL DEFAULT 'pending',
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id,id)
);
CREATE TABLE integrations.external_actions (
    organization_id uuid NOT NULL REFERENCES org.organizations(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    connection_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    request_sha256 text NOT NULL,
    approval_id uuid,
    external_receipt text,
    status text NOT NULL CHECK (status IN ('planned','in_flight','succeeded','failed','unknown_external_state')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id,id),
    UNIQUE (organization_id,idempotency_key),
    FOREIGN KEY (organization_id,connection_id) REFERENCES integrations.connections(organization_id,id),
    FOREIGN KEY (organization_id,approval_id) REFERENCES work.approvals(organization_id,id)
);

CREATE TABLE knowledge.sources (
    organization_id uuid NOT NULL REFERENCES org.organizations(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    connection_id uuid,
    external_resource_id text,
    classification text NOT NULL CHECK (classification IN ('public','internal','confidential','restricted')),
    acl_revision bigint NOT NULL DEFAULT 1,
    revoked_at timestamptz,
    PRIMARY KEY (organization_id,id),
    FOREIGN KEY (organization_id,connection_id) REFERENCES integrations.connections(organization_id,id)
);
CREATE TABLE knowledge.documents (
    organization_id uuid NOT NULL,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    source_id uuid NOT NULL,
    source_version text,
    content_sha256 text NOT NULL,
    object_key text,
    searchable_at timestamptz,
    deleted_at timestamptz,
    PRIMARY KEY (organization_id,id),
    FOREIGN KEY (organization_id,source_id) REFERENCES knowledge.sources(organization_id,id)
);
CREATE TABLE knowledge.chunks (
    organization_id uuid NOT NULL,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    document_id uuid NOT NULL,
    ordinal integer NOT NULL CHECK (ordinal >= 0),
    text_body text NOT NULL,
    lexeme_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', text_body)) STORED,
    PRIMARY KEY (organization_id,id),
    UNIQUE (organization_id,document_id,ordinal),
    FOREIGN KEY (organization_id,document_id) REFERENCES knowledge.documents(organization_id,id)
);
CREATE INDEX chunks_lexeme_idx ON knowledge.chunks USING gin(lexeme_vector);
CREATE TABLE knowledge.embeddings (
    organization_id uuid NOT NULL,
    chunk_id uuid NOT NULL,
    embedding_model_version text NOT NULL,
    embedding vector NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id,chunk_id,embedding_model_version),
    FOREIGN KEY (organization_id,chunk_id) REFERENCES knowledge.chunks(organization_id,id)
);
-- A shared HNSW index is intentionally NOT added here: vector dimensionality
-- varies by provider/version, and tenant filtering can degrade approximate recall.
-- Make partial/expression indexes per embedding model or partition after benchmarks.
CREATE TABLE knowledge.memory_facts (
    organization_id uuid NOT NULL REFERENCES org.organizations(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    subject_ref text NOT NULL,
    predicate text NOT NULL,
    claim jsonb NOT NULL,
    trust_state text NOT NULL CHECK (trust_state IN ('proposed','verified','disputed','superseded')),
    source_document_id uuid,
    valid_from timestamptz,
    valid_until timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id,id),
    FOREIGN KEY (organization_id,source_document_id) REFERENCES knowledge.documents(organization_id,id)
);

CREATE TABLE platform.domain_events (
    organization_id uuid NOT NULL REFERENCES org.organizations(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    event_type text NOT NULL,
    schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
    aggregate_type text NOT NULL,
    aggregate_id uuid NOT NULL,
    aggregate_version bigint NOT NULL,
    actor_type text NOT NULL,
    actor_id uuid,
    classification text NOT NULL CHECK (classification IN ('public','internal','confidential','restricted')),
    payload jsonb NOT NULL,
    correlation_id uuid,
    causation_id uuid,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id,id)
);
CREATE INDEX domain_events_aggregate_idx ON platform.domain_events(organization_id,aggregate_type,aggregate_id,aggregate_version);
CREATE TABLE platform.outbox_events (
    organization_id uuid NOT NULL,
    event_id uuid NOT NULL,
    state text NOT NULL DEFAULT 'queued',
    attempts integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id,event_id),
    FOREIGN KEY (organization_id,event_id) REFERENCES platform.domain_events(organization_id,id)
);
CREATE TABLE platform.inbox_events (
    organization_id uuid NOT NULL REFERENCES org.organizations(id),
    consumer_id text NOT NULL,
    event_id uuid NOT NULL,
    processed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id,consumer_id,event_id)
);
CREATE TABLE governance.audit_events (
    organization_id uuid NOT NULL REFERENCES org.organizations(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    actor_type text NOT NULL,
    actor_id uuid,
    action text NOT NULL,
    target_ref text NOT NULL,
    decision text NOT NULL,
    safe_reason text,
    correlation_id uuid,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id,id)
);
CREATE TABLE platform.entitlements (
    organization_id uuid NOT NULL REFERENCES org.organizations(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    mode text NOT NULL CHECK (mode IN ('cloud','byom','sovereign')),
    entitlements jsonb NOT NULL,
    valid_from timestamptz NOT NULL,
    valid_until timestamptz,
    license_signature text,
    PRIMARY KEY (organization_id,id)
);
CREATE TABLE platform.usage_ledger (
    organization_id uuid NOT NULL REFERENCES org.organizations(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    idempotency_key text NOT NULL,
    meter text NOT NULL,
    quantity numeric(20,6) NOT NULL CHECK (quantity >= 0),
    unit text NOT NULL,
    cost_usd numeric(20,6),
    agent_run_id uuid,
    recorded_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id,id),
    UNIQUE (organization_id,idempotency_key),
    FOREIGN KEY (organization_id,agent_run_id) REFERENCES ai.agent_runs(organization_id,id)
);

-- Application RLS pattern. Only a trusted backend should set a validated
-- app.organization_id inside a transaction. Do NOT connect as table owner,
-- superuser, or with BYPASSRLS for regular app operations.
DO $$
DECLARE r record;
BEGIN
    FOR r IN
      SELECT table_schema, table_name
      FROM information_schema.columns
      WHERE table_schema IN ('org','work','ai','knowledge','integrations','governance','platform')
        AND column_name='organization_id'
      GROUP BY table_schema,table_name
    LOOP
      EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',r.table_schema,r.table_name);
      EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY',r.table_schema,r.table_name);
      EXECUTE format(
        'CREATE POLICY tenant_scoped ON %I.%I USING (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid) WITH CHECK (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid)',
         r.table_schema,r.table_name);
    END LOOP;
END $$;

-- Additional production-required work intentionally NOT provided here:
--  1. least-privilege GRANT/REVOKE application roles and RLS for global users/org access
--     (designed in ADR-024 D4; org.organizations and identity.users are not covered by the loop above)
--  2. per-resource ACL grants and agent-delegation tables/constraints
--  3. audit append integrity and retention partitioning
--  4. schema evolution, migrations, conflict handling, deletion/retention triggers
--  5. tenant-scoped embedding index construction, key encryption, partition strategy
--  6. additional check constraints, reference tables, model/task evaluations
--  7. cycle-safe org.team hierarchy constraint and large-graph cycle performance tests
