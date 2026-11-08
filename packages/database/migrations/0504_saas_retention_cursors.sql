-- Durable bounded retention progress. Security SQL requires human review before application.
-- Each rule row is immutable, so its ID is its version; a changed rule starts a new pinned cycle.
CREATE TABLE lifecycle.retention_cursors (
  organization_id uuid NOT NULL REFERENCES org.organizations(id),
  data_category text NOT NULL,
  classification text NOT NULL CHECK (classification IN ('public','internal','confidential','restricted')),
  rule_id uuid NOT NULL,
  cutoff_at timestamptz NOT NULL,
  after text,
  completed boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT retention_cursors_pk PRIMARY KEY (organization_id,data_category,classification),
  CONSTRAINT retention_cursors_rule FOREIGN KEY (organization_id,rule_id)
    REFERENCES lifecycle.retention_rules(organization_id,id)
);
--> statement-breakpoint
ALTER TABLE lifecycle.retention_cursors ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE lifecycle.retention_cursors FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_scope ON lifecycle.retention_cursors TO ensemus_app
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE,DELETE ON lifecycle.retention_cursors TO ensemus_app;
--> statement-breakpoint
-- Supports raw-file expiry keysets without an offset scan. There is no configured retention duration.
CREATE INDEX artifacts_retention_expiry ON work.artifacts(organization_id,classification,created_at,id);
--> statement-breakpoint
-- Canonical modeled constraint identities; referential actions and validation stay unchanged.
ALTER TABLE "lifecycle"."retention_cursors" RENAME CONSTRAINT "retention_cursors_organization_id_fkey" TO "retention_cursors_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE lifecycle.retention_cursors RENAME CONSTRAINT retention_cursors_classification_check TO retention_cursors_classification;
