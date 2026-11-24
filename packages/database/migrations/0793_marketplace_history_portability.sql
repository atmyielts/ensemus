-- FLAGGED FOR HUMAN SECURITY REVIEW
-- COMM-05 and EXP-06. Archive publisher and buyer history under their own source authority.
ALTER TABLE sovereign.organization_exports
  DROP CONSTRAINT organization_exports_inventory_version_check,
  ADD CONSTRAINT organization_exports_inventory_version_check CHECK (
    inventory_version IS NULL OR inventory_version IN (
      'ensemus.m3-m7/3','ensemus.m3-m7-federation/4','ensemus.skill-metadata/5',
      'ensemus.marketplace-publisher/6','ensemus.meeting-config/7','ensemus.meeting-history/8',
      'ensemus.business-records/9','ensemus.skill-upload-cleanup/10','ensemus.residency/11',
      'ensemus.skill-bundles/12','ensemus.sandbox-history/13','ensemus.marketplace-history/14'
    )
  );
--> statement-breakpoint
CREATE VIEW sovereign.marketplace_installation_export_proofs WITH (security_barrier = true) AS
  SELECT i.organization_id,i.id,i.listing_id,i.requested_by_membership_id,i.state,i.failure_code,
    i.package_id,i.skill_version_id,p.name AS package_name,v.semver,i.created_at,i.updated_at,i.removed_at
  FROM marketplace.installations i
  LEFT JOIN skills.packages p ON p.organization_id=i.organization_id AND p.id=i.package_id
  LEFT JOIN skills.package_versions v ON v.organization_id=p.organization_id
    AND v.package_id=p.id AND v.id=i.skill_version_id
  LEFT JOIN skills.bundle_uploads r ON r.organization_id=i.organization_id AND r.id=i.id
  WHERE i.organization_id=app.current_organization_id()
    AND (
      (i.state IN ('failed','removed') AND lifecycle.marketplace_buyer_copy_settled(i,false))
      OR (i.state='installed' AND i.package_id=i.id AND i.skill_version_id=i.id
        AND p.origin='marketplace' AND p.listing_id=i.listing_id
        AND v.state IN ('verified','published','yanked')
        AND r.marketplace_copy AND r.membership_id=i.requested_by_membership_id
        AND lifecycle.skill_write_is_current(r) AND lifecycle.skill_version_matches_upload(r,v)
        AND r.copy_material_generation=r.put_material_generation
        AND r.copy_auth_generation=r.put_auth_generation
        AND NOT EXISTS(SELECT 1 FROM lifecycle.object_deletion_claims c WHERE c.organization_id=i.organization_id
          AND c.kind='skill_upload' AND c.artifact_id=i.id))
    );
REVOKE ALL ON sovereign.marketplace_installation_export_proofs FROM PUBLIC,ensemus_app,ensemus_worker;
--> statement-breakpoint
DO $migration$
DECLARE
  definition text:=pg_get_functiondef('sovereign.portable_profile_clear(text)'::regprocedure);
  old_tail constant text:='''ensemus.sandbox-history/13'')';
  new_tail constant text:='''ensemus.sandbox-history/13'',''ensemus.marketplace-history/14'')';
  sandbox_gate constant text:='p_profile<>''ensemus.sandbox-history/13''';
  catalog_gate constant text:='OR origin<>''tenant'' OR content_classification=''restricted''))';
  buyer_probe constant text:='EXISTS(SELECT 1 FROM marketplace.installations installation WHERE organization_id=tenant';
  buyer_tail constant text:='WHERE receipt.organization_id=tenant AND receipt.id=installation.id)))';
  version_tail constant text:='WHERE p.organization_id=v.organization_id AND p.id=v.id)))';
  test_tail constant text:='WHERE p.organization_id=t.organization_id AND p.id=t.skill_version_id)))';
  upload_tail constant text:='WHERE p.organization_id=r.organization_id AND p.id=r.id))))';
  probe text;
BEGIN
  IF strpos(definition,old_tail)=0 OR strpos(definition,sandbox_gate)=0 OR strpos(definition,catalog_gate)=0
    OR strpos(definition,buyer_probe)=0 OR strpos(definition,buyer_tail)=0 OR strpos(definition,version_tail)=0
    OR strpos(definition,test_tail)=0 OR strpos(definition,upload_tail)=0 THEN
    RAISE EXCEPTION 'PORTABLE_MARKETPLACE_HISTORY_PROFILE_CHANGED' USING ERRCODE='EN301';
  END IF;
  definition:=replace(definition,old_tail,new_tail);
  definition:=replace(definition,sandbox_gate,'p_profile NOT IN('||new_tail);
  FOREACH probe IN ARRAY ARRAY[
    'EXISTS(SELECT 1 FROM marketplace.listings WHERE publisher_organization_id=tenant)',
    'EXISTS(SELECT 1 FROM marketplace.security_reviews WHERE submission_organization_id=tenant)',
    'EXISTS(SELECT 1 FROM marketplace.submissions WHERE organization_id=tenant)'
  ] LOOP
    IF strpos(definition,probe)=0 THEN RAISE EXCEPTION 'PORTABLE_MARKETPLACE_PROBE_CHANGED' USING ERRCODE='EN301'; END IF;
    definition:=replace(definition,probe,'(p_profile<>''ensemus.marketplace-history/14'' AND '||probe||')');
  END LOOP;
  definition:=replace(definition,catalog_gate,$sql$
      OR content_classification='restricted' OR (origin<>'tenant' AND (p_profile<>'ensemus.marketplace-history/14' OR NOT EXISTS(
        SELECT 1 FROM sovereign.marketplace_installation_export_proofs m
        WHERE m.organization_id=tenant AND m.package_id=packages.id)))))
  $sql$);
  definition:=replace(definition,buyer_probe,'(p_profile<>''ensemus.marketplace-history/14'' AND '||buyer_probe);
  definition:=replace(definition,buyer_tail,buyer_tail||$sql$
    ) OR (p_profile='ensemus.marketplace-history/14' AND EXISTS(
      SELECT 1 FROM marketplace.installations i WHERE i.organization_id=tenant
        AND NOT EXISTS(SELECT 1 FROM sovereign.marketplace_installation_export_proofs m
          WHERE m.organization_id=i.organization_id AND m.id=i.id)))
  $sql$);
  definition:=replace(definition,version_tail,$sql$
        WHERE p.organization_id=v.organization_id AND p.id=v.id)
        AND (p_profile<>'ensemus.marketplace-history/14' OR NOT EXISTS(
          SELECT 1 FROM sovereign.marketplace_installation_export_proofs m
          WHERE m.organization_id=v.organization_id AND m.skill_version_id=v.id))))
  $sql$);
  definition:=replace(definition,test_tail,$sql$
        WHERE p.organization_id=t.organization_id AND p.id=t.skill_version_id)
        AND (p_profile<>'ensemus.marketplace-history/14' OR NOT EXISTS(
          SELECT 1 FROM sovereign.marketplace_installation_export_proofs m
          WHERE m.organization_id=t.organization_id AND m.skill_version_id=t.skill_version_id))))
  $sql$);
  definition:=replace(definition,upload_tail,$sql$
        WHERE p.organization_id=r.organization_id AND p.id=r.id)
        AND (p_profile<>'ensemus.marketplace-history/14' OR NOT EXISTS(
          SELECT 1 FROM sovereign.marketplace_installation_export_proofs m
          WHERE m.organization_id=r.organization_id AND m.id=r.id)))))
  $sql$);
  EXECUTE definition;

  definition:=pg_get_functiondef('sovereign.guard_export_inventory_pin()'::regprocedure);
  IF strpos(definition,old_tail)=0 THEN RAISE EXCEPTION 'PORTABLE_MARKETPLACE_PIN_CHANGED' USING ERRCODE='EN301'; END IF;
  EXECUTE replace(definition,old_tail,new_tail);

  definition:=pg_get_functiondef('sovereign.portable_export_viewer()'::regprocedure);
  IF strpos(definition,old_tail)=0 THEN RAISE EXCEPTION 'PORTABLE_MARKETPLACE_VIEW_CHANGED' USING ERRCODE='EN301'; END IF;
  EXECUTE replace(definition,old_tail,new_tail);

  definition:=pg_get_functiondef('sovereign.portable_business_page(text,uuid,integer)'::regprocedure);
  IF strpos(definition,old_tail)=0 THEN RAISE EXCEPTION 'PORTABLE_MARKETPLACE_BUSINESS_CHANGED' USING ERRCODE='EN301'; END IF;
  EXECUTE replace(definition,old_tail,new_tail);

  definition:=pg_get_functiondef('sovereign.portable_skill_upload_cleanup_page(uuid,integer)'::regprocedure);
  IF strpos(definition,old_tail)=0 THEN RAISE EXCEPTION 'PORTABLE_MARKETPLACE_CLEANUP_CHANGED' USING ERRCODE='EN301'; END IF;
  EXECUTE replace(definition,old_tail,new_tail);

  definition:=pg_get_functiondef('sovereign.register_import_part(uuid,text,bytea)'::regprocedure);
  IF strpos(definition,old_tail)=0 THEN RAISE EXCEPTION 'PORTABLE_MARKETPLACE_IMPORT_CHANGED' USING ERRCODE='EN409'; END IF;
  EXECUTE replace(definition,old_tail,new_tail);
END $migration$;
--> statement-breakpoint
CREATE OR REPLACE VIEW sovereign.portable_residency_requirements WITH (security_barrier = true) AS
  SELECT r.organization_id,r.scope,r.region,r.version,r.set_by_membership_id,r.created_at,r.updated_at
  FROM tenancy.residency_requirements r
  WHERE r.organization_id=app.current_organization_id()
    AND session_user='ensemus_worker' AND knowledge.is_service_actor()
    AND sovereign.portable_export_viewer() IS NOT NULL
    AND EXISTS(SELECT 1 FROM sovereign.organization_exports e
      WHERE e.organization_id=r.organization_id AND e.id::text=current_setting('app.portability_export_id',true)
        AND e.inventory_version IN ('ensemus.residency/11','ensemus.skill-bundles/12','ensemus.sandbox-history/13','ensemus.marketplace-history/14')
        AND e.status='running');
--> statement-breakpoint
CREATE OR REPLACE VIEW sovereign.skill_bundle_export_scope WITH (security_barrier = true) AS
  SELECT e.organization_id,e.snapshot_at,e.inventory_version FROM sovereign.organization_exports e
  WHERE e.organization_id=app.current_organization_id() AND e.id::text=current_setting('app.portability_export_id',true)
    AND e.inventory_version IN ('ensemus.skill-bundles/12','ensemus.sandbox-history/13','ensemus.marketplace-history/14') AND e.status='running'
    AND session_user='ensemus_worker' AND knowledge.is_service_actor()
    AND sovereign.portable_export_viewer() IS NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE VIEW sovereign.portable_sandbox_run_receipts WITH (security_barrier = true) AS
  SELECT r.organization_id,r.id,r.skill_version_id,r.purpose,r.status,r.attempts,r.created_at,r.finished_at
  FROM sandbox.runs r JOIN sovereign.skill_bundle_export_scope s ON s.organization_id=r.organization_id
  WHERE s.inventory_version IN ('ensemus.sandbox-history/13','ensemus.marketplace-history/14') AND r.finished_at<=s.snapshot_at
    AND r.status NOT IN ('queued','running')
    AND ((r.purpose='operator_test' AND r.requested_by_membership_id=sovereign.portable_export_viewer())
      OR (r.purpose='skill_test' AND r.fixture_signer_key_id IS NOT NULL));
CREATE OR REPLACE FUNCTION sovereign.portable_sandbox_run_count() RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $function$
  SELECT (SELECT count(*)::integer FROM sandbox.runs r
    WHERE r.organization_id=s.organization_id AND r.finished_at<=s.snapshot_at)
  FROM sovereign.skill_bundle_export_scope s WHERE s.inventory_version IN ('ensemus.sandbox-history/13','ensemus.marketplace-history/14')
$function$;
--> statement-breakpoint
-- Projection of publisher-visible fields. Deployment review identity and proof material are private.
CREATE VIEW sovereign.portable_marketplace_submissions WITH (security_barrier = true) AS
  SELECT m.organization_id,m.id,m.publisher_id,m.package_id,m.skill_version_id,m.name,m.semver,m.state,
    m.created_at,m.decided_at,m.delist_requested_at
  FROM marketplace.submissions m JOIN sovereign.skill_bundle_export_scope s ON s.organization_id=m.organization_id
  WHERE s.inventory_version='ensemus.marketplace-history/14' AND m.created_at<=s.snapshot_at;
CREATE VIEW sovereign.portable_marketplace_listings WITH (security_barrier = true) AS
  SELECT m.publisher_organization_id AS organization_id,m.id,m.publisher_id,m.submission_id,m.review_id,
    m.display_name,m.summary,m.semver,m.state,m.delist_mode,m.delist_code,m.listed_at,m.delisted_at
  FROM marketplace.listings m JOIN sovereign.skill_bundle_export_scope s ON s.organization_id=m.publisher_organization_id
  WHERE s.inventory_version='ensemus.marketplace-history/14' AND m.listed_at<=s.snapshot_at;
CREATE VIEW sovereign.portable_marketplace_reviews WITH (security_barrier = true) AS
  SELECT m.submission_organization_id AS organization_id,m.id,m.submission_id,m.verdict,m.finding_codes,m.decided_at,m.recorded_at
  FROM marketplace.security_reviews m JOIN sovereign.skill_bundle_export_scope s ON s.organization_id=m.submission_organization_id
  WHERE s.inventory_version='ensemus.marketplace-history/14' AND m.recorded_at<=s.snapshot_at;
REVOKE ALL ON sovereign.portable_marketplace_submissions,sovereign.portable_marketplace_listings,
  sovereign.portable_marketplace_reviews FROM PUBLIC,ensemus_app;
GRANT SELECT ON sovereign.portable_marketplace_submissions,sovereign.portable_marketplace_listings,
  sovereign.portable_marketplace_reviews TO ensemus_worker;
--> statement-breakpoint
CREATE FUNCTION sovereign.portable_marketplace_installation_page(p_after uuid,p_limit integer)
RETURNS TABLE (key uuid,record jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $function$
  SELECT p.id,jsonb_build_object('kind','marketplace_installation_history','id',p.id,
    'listing_id',p.listing_id,'requested_by_membership_id',p.requested_by_membership_id,
    'state',p.state,'failure_code',p.failure_code,'package_id',p.package_id,'skill_version_id',p.skill_version_id,
    'package_name',p.package_name,'semver',p.semver,
    'created_at',to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'updated_at',to_char(p.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'removed_at',to_char(p.removed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
  FROM sovereign.marketplace_installation_export_proofs p
  JOIN sovereign.skill_bundle_export_scope s ON s.organization_id=p.organization_id
  WHERE s.inventory_version='ensemus.marketplace-history/14' AND p.created_at<=s.snapshot_at
    AND p_limit BETWEEN 1 AND 200 AND (p_after IS NULL OR p.id>p_after)
  ORDER BY p.id LIMIT CASE WHEN p_limit BETWEEN 1 AND 200 THEN p_limit ELSE 0 END
$function$;
REVOKE ALL ON FUNCTION sovereign.portable_marketplace_installation_page(uuid,integer) FROM PUBLIC,ensemus_app;
GRANT EXECUTE ON FUNCTION sovereign.portable_marketplace_installation_page(uuid,integer) TO ensemus_worker;
--> statement-breakpoint
DO $migration$
DECLARE
  definition text:=pg_get_functiondef('sovereign.portable_skill_bundle_page(text,uuid,integer)'::regprocedure);
  anchor constant text:='FROM skills.test_runs t JOIN sovereign.skill_bundle_export_proofs p
      ON p.organization_id=t.organization_id AND p.id=t.skill_version_id
    WHERE t.organization_id=tenant';
  kind_check text;
  kind_anchor constant text:='allowed:=string_to_array(CASE NEW.record_kind';
BEGIN
  IF strpos(definition,anchor)=0 THEN RAISE EXCEPTION 'PORTABLE_MARKETPLACE_TEST_PAGE_CHANGED' USING ERRCODE='EN301'; END IF;
  EXECUTE replace(definition,anchor,$sql$
    FROM skills.test_runs t
    WHERE t.organization_id=tenant AND (
      EXISTS(SELECT 1 FROM sovereign.skill_bundle_export_proofs p WHERE p.organization_id=t.organization_id AND p.id=t.skill_version_id)
      OR EXISTS(SELECT 1 FROM sovereign.marketplace_installation_export_proofs p
        JOIN sovereign.skill_bundle_export_scope s ON s.organization_id=p.organization_id
        WHERE s.inventory_version='ensemus.marketplace-history/14' AND p.organization_id=t.organization_id AND p.skill_version_id=t.skill_version_id))
  $sql$);
  SELECT pg_get_expr(conbin,conrelid) INTO STRICT kind_check FROM pg_constraint
    WHERE conrelid='sovereign.imported_definitions'::regclass AND conname='imported_definitions_record_kind_check';
  ALTER TABLE sovereign.imported_definitions DROP CONSTRAINT imported_definitions_record_kind_check;
  EXECUTE 'ALTER TABLE sovereign.imported_definitions ADD CONSTRAINT imported_definitions_record_kind_check '
    ||'CHECK (('||kind_check||') OR (section=''skills'' AND record_kind IN ('
    ||'''marketplace_submission_history'',''marketplace_listing_history'',''marketplace_review_history'',''marketplace_installation_history'')))';
  definition:=pg_get_functiondef('sovereign.guard_portable_definition()'::regprocedure);
  IF strpos(definition,kind_anchor)=0 THEN RAISE EXCEPTION 'PORTABLE_MARKETPLACE_QUARANTINE_CHANGED' USING ERRCODE='EN301'; END IF;
  EXECUTE replace(definition,kind_anchor,kind_anchor||$sql$
    WHEN 'marketplace_submission_history' THEN 'kind,id,publisher_id,package_id,skill_version_id,name,semver,state,created_at,decided_at,delist_requested_at'
    WHEN 'marketplace_listing_history' THEN 'kind,id,publisher_id,submission_id,review_id,display_name,summary,semver,state,delist_mode,delist_code,listed_at,delisted_at'
    WHEN 'marketplace_review_history' THEN 'kind,id,submission_id,verdict,finding_codes,decided_at,recorded_at'
    WHEN 'marketplace_installation_history' THEN 'kind,id,listing_id,requested_by_membership_id,state,failure_code,package_id,skill_version_id,package_name,semver,created_at,updated_at,removed_at'
  $sql$);
END $migration$;
--> statement-breakpoint
CREATE POLICY marketplace_history_review_custodian ON sovereign.imported_definitions
  AS RESTRICTIVE FOR SELECT TO ensemus_app USING (
    record_kind NOT IN ('marketplace_submission_history','marketplace_listing_history',
      'marketplace_review_history','marketplace_installation_history') OR EXISTS(
      SELECT 1 FROM sovereign.organization_imports i WHERE i.organization_id=imported_definitions.organization_id
        AND i.id=imported_definitions.import_id AND i.fallback_membership_id=app.current_membership_id()
    )
  );
