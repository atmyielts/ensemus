-- FLAGGED FOR HUMAN SECURITY REVIEW
-- REVIEWED SECURITY SQL (ADR-029 D2 addendum, question 4). Changes here need human review, never agent
-- approval. Not yet reviewed by a person. This widens who may read a connector's source, so it is off by
-- default and changes nothing until an organization turns it on.
--
-- A provider's share with a whole email domain ("everyone at example.com") has mapped to nobody, so a
-- shared drive open to the domain looked empty. With org.security_policies.knowledge_domain_grants on, such
-- a grant reaches exactly the members who are all of:
--   - active members of this organization (the one bound to the transaction, never another tenant's);
--   - people whose email address is verified, and whose domain is exactly the granted domain (no
--     subdomain, no suffix match);
--   - in an organization that has itself verified that domain (org.sso_connections.domain_state =
--     'verified', which only the operator can set, and which is unique across tenants per 0400);
--   - reading a source classed `public` or `internal`, as an `organization` grant on an upload is.
-- "Anyone with the link" (`anyone`) still maps to nobody, whatever this setting says. Turning the setting
-- off stops every such read in that commit, because the rule is evaluated live, like every other ACL here.
--
-- The setting lives on org.security_policies, whose change already needs security_policy.change with
-- recent MFA (0404's app.guard_security_policy), because widening access is a security decision.
ALTER TABLE org.security_policies ADD COLUMN knowledge_domain_grants boolean DEFAULT false NOT NULL;
--> statement-breakpoint
GRANT UPDATE (knowledge_domain_grants) ON org.security_policies TO ensemus_app;
--> statement-breakpoint

-- Whether a domain grant reaches one member, now. Invoker's rights: the caller must already be able to see
-- this tenant's policy, its verified connections, the member and their email, which ensemus_app can for its
-- own tenant (0001, 0401, 0404) and nothing else can. A row it cannot see makes the answer false.
CREATE FUNCTION knowledge.verified_domain_member(p_domain text, p_membership uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog
  AS $$
  SELECT EXISTS (
    SELECT 1
      FROM org.security_policies p
      JOIN org.sso_connections c ON c.organization_id = p.organization_id
      JOIN org.memberships m ON m.organization_id = p.organization_id
      JOIN identity.users u ON u.id = m.user_id
     WHERE p.organization_id = app.current_organization_id()
       AND p.knowledge_domain_grants
       AND c.domain_state = 'verified'
       AND c.domain = lower(p_domain)
       AND m.id = p_membership
       AND m.status = 'active'
       AND u.email_verified
       AND strpos(u.email, '@') > 0
       AND split_part(u.email, '@', 3) = ''
       AND lower(split_part(u.email, '@', 2)) = c.domain)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION knowledge.verified_domain_member(text, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION knowledge.verified_domain_member(text, uuid) TO ensemus_app;
--> statement-breakpoint

-- Whether a resource is shared with a domain this organization verified, while the setting is on, so the
-- sweep fetches it although M3 calls it `unmapped`. Fetching grants no read: readable_source_ids decides.
CREATE FUNCTION knowledge.resource_domain_shared(p_resource uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog
  AS $$
  SELECT EXISTS (
    SELECT 1
      FROM integrations.external_resource_acl a
      JOIN org.security_policies p ON p.organization_id = a.organization_id
      JOIN org.sso_connections c
        ON c.organization_id = a.organization_id AND c.domain = lower(a.principal_external_id)
     WHERE a.organization_id = app.current_organization_id()
       AND a.resource_id = p_resource
       AND a.principal_kind = 'domain'
       AND p.knowledge_domain_grants
       AND c.domain_state = 'verified')
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION knowledge.resource_domain_shared(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION knowledge.resource_domain_shared(uuid) TO ensemus_app;
--> statement-breakpoint

-- 0201's one definition of who may read a source, unchanged except for the third branch at the end.
-- CREATE OR REPLACE keeps the function's OID, owner and 0201's grants, so every policy naming it is as it
-- was. A domain-only resource is `unmapped` in M3's terms, so that branch does not read acl_state.
CREATE OR REPLACE FUNCTION knowledge.readable_source_ids(p_membership uuid) RETURNS SETOF uuid
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
       OR
       (s.kind = 'connector' AND s.classification IN ('public', 'internal') AND EXISTS (
         SELECT 1
           FROM integrations.external_resources r
           JOIN integrations.connections c
             ON c.organization_id = r.organization_id AND c.id = r.connection_id
           JOIN integrations.external_resource_acl a
             ON a.organization_id = r.organization_id AND a.resource_id = r.id
          WHERE r.organization_id = s.organization_id
            AND r.id = s.external_resource_id
            AND r.deleted_at IS NULL
            AND c.state = 'active'
            AND a.principal_kind = 'domain'
            AND knowledge.verified_domain_member(a.principal_external_id, p_membership)))
     )
$$;
