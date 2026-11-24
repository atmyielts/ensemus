-- FLAGGED FOR HUMAN SECURITY REVIEW
-- COMM-05. Register inert Skill binary receipts only under the pinned bundle archive profile.
DO $migration$
DECLARE
  definition text:=pg_get_functiondef('sovereign.register_import_part(uuid,text,bytea)'::regprocedure);
  anchor constant text:='OR (part->>''section''=''knowledge'' AND (part->>''records'')::integer=0)) THEN';
BEGIN
  IF strpos(definition,anchor)=0 THEN RAISE EXCEPTION 'SKILL_BINARY_PART_PROOF_CHANGED' USING ERRCODE='EN409'; END IF;
  EXECUTE replace(definition,anchor,$sql$
    OR (part->>'section'='knowledge' AND (part->>'records')::integer=0)
    OR (part->>'section'='skills' AND (part->>'records')::integer=0
      AND header.manifest->>'inventory_version'='ensemus.skill-bundles/12'
      AND p_path ~ '^skills/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.]bin[.]sealed$'
      AND octet_length(p_plain) BETWEEN 1 AND 8388608)) THEN
  $sql$);
END $migration$;
--> statement-breakpoint
DO $migration$
DECLARE
  definition text:=pg_get_functiondef('sovereign.guard_portable_definition()'::regprocedure);
  anchor constant text:='allowed:=string_to_array(CASE NEW.record_kind';
BEGIN
  IF strpos(definition,anchor)=0 THEN RAISE EXCEPTION 'SKILL_BINARY_QUARANTINE_CHANGED' USING ERRCODE='EN409'; END IF;
  EXECUTE replace(definition,anchor,$sql$
  IF NEW.record_kind='skill_bundle_version' AND NOT EXISTS(
    SELECT 1 FROM sovereign.organization_import_manifests p
    WHERE p.organization_id=NEW.organization_id AND p.import_id=NEW.import_id
      AND p.path='skills/'||NEW.source_id::text||'.bin.sealed' AND p.section='skills'
      AND p.record_count=0 AND p.plaintext_sha256=NEW.record->>'bundle_sha256'
  ) THEN RAISE EXCEPTION 'SKILL_BINARY_PART_PROOF_REQUIRED' USING ERRCODE='EN409'; END IF;
  $sql$||anchor);
END $migration$;
