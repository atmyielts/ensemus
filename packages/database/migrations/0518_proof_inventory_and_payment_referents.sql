-- 0518: reviewed composition of 0417/0419/0515 authority metadata and native 0512 payment evidence.
-- Apply after those sources, 0517 and the actual guarded0516 raw lifecycle, before the final
-- reviewed0999 installer. Other future contributing relations require explicit reviewed union.
-- No registered 0508 SQL is changed. No row, historical UUID/hash, native admission, financial FK,
-- private body/credential grant, or lifecycle retained-table rule changes here.
--
-- A financial witness references an actual referent AT NATIVE ADMISSION, not its permanent body.
-- 0512's fixed functions lock live tenant-bound admission/consume referents through COMMIT.
-- A later signed callback copies its original API credential ID/config from the immutable native
-- binding as historical attribution; it cannot use that ID for new API transport. Its live delivery,
-- endpoint/signing-secret/connection and deferred atomic-receipt guards remain mandatory.
-- Immutable-identity and native admission guards
-- remain mandatory. Removed live rows cannot authorize a later request from these historical IDs.
-- This lets erasure remove connection/config/webhook body/secret ciphertext without destroying
-- the original financial proof. An anchor duplicating the same retained UUIDs adds no authority.
--
-- Exact historical-body FKs removed (16): identity connection/secret; execution connection/secret;
-- webhook event delivery/endpoint/connection/api_secret; webhook binding endpoint/connection/
-- credential/signing; webhook attestation delivery/endpoint/connection/signing. All financial,
-- organization and inbox FKs remain, as do every native function, private grant and keep trigger.
DO $review$
DECLARE expected record;private_table text;runtime_role text;
BEGIN
  IF current_user<>'ensemus_migrator' THEN
    RAISE EXCEPTION 'PAYMENT_REFERENT_REVIEW_REQUIRED' USING ERRCODE='42501';END IF;
  FOR expected IN SELECT * FROM(VALUES
    ('billing.payment_identity_attestations','payment_identity_connection','integrations.connections'),
    ('billing.payment_identity_attestations','payment_identity_secret','secrets.sealed_secrets'),
    ('billing.payment_execution_bindings','payment_execution_connection','integrations.connections'),
    ('billing.payment_execution_bindings','payment_execution_secret','secrets.sealed_secrets'),
    ('billing.payment_webhook_events','payment_webhook_delivery','integrations.webhook_deliveries'),
    ('billing.payment_webhook_events','payment_webhook_endpoint','integrations.webhook_endpoints'),
    ('billing.payment_webhook_events','payment_webhook_connection','integrations.connections'),
    ('billing.payment_webhook_events','payment_webhook_api_secret','secrets.sealed_secrets'),
    ('billing.payment_webhook_bindings','payment_webhook_binding_endpoint','integrations.webhook_endpoints'),
    ('billing.payment_webhook_bindings','payment_webhook_binding_connection','integrations.connections'),
    ('billing.payment_webhook_bindings','payment_webhook_binding_credential','secrets.sealed_secrets'),
    ('billing.payment_webhook_bindings','payment_webhook_binding_signing','secrets.sealed_secrets'),
    ('billing.payment_webhook_attestations','payment_webhook_attestation_delivery','integrations.webhook_deliveries'),
    ('billing.payment_webhook_attestations','payment_webhook_attestation_endpoint','integrations.webhook_endpoints'),
    ('billing.payment_webhook_attestations','payment_webhook_attestation_connection','integrations.connections'),
    ('billing.payment_webhook_attestations','payment_webhook_attestation_signing','secrets.sealed_secrets')
  ) AS reviewed(table_ref,constraint_name,target_ref) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_constraint actual WHERE actual.conname=expected.constraint_name
      AND actual.contype='f' AND actual.conrelid=to_regclass(expected.table_ref)
      AND actual.confrelid=to_regclass(expected.target_ref)) THEN
      RAISE EXCEPTION 'PAYMENT_REFERENT_SCHEMA_UNREVIEWED' USING ERRCODE='EN850';END IF;
  END LOOP;
  -- Four private proof relations are writable only inside fixed native functions. Removing their
  -- lifetime FKs must never turn a direct runtime INSERT/identity rewrite into birth authority.
  FOREACH private_table IN ARRAY ARRAY['billing.payment_identity_attestations','billing.payment_execution_bindings',
    'billing.payment_webhook_bindings','billing.payment_webhook_attestations'] LOOP
    FOREACH runtime_role IN ARRAY ARRAY['ensemus_app','ensemus_agent','ensemus_secrets','ensemus_eraser'] LOOP
      IF has_table_privilege(runtime_role::name,to_regclass(private_table),'INSERT') OR has_table_privilege(runtime_role::name,to_regclass(private_table),'UPDATE')
        OR has_any_column_privilege(runtime_role::name,to_regclass(private_table),'INSERT') OR has_any_column_privilege(runtime_role::name,to_regclass(private_table),'UPDATE') THEN
        RAISE EXCEPTION 'PAYMENT_REFERENT_ADMISSION_UNREVIEWED' USING ERRCODE='EN850';END IF;
    END LOOP;
  END LOOP;
  FOR expected IN SELECT * FROM(VALUES
    ('billing.payment_identity_attestations','payment_identity_change','billing.keep_payment_identity()'),
    ('billing.payment_execution_bindings','payment_execution_change','billing.keep_payment_execution()'),
    ('billing.payment_webhook_events','payment_webhook_identity','billing.guard_payment_webhook_identity()'),
    ('billing.payment_webhook_events','payment_webhook_verified','billing.guard_payment_webhook_verification()'),
    ('billing.payment_webhook_events','payment_webhook_delivery_committed','billing.payment_webhook_delivery_committed()'),
    ('billing.payment_webhook_attestations','payment_webhook_attestation_change','billing.guard_webhook_attestation_change()'),
    ('billing.payment_webhook_attestations','payment_webhook_atomic_receipt','billing.require_payment_webhook_atomic_receipt()')
  ) AS reviewed(table_ref,trigger_name,function_ref) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_trigger actual WHERE actual.tgrelid=to_regclass(expected.table_ref)
      AND actual.tgname=expected.trigger_name AND actual.tgfoid=to_regprocedure(expected.function_ref)
      AND actual.tgenabled IN('O','A') AND NOT actual.tgisinternal) THEN
      RAISE EXCEPTION 'PAYMENT_REFERENT_ADMISSION_UNREVIEWED' USING ERRCODE='EN850';END IF;
  END LOOP;
  -- The raw lifecycle exception is allowed only with its actual native row guards and independent
  -- sealed physical/writer proof. An absent raw table/helper or schema-wide retention fallback
  -- must refuse this composition rather than hide raw debt from the final eraser count.
  FOR expected IN SELECT * FROM(VALUES
    ('lifecycle.raw_source_inventories','raw_inventory_erasure'),
    ('lifecycle.raw_object_writes','raw_writes_erasure')
  ) AS reviewed(table_ref,trigger_name) LOOP
    IF lifecycle.retained_table('lifecycle',split_part(expected.table_ref,'.',2)) IS DISTINCT FROM false
      OR NOT EXISTS(SELECT 1 FROM pg_class actual WHERE actual.oid=to_regclass(expected.table_ref)
        AND actual.relrowsecurity AND actual.relforcerowsecurity)
      OR NOT EXISTS(SELECT 1 FROM pg_trigger actual WHERE actual.tgrelid=to_regclass(expected.table_ref)
        AND actual.tgname=expected.trigger_name AND actual.tgenabled IN('O','A') AND NOT actual.tgisinternal
        AND actual.tgfoid=to_regprocedure('lifecycle.require_raw_inventory_erasure()')) THEN
      RAISE EXCEPTION 'RAW_ERASURE_COMPOSITION_REQUIRED' USING ERRCODE='EN850';END IF;
  END LOOP;
  IF to_regprocedure('lifecycle.raw_erasure_witness()') IS NULL
    OR NOT EXISTS(SELECT 1 FROM pg_trigger actual WHERE actual.tgrelid='lifecycle.delegated_erasure_receipts'::regclass
      AND actual.tgname='delegated_erasure_raw_birth' AND actual.tgenabled IN('O','A') AND NOT actual.tgisinternal
      AND actual.tgfoid=to_regprocedure('lifecycle.bind_raw_erasure_witness()')) THEN
    RAISE EXCEPTION 'RAW_ERASURE_COMPOSITION_REQUIRED' USING ERRCODE='EN850';END IF;
END $review$;
--> statement-breakpoint
ALTER TABLE billing.payment_identity_attestations DROP CONSTRAINT payment_identity_connection;
ALTER TABLE billing.payment_identity_attestations DROP CONSTRAINT payment_identity_secret;
ALTER TABLE billing.payment_execution_bindings DROP CONSTRAINT payment_execution_connection;
ALTER TABLE billing.payment_execution_bindings DROP CONSTRAINT payment_execution_secret;
ALTER TABLE billing.payment_webhook_events DROP CONSTRAINT payment_webhook_delivery;
ALTER TABLE billing.payment_webhook_events DROP CONSTRAINT payment_webhook_endpoint;
ALTER TABLE billing.payment_webhook_events DROP CONSTRAINT payment_webhook_connection;
ALTER TABLE billing.payment_webhook_events DROP CONSTRAINT payment_webhook_api_secret;
ALTER TABLE billing.payment_webhook_bindings DROP CONSTRAINT payment_webhook_binding_endpoint;
ALTER TABLE billing.payment_webhook_bindings DROP CONSTRAINT payment_webhook_binding_connection;
ALTER TABLE billing.payment_webhook_bindings DROP CONSTRAINT payment_webhook_binding_credential;
ALTER TABLE billing.payment_webhook_bindings DROP CONSTRAINT payment_webhook_binding_signing;
ALTER TABLE billing.payment_webhook_attestations DROP CONSTRAINT payment_webhook_attestation_delivery;
ALTER TABLE billing.payment_webhook_attestations DROP CONSTRAINT payment_webhook_attestation_endpoint;
ALTER TABLE billing.payment_webhook_attestations DROP CONSTRAINT payment_webhook_attestation_connection;
ALTER TABLE billing.payment_webhook_attestations DROP CONSTRAINT payment_webhook_attestation_signing;
--> statement-breakpoint
-- Closed metadata-only projection. Preserve the0508 function body, adding ten material proof tables,
-- two raw-proof targets and two existing0418 process-proof targets. This does not bypass ANY DELETE
-- guard: material requires0515's seal, raw requires0516's native guarded exception, and nonempty
-- process witnesses still refuse DELETE until their separate proof/cleanup review is composed.
-- Retained financial/lifecycle evidence is not granted DELETE or silently counted as erased.
-- Unknown future tenant tables still refuse; the final 0999 call must occur after all schema sources.
CREATE OR REPLACE FUNCTION lifecycle.install_erasure_count_projection() RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $installer$
DECLARE t record;branches text:='';body text;ref text;
BEGIN
 IF current_user<>'ensemus_migrator' THEN RAISE EXCEPTION 'ERASURE_METADATA_INSTALLER_REQUIRED' USING ERRCODE='42501';END IF;
 FOR t IN SELECT n.nspname AS schema_name,c.relname AS table_name,c.oid,c.relrowsecurity,c.relforcerowsecurity
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
  AND a.attname='organization_id' AND NOT a.attisdropped WHERE c.relkind IN('r','p') AND NOT c.relispartition
  AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
  AND NOT lifecycle.retained_table(n.nspname::text,c.relname::text) ORDER BY n.nspname,c.relname LOOP
  ref:=t.schema_name||'.'||t.table_name;
  IF ref<>ALL(ARRAY[
   'ai.delegated_input_receipts',
   'ai.delegated_input_refs',
   'ai.delegated_work_births',
   'ai.record_purge_jobs',
   'ai.record_run_closures',
   'ai.run_authority_checkpoints',
   'ai.run_read_authorities',
   'ai.source_run_closures',
   'knowledge.artifact_authority_receipts',
   'knowledge.artifact_authority_refs',
   'lifecycle.raw_source_inventories',
   'lifecycle.raw_object_writes',
   'studio.process_run_intents',
   'studio.process_step_births',
   'ai.agent_definitions',
   'ai.agent_publications',
   'ai.agent_runs',
   'ai.agent_versions',
   'ai.artifact_evidence',
   'ai.execution_steps',
   'ai.main_input_snapshots',
   'ai.model_call_attempts',
   'ai.model_call_inputs',
   'ai.model_evaluations',
   'ai.model_job_payloads',
   'ai.model_jobs',
   'ai.model_operation_qualifications',
   'ai.model_profiles',
   'ai.model_proposal_inputs',
   'ai.model_workload_approvals',
   'ai.model_workload_profiles',
   'ai.rate_cards',
   'ai.run_controls',
   'ai.run_input_checkpoints',
   'ai.run_input_observations',
   'ai.run_output_writes',
   'ai.step_payloads',
   'ai.tool_proposals',
   'ai.unproven_child_work_inputs',
   'billing.billing_accounts',
   'billing.billing_periods',
   'billing.collection_cases',
   'billing.collection_policies',
   'billing.credit_accounts',
   'billing.credit_ledger',
   'billing.invoice_lines',
   'billing.invoices',
   'billing.operator_actions',
   'billing.payment_attempts',
   'billing.payment_events',
   'billing.payment_webhook_events',
   'billing.payments',
   'billing.plan_versions',
   'billing.plans',
   'billing.provider_bills',
   'billing.rate_card_lines',
   'billing.rate_cards',
   'billing.standing_changes',
   'billing.subscription_changes',
   'billing.subscriptions',
   'billing.tax_treatments',
   'billing.top_up_offers',
   'billing.top_ups',
   'experience.onboarding_completions',
   'experience.onboarding_steps',
   'experience.outcome_drafts',
   'experience.outcome_work_births',
   'experience.pulse_signal_states',
   'governance.audit_events',
   'governance.egress_decisions',
   'governance.kill_switches',
   'governance.policy_bundles',
   'identity.accounts',
   'identity.rate_limits',
   'identity.session_assurances',
   'identity.sessions',
   'identity.setup_tokens',
   'identity.sso_providers',
   'identity.two_factors',
   'identity.users',
   'identity.verifications',
   'integrations.connections',
   'integrations.external_action_attempts',
   'integrations.external_action_receipts',
   'integrations.external_actions',
   'integrations.external_resource_acl',
   'integrations.external_resources',
   'integrations.mcp_tools',
   'integrations.sync_cursors',
   'integrations.webhook_deliveries',
   'integrations.webhook_endpoints',
   'knowledge.answer_citations',
   'knowledge.answer_sources',
   'knowledge.answers',
   'knowledge.artifact_acl_catalog',
   'knowledge.artifact_citations',
   'knowledge.artifact_lineage',
   'knowledge.artifact_lineage_inputs',
   'knowledge.artifact_lineage_packages',
   'knowledge.artifact_lineage_records',
   'knowledge.artifact_lineage_sources',
   'knowledge.artifact_verifications',
   'knowledge.artifact_work_links',
   'knowledge.chunks',
   'knowledge.document_staging',
   'knowledge.documents',
   'knowledge.edges',
   'knowledge.embedding_spaces',
   'knowledge.embeddings',
   'knowledge.evidence_items',
   'knowledge.evidence_package_facts',
   'knowledge.evidence_packages',
   'knowledge.fact_evidence',
   'knowledge.facts',
   'knowledge.model_calls',
   'knowledge.object_writers',
   'knowledge.purge_jobs',
   'knowledge.source_grants',
   'knowledge.sources',
   'knowledge.structured_record_catalog',
   'knowledge.structured_work_assignments',
   'lifecycle.erasure_log',
   'lifecycle.legal_hold_scopes',
   'lifecycle.legal_holds',
   'lifecycle.object_deletion_claims',
   'lifecycle.offboarding_admissions',
   'lifecycle.offboardings',
   'lifecycle.retention_cursors',
   'lifecycle.retention_rules',
   'lifecycle.retention_runs',
   'objects.migration_results',
   'objects.migrations',
   'objects.record_values',
   'objects.records',
   'objects.relation_slots',
   'objects.relations',
   'objects.type_acl_catalog',
   'objects.type_versions',
   'objects.types',
   'operations.drills',
   'operations.incident_updates',
   'operations.incidents',
   'operations.vulnerability_reports',
   'org.invitations',
   'org.memberships',
   'org.organizations',
   'org.scim_tokens',
   'org.security_policies',
   'org.service_identities',
   'org.sso_connections',
   'org.sso_member_links',
   'org.team_memberships',
   'org.teams',
   'packs.capability_reviews',
   'packs.installations',
   'packs.installed_items',
   'platform.blob_lifecycle',
   'platform.budget_reservations',
   'platform.budgets',
   'platform.domain_events',
   'platform.entitlements',
   'platform.idempotency_keys',
   'platform.inbox_events',
   'platform.notifications',
   'platform.outbox_events',
   'platform.tombstones',
   'platform.usage_ledger',
   'secrets.sealed_secrets',
   'sovereign.export_epochs',
   'sovereign.imported_archive_files',
   'sovereign.imported_definitions',
   'sovereign.imported_people',
   'sovereign.imported_records',
   'sovereign.license_records',
   'sovereign.organization_export_parts',
   'sovereign.organization_exports',
   'sovereign.organization_import_effects',
   'sovereign.organization_import_manifests',
   'sovereign.organization_import_parts',
   'sovereign.organization_imports',
   'sovereign.signed_documents',
   'studio.agent_drafts',
   'studio.process_drafts',
   'studio.process_run_steps',
   'studio.process_runs',
   'studio.process_specs',
   'studio.publish_reviews',
   'studio.simulation_inputs',
   'studio.simulation_runs',
   'support.break_glass_log',
   'support.break_glass_requests',
   'support.coverage_schedules',
   'support.ticket_messages',
   'support.tickets',
   'work.agent_assignments',
   'work.approval_decisions',
   'work.approvals',
   'work.artifacts',
   'work.client_onboardings',
   'work.client_readers',
   'work.clients',
   'work.projects',
   'work.work_artifacts',
   'work.work_assignments',
   'work.work_dependencies',
   'work.work_transitions',
   'work.work_units'
  ]) OR NOT t.relrowsecurity OR NOT t.relforcerowsecurity
   OR NOT has_table_privilege('ensemus_eraser',t.oid,'DELETE') THEN
   RAISE EXCEPTION 'ERASURE_METADATA_INVENTORY_UNREVIEWED' USING ERRCODE='EN850';END IF;
  EXECUTE format('GRANT SELECT(organization_id) ON %I.%I TO ensemus_migrator',t.schema_name,t.table_name);
  IF NOT EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=t.oid AND p.polname='erasure_count_metadata') THEN
   EXECUTE format('CREATE POLICY erasure_count_metadata ON %I.%I FOR SELECT TO ensemus_migrator USING(organization_id=app.current_organization_id() AND organization_id::text=current_setting(''lifecycle.erasure_count_org'',true))',t.schema_name,t.table_name);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger g WHERE g.tgrelid=t.oid AND g.tgname='lifecycle_erasure_birth_fence' AND NOT g.tgisinternal) THEN
   EXECUTE format('CREATE TRIGGER lifecycle_erasure_birth_fence BEFORE INSERT ON %I.%I FOR EACH ROW EXECUTE FUNCTION lifecycle.refuse_erasing_birth()',t.schema_name,t.table_name);
  END IF;
  branches:=branches||format(' WHEN %L THEN SELECT count(*) INTO answer FROM %I.%I WHERE organization_id=tenant;',ref,t.schema_name,t.table_name);
 END LOOP;
 body:=$body$
 DECLARE tenant uuid:=app.current_organization_id();previous_scope text;answer bigint;
 BEGIN
  IF session_user<>'ensemus_app' OR NOT knowledge.is_service_actor() OR tenant IS NULL
   OR NOT lifecycle.admitted_offboarding(p_intent) THEN RAISE EXCEPTION 'ERASURE_METADATA_INTENT_REQUIRED' USING ERRCODE='EN850';END IF;
  previous_scope:=current_setting('lifecycle.erasure_count_org',true);
  PERFORM set_config('lifecycle.erasure_count_org',tenant::text,true);
  BEGIN
   CASE p_table $body$||branches||$body$
    ELSE RAISE EXCEPTION 'ERASURE_METADATA_INVENTORY_UNREVIEWED' USING ERRCODE='EN850';END CASE;
  EXCEPTION WHEN OTHERS THEN PERFORM set_config('lifecycle.erasure_count_org',coalesce(previous_scope,''),true);RAISE;END;
  PERFORM set_config('lifecycle.erasure_count_org',coalesce(previous_scope,''),true);
  IF answer<0 OR answer>9007199254740991 THEN RAISE EXCEPTION 'ERASURE_COUNT_INVALID' USING ERRCODE='EN850';END IF;
  RETURN answer;
 END $body$;
 EXECUTE 'CREATE OR REPLACE FUNCTION lifecycle.erasure_table_rows(p_table text,p_intent uuid) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS '||quote_literal(body);
 REVOKE ALL ON FUNCTION lifecycle.erasure_table_rows(text,uuid) FROM PUBLIC;
 GRANT EXECUTE ON FUNCTION lifecycle.erasure_table_rows(text,uuid) TO ensemus_app;
END $installer$;
REVOKE ALL ON FUNCTION lifecycle.install_erasure_count_projection() FROM PUBLIC;
