-- Unregistered source. Native broker-role identity attestation precedes any customer/charge transport.
DO $$ BEGIN
 IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND(rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'PAYMENT_GUARD_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
END $$;
--> statement-breakpoint
CREATE TABLE billing.payment_identity_attestations (
 organization_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),payment_id uuid NOT NULL,
 token_sha256 text NOT NULL UNIQUE,billing_organization_id uuid NOT NULL,connection_id uuid NOT NULL,
 connection_version bigint NOT NULL CHECK(connection_version>0),credential_secret_id uuid NOT NULL,
 processor text NOT NULL,adapter_version text NOT NULL,api_origin text NOT NULL,config_sha256 text NOT NULL,authority_sha256 text NOT NULL,
 identity_sha256 text NOT NULL,account_namespace_sha256 text NOT NULL,read_receipt_sha256 text NOT NULL,issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,consumed_binding_id uuid,
 CONSTRAINT payment_identity_pk PRIMARY KEY(organization_id,id),
 CONSTRAINT payment_identity_payment FOREIGN KEY(organization_id,payment_id) REFERENCES billing.payments(organization_id,id),
 CONSTRAINT payment_identity_connection FOREIGN KEY(billing_organization_id,connection_id) REFERENCES integrations.connections(organization_id,id),
 CONSTRAINT payment_identity_secret FOREIGN KEY(billing_organization_id,credential_secret_id) REFERENCES secrets.sealed_secrets(organization_id,id),
 CONSTRAINT payment_identity_hashes CHECK(token_sha256 ~ '^[0-9a-f]{64}$' AND config_sha256 ~ '^[0-9a-f]{64}$'
  AND authority_sha256 ~ '^[0-9a-f]{64}$' AND identity_sha256 ~ '^[0-9a-f]{64}$' AND account_namespace_sha256 ~ '^[0-9a-f]{64}$' AND read_receipt_sha256 ~ '^[0-9a-f]{64}$'),
 CONSTRAINT payment_identity_window CHECK(expires_at>issued_at AND expires_at<=issued_at+interval '60 seconds')
);
CREATE TABLE billing.payment_execution_bindings (
 organization_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),payment_id uuid NOT NULL,
 attestation_id uuid NOT NULL,billing_organization_id uuid NOT NULL,connection_id uuid NOT NULL,
 connection_version bigint NOT NULL CHECK(connection_version>0),credential_secret_id uuid NOT NULL,
 processor text NOT NULL,adapter_version text NOT NULL,api_origin text NOT NULL,config_sha256 text NOT NULL,authority_sha256 text NOT NULL,
 identity_sha256 text NOT NULL,account_namespace_sha256 text NOT NULL,binding_sha256 text NOT NULL,qualified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 customer_state text NOT NULL DEFAULT 'new' CHECK(customer_state IN('new','sending','confirmed','unknown')),
 customer_request_key text NOT NULL,customer_token uuid,customer_ref_hash text,
 customer_started_at timestamptz,customer_transport_started_at timestamptz,customer_finished_at timestamptz,
 CONSTRAINT payment_execution_pk PRIMARY KEY(organization_id,id),
 CONSTRAINT payment_execution_one UNIQUE(organization_id,payment_id),
 CONSTRAINT payment_execution_attempt_key UNIQUE(organization_id,payment_id,id),
 CONSTRAINT payment_execution_payment FOREIGN KEY(organization_id,payment_id) REFERENCES billing.payments(organization_id,id),
 CONSTRAINT payment_execution_attestation FOREIGN KEY(organization_id,attestation_id) REFERENCES billing.payment_identity_attestations(organization_id,id),
 CONSTRAINT payment_execution_connection FOREIGN KEY(billing_organization_id,connection_id) REFERENCES integrations.connections(organization_id,id),
 CONSTRAINT payment_execution_secret FOREIGN KEY(billing_organization_id,credential_secret_id) REFERENCES secrets.sealed_secrets(organization_id,id),
 CONSTRAINT payment_execution_hashes CHECK(config_sha256 ~ '^[0-9a-f]{64}$' AND authority_sha256 ~ '^[0-9a-f]{64}$'
  AND identity_sha256 ~ '^[0-9a-f]{64}$' AND account_namespace_sha256 ~ '^[0-9a-f]{64}$' AND binding_sha256 ~ '^[0-9a-f]{64}$'
  AND(customer_ref_hash IS NULL OR customer_ref_hash ~ '^[0-9a-f]{64}$')),
 CONSTRAINT payment_execution_customer CHECK((customer_state='confirmed')=(customer_ref_hash IS NOT NULL)
  AND(customer_state NOT IN('sending','confirmed','unknown') OR(customer_token IS NOT NULL AND customer_started_at IS NOT NULL)))
);
CREATE UNIQUE INDEX payment_customer_unconfirmed ON billing.payment_execution_bindings(organization_id,customer_request_key) WHERE customer_state IN('sending','unknown');
ALTER TABLE billing.payment_identity_attestations ADD CONSTRAINT payment_identity_consumed_binding
 FOREIGN KEY(organization_id,consumed_binding_id) REFERENCES billing.payment_execution_bindings(organization_id,id);
CREATE TABLE billing.payment_customer_bindings (
 organization_id uuid NOT NULL,account_id uuid NOT NULL,processor text NOT NULL,account_namespace_sha256 text NOT NULL,
 customer_ref_hash text NOT NULL,execution_binding_id uuid NOT NULL,confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT payment_customer_pk PRIMARY KEY(organization_id,account_id,account_namespace_sha256),
 CONSTRAINT payment_customer_route UNIQUE(processor,account_namespace_sha256,customer_ref_hash),
 CONSTRAINT payment_customer_account FOREIGN KEY(organization_id,account_id) REFERENCES billing.billing_accounts(organization_id,id),
 CONSTRAINT payment_customer_execution FOREIGN KEY(organization_id,execution_binding_id) REFERENCES billing.payment_execution_bindings(organization_id,id),
 CONSTRAINT payment_customer_hashes CHECK(account_namespace_sha256 ~ '^[0-9a-f]{64}$' AND customer_ref_hash ~ '^[0-9a-f]{64}$')
);
ALTER TABLE billing.billing_accounts ADD COLUMN processor_account_namespace_sha256 text;
ALTER TABLE billing.billing_accounts ADD CONSTRAINT billing_accounts_execution_hash
 CHECK(processor_account_namespace_sha256 IS NULL OR processor_account_namespace_sha256 ~ '^[0-9a-f]{64}$');
DROP INDEX billing.billing_accounts_customer_ref;
CREATE UNIQUE INDEX billing_accounts_customer_ref ON billing.billing_accounts(processor,processor_account_namespace_sha256,customer_ref_hash)
 WHERE customer_ref_hash IS NOT NULL;
ALTER TABLE billing.payment_attempts ADD COLUMN execution_binding_id uuid;
ALTER TABLE billing.payment_attempts ADD COLUMN transport_started_at timestamptz;
ALTER TABLE billing.payment_attempts ADD COLUMN lookup_started_at timestamptz;
ALTER TABLE billing.payment_attempts ADD CONSTRAINT payment_attempt_execution
 FOREIGN KEY(organization_id,payment_id,execution_binding_id) REFERENCES billing.payment_execution_bindings(organization_id,payment_id,id);
ALTER TABLE billing.payment_webhook_events ADD COLUMN source_delivery_id uuid,ADD COLUMN source_endpoint_id uuid,
 ADD COLUMN source_connection_id uuid,ADD COLUMN source_connection_version bigint,ADD COLUMN source_api_secret_id uuid,
 ADD COLUMN source_config_sha256 text,ADD COLUMN execution_identity_sha256 text,ADD COLUMN account_namespace_sha256 text,ADD COLUMN execution_binding_sha256 text;
ALTER TABLE billing.payment_webhook_events ADD CONSTRAINT payment_webhook_delivery
 FOREIGN KEY(organization_id,source_delivery_id) REFERENCES integrations.webhook_deliveries(organization_id,id);
ALTER TABLE billing.payment_webhook_events ADD CONSTRAINT payment_webhook_endpoint
 FOREIGN KEY(organization_id,source_endpoint_id) REFERENCES integrations.webhook_endpoints(organization_id,id);
ALTER TABLE billing.payment_webhook_events ADD CONSTRAINT payment_webhook_connection
 FOREIGN KEY(organization_id,source_connection_id) REFERENCES integrations.connections(organization_id,id);
ALTER TABLE billing.payment_webhook_events ADD CONSTRAINT payment_webhook_api_secret
 FOREIGN KEY(organization_id,source_api_secret_id) REFERENCES secrets.sealed_secrets(organization_id,id);
--> statement-breakpoint

DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['payment_identity_attestations','payment_execution_bindings','payment_customer_bindings'] LOOP
  EXECUTE format('ALTER TABLE billing.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE billing.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY payment_fixed_owner ON billing.%I TO ensemus_migrator USING(organization_id::text=current_setting(''billing.payment_org'',true)) WITH CHECK(organization_id::text=current_setting(''billing.payment_org'',true))',t);
  EXECUTE format('REVOKE ALL ON billing.%I FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_eraser,ensemus_secrets',t);
 END LOOP;
END $$;
-- Metadata visibility for the fixed functions, never a new caller/body table grant.
CREATE POLICY payment_connection_metadata ON integrations.connections FOR SELECT TO ensemus_migrator
 USING(organization_id::text=current_setting('billing.payment_control_org',true));
CREATE POLICY payment_connection_lock ON integrations.connections FOR UPDATE TO ensemus_migrator
 USING(organization_id::text=current_setting('billing.payment_control_org',true)) WITH CHECK(false);
CREATE POLICY payment_secret_metadata ON secrets.sealed_secrets FOR SELECT TO ensemus_migrator
 USING(organization_id::text=current_setting('billing.payment_control_org',true));
CREATE POLICY payment_secret_lock ON secrets.sealed_secrets FOR UPDATE TO ensemus_migrator
 USING(organization_id::text=current_setting('billing.payment_control_org',true)) WITH CHECK(false);
CREATE POLICY payment_intent_metadata ON billing.payments FOR SELECT TO ensemus_migrator
 USING(organization_id::text=current_setting('billing.payment_org',true));
CREATE POLICY payment_intent_lock ON billing.payments FOR UPDATE TO ensemus_migrator
 USING(organization_id::text=current_setting('billing.payment_org',true)) WITH CHECK(false);
CREATE POLICY payment_attempt_metadata ON billing.payment_attempts FOR SELECT TO ensemus_migrator
 USING(organization_id::text=current_setting('billing.payment_org',true));
CREATE POLICY payment_attempt_control ON billing.payment_attempts FOR UPDATE TO ensemus_migrator
 USING(organization_id::text=current_setting('billing.payment_org',true))
 WITH CHECK(organization_id::text=current_setting('billing.payment_org',true));
CREATE POLICY payment_account_metadata ON billing.billing_accounts FOR SELECT TO ensemus_migrator
 USING(organization_id::text=current_setting('billing.payment_org',true));
CREATE POLICY payment_account_mutation ON billing.billing_accounts FOR UPDATE TO ensemus_migrator
 USING(organization_id::text=current_setting('billing.payment_org',true))
 WITH CHECK(organization_id::text=current_setting('billing.payment_org',true));
CREATE POLICY payment_org_metadata ON org.organizations FOR SELECT TO ensemus_migrator
 USING(id::text=current_setting('billing.payment_org',true));
CREATE POLICY payment_org_lock ON org.organizations FOR UPDATE TO ensemus_migrator
 USING(id::text=current_setting('billing.payment_org',true)) WITH CHECK(false);
--> statement-breakpoint

-- Internal fixed snapshot: config digest is explicitly PostgreSQL jsonb text, not a fake canonical-JSON match.
CREATE FUNCTION billing.payment_connection_snapshot(p_billing_org uuid,p_connection uuid,p_processor text,p_adapter text,p_origin text)
 RETURNS TABLE("billingOrganizationId" uuid,"connectionId" uuid,"connectionVersion" text,"credentialSecretId" uuid,
 "processor" text,"adapterVersion" text,"apiOrigin" text,"configSha256" text,"authoritySha256" text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE prior text:=current_setting('billing.payment_control_org',true);c record;s record;config_hash text;
BEGIN
 IF session_user NOT IN('ensemus_app','ensemus_secrets') OR p_billing_org IS NULL OR p_connection IS NULL
  OR p_processor IS NULL OR p_adapter IS NULL OR p_processor!~'^[a-z][a-z0-9_]{1,55}$'
  OR length(p_adapter)>64 OR p_adapter!~'^[0-9]+\.[0-9]+\.[0-9]+$'
  OR p_origin IS NULL OR p_origin!~'^https://[a-zA-Z0-9.-]{1,253}$' THEN
  RAISE EXCEPTION 'PAYMENT_EXECUTION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 PERFORM set_config('billing.payment_control_org',p_billing_org::text,true);
 SELECT x.organization_id,x.id,x.version,x.credential_secret_id,x.connector_type,x.state,x.config INTO c
 FROM integrations.connections x WHERE x.organization_id=p_billing_org AND x.id=p_connection FOR SHARE NOWAIT;
 IF c.id IS NULL OR c.state<>'active' OR c.connector_type<>'payment_'||p_processor OR c.credential_secret_id IS NULL
  OR c.config<>'{}'::jsonb THEN
  RAISE EXCEPTION 'PAYMENT_EXECUTION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 SELECT x.id,x.purpose,x.revoked_at INTO s FROM secrets.sealed_secrets x
 WHERE x.organization_id=p_billing_org AND x.id=c.credential_secret_id FOR SHARE NOWAIT;
 IF s.id IS NULL OR s.purpose<>'connector.payment_processor' OR s.revoked_at IS NOT NULL THEN
  RAISE EXCEPTION 'PAYMENT_EXECUTION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 config_hash:=encode(public.digest(convert_to(c.config::text,'UTF8'),'sha256'),'hex');
 RETURN QUERY SELECT p_billing_org,c.id,c.version::text,c.credential_secret_id,p_processor,p_adapter,p_origin,config_hash,
  encode(public.digest(convert_to(jsonb_build_array(p_billing_org,c.id,c.version::text,c.credential_secret_id,config_hash,p_processor,p_adapter,p_origin)::text,'UTF8'),'sha256'),'hex');
 PERFORM set_config('billing.payment_control_org',coalesce(prior,''),true);
EXCEPTION WHEN OTHERS THEN
 PERFORM set_config('billing.payment_control_org',coalesce(prior,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION billing.payment_connection_snapshot(uuid,uuid,text,text,text) FROM PUBLIC;
-- Invoked only by the bounded payment preflight/attestation functions below, never a generic lookup grant.
--> statement-breakpoint

CREATE FUNCTION billing.payment_execution_preflight(p_payment uuid,p_billing_org uuid,p_connection uuid,p_processor text,p_adapter text,p_origin text)
 RETURNS TABLE("billingOrganizationId" uuid,"connectionId" uuid,"connectionVersion" text,"credentialSecretId" uuid,
 "processor" text,"adapterVersion" text,"apiOrigin" text,"configSha256" text,"authoritySha256" text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE prior text:=current_setting('billing.payment_org',true);intent record;mode text;actual record;original record;
BEGIN
 IF session_user<>'ensemus_app' OR app.current_actor_type() IS DISTINCT FROM 'service' OR app.current_organization_id() IS NULL THEN
  RAISE EXCEPTION 'PAYMENT_EXECUTION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 PERFORM set_config('billing.payment_org',app.current_organization_id()::text,true);
 SELECT p.id,p.processor INTO intent FROM billing.payments p WHERE p.organization_id=app.current_organization_id() AND p.id=p_payment;
 SELECT o.commercial_mode INTO mode FROM org.organizations o WHERE o.id=app.current_organization_id() AND o.lifecycle<>'deleted';
 IF intent.id IS NULL OR intent.processor IS DISTINCT FROM p_processor OR mode IS NULL OR mode='sovereign' THEN
  RAISE EXCEPTION 'PAYMENT_EXECUTION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 SELECT * INTO actual FROM billing.payment_connection_snapshot(p_billing_org,p_connection,p_processor,p_adapter,p_origin);
 SELECT b.id,b.authority_sha256 INTO original FROM billing.payment_execution_bindings b
 WHERE b.organization_id=app.current_organization_id() AND b.payment_id=p_payment;
 IF(original.id IS NOT NULL AND original.authority_sha256 IS DISTINCT FROM actual."authoritySha256")
  OR(original.id IS NULL AND EXISTS(SELECT 1 FROM billing.payment_attempts a
   WHERE a.organization_id=app.current_organization_id() AND a.payment_id=p_payment)) THEN
  RAISE EXCEPTION 'PAYMENT_EXECUTION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 RETURN QUERY SELECT actual."billingOrganizationId",actual."connectionId",actual."connectionVersion",actual."credentialSecretId",
  actual."processor",actual."adapterVersion",actual."apiOrigin",actual."configSha256",actual."authoritySha256";
 PERFORM set_config('billing.payment_org',coalesce(prior,''),true);
EXCEPTION WHEN OTHERS THEN PERFORM set_config('billing.payment_org',coalesce(prior,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION billing.payment_execution_preflight(uuid,uuid,uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing.payment_execution_preflight(uuid,uuid,uuid,text,text,text) TO ensemus_app;

CREATE FUNCTION billing.attest_payment_identity(p_org uuid,p_payment uuid,p_billing_org uuid,p_connection uuid,p_processor text,p_adapter text,p_origin text,
 p_authority_sha256 text,p_identity_sha256 text,p_namespace_sha256 text,p_read_receipt_sha256 text)
 RETURNS TABLE(token text,"expiresAt" timestamptz) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE prior text:=current_setting('billing.payment_org',true);intent record;mode text;actual record;original record;
 issued timestamptz;expires timestamptz;opaque text;
BEGIN
 IF session_user<>'ensemus_secrets' OR p_org IS NULL OR p_payment IS NULL
  OR p_authority_sha256 IS NULL OR p_identity_sha256 IS NULL OR p_namespace_sha256 IS NULL OR p_read_receipt_sha256 IS NULL
  OR p_authority_sha256!~'^[0-9a-f]{64}$' OR p_identity_sha256!~'^[0-9a-f]{64}$' OR p_namespace_sha256!~'^[0-9a-f]{64}$' OR p_read_receipt_sha256!~'^[0-9a-f]{64}$' THEN
  RAISE EXCEPTION 'PAYMENT_NATIVE_IDENTITY_REQUIRED' USING ERRCODE='42501';END IF;
 PERFORM set_config('billing.payment_org',p_org::text,true);
 SELECT p.id,p.processor INTO intent FROM billing.payments p WHERE p.organization_id=p_org AND p.id=p_payment FOR SHARE NOWAIT;
 SELECT o.commercial_mode INTO mode FROM org.organizations o WHERE o.id=p_org AND o.lifecycle<>'deleted';
 IF intent.id IS NULL OR intent.processor IS DISTINCT FROM p_processor OR mode IS NULL OR mode='sovereign' THEN
  RAISE EXCEPTION 'PAYMENT_EXECUTION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 SELECT * INTO actual FROM billing.payment_connection_snapshot(p_billing_org,p_connection,p_processor,p_adapter,p_origin);
 IF actual."authoritySha256" IS DISTINCT FROM p_authority_sha256 THEN
  RAISE EXCEPTION 'PAYMENT_EXECUTION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 SELECT b.id,b.authority_sha256,b.identity_sha256 INTO original FROM billing.payment_execution_bindings b
  WHERE b.organization_id=p_org AND b.payment_id=p_payment;
 IF(original.id IS NOT NULL AND(original.authority_sha256 IS DISTINCT FROM p_authority_sha256 OR original.identity_sha256 IS DISTINCT FROM p_identity_sha256))
  OR(original.id IS NULL AND EXISTS(SELECT 1 FROM billing.payment_attempts a WHERE a.organization_id=p_org AND a.payment_id=p_payment)) THEN
  RAISE EXCEPTION 'PAYMENT_EXECUTION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 issued:=clock_timestamp();expires:=issued+interval '60 seconds';opaque:=encode(public.gen_random_bytes(32),'hex');
 INSERT INTO billing.payment_identity_attestations(organization_id,payment_id,token_sha256,billing_organization_id,connection_id,connection_version,
  credential_secret_id,processor,adapter_version,api_origin,config_sha256,authority_sha256,identity_sha256,account_namespace_sha256,read_receipt_sha256,issued_at,expires_at)
 VALUES(p_org,p_payment,encode(public.digest(opaque,'sha256'),'hex'),actual."billingOrganizationId",actual."connectionId",actual."connectionVersion"::bigint,
  actual."credentialSecretId",p_processor,p_adapter,p_origin,actual."configSha256",p_authority_sha256,p_identity_sha256,p_namespace_sha256,p_read_receipt_sha256,issued,expires);
 RETURN QUERY SELECT opaque,expires;
 PERFORM set_config('billing.payment_org',coalesce(prior,''),true);
EXCEPTION WHEN OTHERS THEN PERFORM set_config('billing.payment_org',coalesce(prior,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION billing.attest_payment_identity(uuid,uuid,uuid,uuid,text,text,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing.attest_payment_identity(uuid,uuid,uuid,uuid,text,text,text,text,text,text,text) TO ensemus_secrets;

CREATE FUNCTION billing.bind_payment_execution(p_payment uuid,p_token text)
 RETURNS TABLE("id" uuid,"authoritySha256" text,"identitySha256" text,"accountNamespaceSha256" text,"bindingSha256" text,"customerState" text,"customerRefHash" text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE prior text:=current_setting('billing.payment_org',true);org_id uuid:=app.current_organization_id();intent record;att record;actual record;bound record;
BEGIN
 IF session_user<>'ensemus_app' OR app.current_actor_type() IS DISTINCT FROM 'service' OR org_id IS NULL
  OR p_token IS NULL OR p_token!~'^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'PAYMENT_NATIVE_IDENTITY_REQUIRED' USING ERRCODE='42501';END IF;
 PERFORM set_config('billing.payment_org',org_id::text,true);
 PERFORM o.id FROM org.organizations o WHERE o.id=org_id FOR NO KEY UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_EXECUTION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 SELECT p.id,p.processor INTO intent FROM billing.payments p WHERE p.organization_id=org_id AND p.id=p_payment FOR UPDATE NOWAIT;
 SELECT a.* INTO att FROM billing.payment_identity_attestations a WHERE a.organization_id=org_id AND a.payment_id=p_payment
  AND a.token_sha256=encode(public.digest(p_token,'sha256'),'hex') FOR UPDATE NOWAIT;
 IF intent.id IS NULL OR att.id IS NULL OR att.expires_at<=clock_timestamp() OR att.processor IS DISTINCT FROM intent.processor THEN
  RAISE EXCEPTION 'PAYMENT_EXECUTION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 SELECT * INTO actual FROM billing.payment_connection_snapshot(att.billing_organization_id,att.connection_id,att.processor,att.adapter_version,att.api_origin);
 IF actual."authoritySha256" IS DISTINCT FROM att.authority_sha256 THEN RAISE EXCEPTION 'PAYMENT_EXECUTION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 SELECT b.* INTO bound FROM billing.payment_execution_bindings b WHERE b.organization_id=org_id AND b.payment_id=p_payment FOR UPDATE NOWAIT;
 IF att.consumed_binding_id IS NOT NULL THEN RAISE EXCEPTION 'PAYMENT_IDENTITY_TOKEN_USED' USING ERRCODE='EN850';END IF;
 IF bound.id IS NULL THEN
  IF EXISTS(SELECT 1 FROM billing.payment_attempts a WHERE a.organization_id=org_id AND a.payment_id=p_payment) THEN
   RAISE EXCEPTION 'PAYMENT_EXECUTION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
  INSERT INTO billing.payment_execution_bindings(organization_id,payment_id,attestation_id,billing_organization_id,connection_id,connection_version,
   credential_secret_id,processor,adapter_version,api_origin,config_sha256,authority_sha256,identity_sha256,account_namespace_sha256,binding_sha256,customer_request_key)
  VALUES(org_id,p_payment,att.id,att.billing_organization_id,att.connection_id,att.connection_version,att.credential_secret_id,att.processor,att.adapter_version,att.api_origin,
   att.config_sha256,att.authority_sha256,att.identity_sha256,att.account_namespace_sha256,
   encode(public.digest(convert_to(jsonb_build_array(att.authority_sha256,att.identity_sha256)::text,'UTF8'),'sha256'),'hex'),
   'ensemus-customer:'||encode(public.digest(convert_to(jsonb_build_array(org_id,att.processor,att.account_namespace_sha256)::text,'UTF8'),'sha256'),'hex'))
  RETURNING * INTO bound;
 ELSIF bound.authority_sha256 IS DISTINCT FROM att.authority_sha256 OR bound.identity_sha256 IS DISTINCT FROM att.identity_sha256 OR bound.account_namespace_sha256 IS DISTINCT FROM att.account_namespace_sha256 THEN
  RAISE EXCEPTION 'PAYMENT_EXECUTION_UNCONFIRMED' USING ERRCODE='EN850';
 END IF;
 UPDATE billing.payment_identity_attestations SET consumed_binding_id=bound.id WHERE organization_id=org_id AND billing.payment_identity_attestations.id=att.id;
 RETURN QUERY SELECT bound.id,bound.authority_sha256,bound.identity_sha256,bound.account_namespace_sha256,bound.binding_sha256,bound.customer_state,bound.customer_ref_hash;
 PERFORM set_config('billing.payment_org',coalesce(prior,''),true);
EXCEPTION WHEN OTHERS THEN PERFORM set_config('billing.payment_org',coalesce(prior,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION billing.bind_payment_execution(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing.bind_payment_execution(uuid,text) TO ensemus_app;
--> statement-breakpoint

CREATE FUNCTION billing.read_payment_execution(p_payment uuid)
 RETURNS TABLE("id" uuid,"authoritySha256" text,"identitySha256" text,"accountNamespaceSha256" text,"bindingSha256" text,"customerState" text,"customerRefHash" text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE prior text:=current_setting('billing.payment_org',true);org_id uuid:=app.current_organization_id();
BEGIN
 IF session_user<>'ensemus_app' OR app.current_actor_type() IS DISTINCT FROM 'service' OR org_id IS NULL THEN
  RAISE EXCEPTION 'PAYMENT_EXECUTION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 PERFORM set_config('billing.payment_org',org_id::text,true);
 IF NOT EXISTS(SELECT 1 FROM billing.payments p WHERE p.organization_id=org_id AND p.id=p_payment) THEN
  RAISE EXCEPTION 'PAYMENT_EXECUTION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 RETURN QUERY SELECT b.id,b.authority_sha256,b.identity_sha256,b.account_namespace_sha256,b.binding_sha256,b.customer_state,b.customer_ref_hash
  FROM billing.payment_execution_bindings b WHERE b.organization_id=org_id AND b.payment_id=p_payment;
 PERFORM set_config('billing.payment_org',coalesce(prior,''),true);
EXCEPTION WHEN OTHERS THEN PERFORM set_config('billing.payment_org',coalesce(prior,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION billing.read_payment_execution(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing.read_payment_execution(uuid) TO ensemus_app;

CREATE FUNCTION billing.begin_payment_customer(p_payment uuid,p_binding uuid)
 RETURNS TABLE(action text,token uuid,"requestKey" text,"customerRef" text) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE prior text:=current_setting('billing.payment_org',true);org_id uuid:=app.current_organization_id();b record;a record;original record;native record;nonce uuid;
BEGIN
 IF session_user<>'ensemus_app' OR app.current_actor_type() IS DISTINCT FROM 'service' OR org_id IS NULL THEN
  RAISE EXCEPTION 'PAYMENT_EXECUTION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 PERFORM set_config('billing.payment_org',org_id::text,true);
 PERFORM o.id FROM org.organizations o WHERE o.id=org_id FOR NO KEY UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_EXECUTION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 PERFORM p.id FROM billing.payments p WHERE p.organization_id=org_id AND p.id=p_payment AND p.status='ready' FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_EXECUTION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 SELECT x.* INTO b FROM billing.payment_execution_bindings x WHERE x.organization_id=org_id AND x.id=p_binding AND x.payment_id=p_payment FOR UPDATE NOWAIT;
 IF b.id IS NULL THEN RAISE EXCEPTION 'PAYMENT_EXECUTION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 IF b.customer_state='confirmed' THEN
  SELECT x.processor_customer_ref INTO a FROM billing.billing_accounts x WHERE x.organization_id=org_id
   AND x.processor=b.processor AND x.processor_account_namespace_sha256=b.account_namespace_sha256 AND x.customer_ref_hash=b.customer_ref_hash;
  RETURN QUERY SELECT CASE WHEN a.processor_customer_ref IS NULL THEN 'unknown' ELSE 'confirmed' END,b.customer_token,b.customer_request_key,a.processor_customer_ref;
 ELSIF b.customer_state IN('sending','unknown') THEN
  RETURN QUERY SELECT 'unknown'::text,b.customer_token,b.customer_request_key,NULL::text;
 ELSE
  SELECT * INTO native FROM billing.payment_connection_snapshot(b.billing_organization_id,b.connection_id,b.processor,b.adapter_version,b.api_origin);
  IF native."authoritySha256" IS DISTINCT FROM b.authority_sha256 THEN RAISE EXCEPTION 'PAYMENT_EXECUTION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
  SELECT x.id,x.processor_customer_ref,x.customer_ref_hash,x.processor_account_namespace_sha256,x.processor INTO a FROM billing.billing_accounts x
   WHERE x.organization_id=org_id FOR UPDATE NOWAIT;
  IF a.id IS NULL THEN RAISE EXCEPTION 'PAYMENT_EXECUTION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
  SELECT x.customer_ref_hash INTO original FROM billing.payment_customer_bindings x
   WHERE x.organization_id=org_id AND x.account_id=a.id AND x.account_namespace_sha256=b.account_namespace_sha256 AND x.processor=b.processor;
  nonce:=gen_random_uuid();
  IF original.customer_ref_hash IS NOT NULL AND a.processor=b.processor AND a.processor_account_namespace_sha256=b.account_namespace_sha256
   AND a.customer_ref_hash=original.customer_ref_hash AND a.processor_customer_ref IS NOT NULL THEN
   UPDATE billing.payment_execution_bindings SET customer_state='confirmed',customer_token=nonce,
    customer_ref_hash=a.customer_ref_hash,customer_started_at=clock_timestamp(),customer_finished_at=clock_timestamp()
    WHERE organization_id=org_id AND id=b.id;
   RETURN QUERY SELECT 'confirmed'::text,nonce,b.customer_request_key,a.processor_customer_ref;
  ELSIF EXISTS(SELECT 1 FROM billing.payment_execution_bindings prior_customer
   WHERE prior_customer.organization_id=org_id AND prior_customer.id<>b.id AND prior_customer.customer_request_key=b.customer_request_key
    AND prior_customer.customer_state IN('sending','unknown','confirmed')) THEN
   -- An earlier operation/ACK cannot be retried through a different payment or replacement adapter.
   RETURN QUERY SELECT 'unknown'::text,NULL::uuid,b.customer_request_key,NULL::text;
  ELSE
   UPDATE billing.payment_execution_bindings SET customer_state='sending',customer_token=nonce,customer_started_at=clock_timestamp()
    WHERE organization_id=org_id AND id=b.id;
   RETURN QUERY SELECT 'send'::text,nonce,b.customer_request_key,NULL::text;
  END IF;
 END IF;
 PERFORM set_config('billing.payment_org',coalesce(prior,''),true);
EXCEPTION WHEN OTHERS THEN PERFORM set_config('billing.payment_org',coalesce(prior,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION billing.begin_payment_customer(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing.begin_payment_customer(uuid,uuid) TO ensemus_app;

CREATE FUNCTION billing.finish_payment_customer(p_payment uuid,p_binding uuid,p_token uuid,p_customer text)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE prior text:=current_setting('billing.payment_org',true);org_id uuid:=app.current_organization_id();b record;a record;customer_hash text;
BEGIN
 IF session_user<>'ensemus_app' OR app.current_actor_type() IS DISTINCT FROM 'service' OR org_id IS NULL
  OR(p_customer IS NOT NULL AND(length(p_customer)<1 OR length(p_customer)>256 OR p_customer ~ '[[:cntrl:]]')) THEN
  RAISE EXCEPTION 'PAYMENT_EXECUTION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 PERFORM set_config('billing.payment_org',org_id::text,true);
 PERFORM o.id FROM org.organizations o WHERE o.id=org_id FOR NO KEY UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_EXECUTION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 SELECT x.* INTO b FROM billing.payment_execution_bindings x WHERE x.organization_id=org_id AND x.id=p_binding AND x.payment_id=p_payment FOR UPDATE NOWAIT;
 IF b.id IS NULL OR b.customer_token IS DISTINCT FROM p_token OR p_token IS NULL OR b.customer_state='new'
  OR(p_customer IS NOT NULL AND b.customer_transport_started_at IS NULL) THEN
  RAISE EXCEPTION 'PAYMENT_EXECUTION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 -- A known returned answer belongs to the original operation even after its authority was revoked.
 IF b.customer_state='confirmed' THEN
  IF p_customer IS NOT NULL AND encode(public.digest(convert_to('['||to_json(b.processor)::text||','||to_json(p_customer)::text||']','UTF8'),'sha256'),'hex') IS DISTINCT FROM b.customer_ref_hash THEN
   RAISE EXCEPTION 'PAYMENT_CUSTOMER_CONFLICT' USING ERRCODE='EN850';END IF;
 ELSIF p_customer IS NULL THEN
  UPDATE billing.payment_execution_bindings SET customer_state='unknown',customer_finished_at=clock_timestamp() WHERE organization_id=org_id AND id=b.id;
 ELSE
  customer_hash:=encode(public.digest(convert_to('['||to_json(b.processor)::text||','||to_json(p_customer)::text||']','UTF8'),'sha256'),'hex');
  UPDATE billing.payment_execution_bindings SET customer_state='confirmed',customer_ref_hash=customer_hash,customer_finished_at=clock_timestamp()
   WHERE organization_id=org_id AND id=b.id;
  SELECT x.id,x.processor,x.processor_customer_ref,x.customer_ref_hash,x.processor_account_namespace_sha256 INTO a FROM billing.billing_accounts x
   WHERE x.organization_id=org_id FOR UPDATE NOWAIT;
  -- Never overwrite a different old customer reference or claim that its unknown history is qualified.
  IF a.id IS NOT NULL AND(a.processor IS NULL OR a.processor=b.processor)
   AND(a.processor_customer_ref IS NULL OR a.processor_customer_ref=p_customer)
   AND(a.processor_account_namespace_sha256 IS NULL OR a.processor_account_namespace_sha256=b.account_namespace_sha256) THEN
   INSERT INTO billing.payment_customer_bindings(organization_id,account_id,processor,account_namespace_sha256,customer_ref_hash,execution_binding_id)
    VALUES(org_id,a.id,b.processor,b.account_namespace_sha256,customer_hash,b.id) ON CONFLICT DO NOTHING;
   -- Keep the genuine ACK even if another tenant/account already owns that native customer namespace.
   -- In that case no account is qualified and subsequent begin/charge remains unconfirmed.
   IF EXISTS(SELECT 1 FROM billing.payment_customer_bindings x WHERE x.organization_id=org_id AND x.account_id=a.id
    AND x.processor=b.processor AND x.account_namespace_sha256=b.account_namespace_sha256 AND x.customer_ref_hash=customer_hash) THEN
    UPDATE billing.billing_accounts SET processor=b.processor,processor_customer_ref=p_customer,customer_ref_hash=customer_hash,
     processor_account_namespace_sha256=b.account_namespace_sha256,version=version+1,updated_at=clock_timestamp() WHERE organization_id=org_id AND id=a.id;
   END IF;
  END IF;
 END IF;
 PERFORM set_config('billing.payment_org',coalesce(prior,''),true);RETURN true;
EXCEPTION WHEN OTHERS THEN PERFORM set_config('billing.payment_org',coalesce(prior,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION billing.finish_payment_customer(uuid,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing.finish_payment_customer(uuid,uuid,uuid,text) TO ensemus_app;
--> statement-breakpoint

CREATE FUNCTION billing.admit_payment_transport(p_payment uuid,p_billing_org uuid,p_connection uuid,p_processor text,p_adapter text,p_origin text,p_authority text,
 p_phase text,p_binding uuid,p_identity text,p_binding_sha text,p_attempt uuid,p_customer_token uuid)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE prior text:=current_setting('billing.payment_org',true);org_id uuid:=app.current_organization_id();actual record;b record;attempt record;
BEGIN
 IF session_user<>'ensemus_app' OR app.current_actor_type() IS DISTINCT FROM 'service' OR org_id IS NULL OR p_phase IS NULL
  OR p_phase NOT IN('identity','customer','customer_lookup','charge','lookup') THEN RAISE EXCEPTION 'PAYMENT_EXECUTION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 PERFORM set_config('billing.payment_org',org_id::text,true);
 SELECT * INTO actual FROM billing.payment_execution_preflight(p_payment,p_billing_org,p_connection,p_processor,p_adapter,p_origin);
 IF actual."authoritySha256" IS DISTINCT FROM p_authority THEN RAISE EXCEPTION 'PAYMENT_EXECUTION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 IF p_phase<>'identity' THEN
  SELECT x.* INTO b FROM billing.payment_execution_bindings x WHERE x.organization_id=org_id AND x.payment_id=p_payment AND x.id=p_binding FOR UPDATE NOWAIT;
  IF b.id IS NULL OR b.authority_sha256 IS DISTINCT FROM p_authority OR b.identity_sha256 IS DISTINCT FROM p_identity OR b.binding_sha256 IS DISTINCT FROM p_binding_sha THEN
   RAISE EXCEPTION 'PAYMENT_EXECUTION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
  IF p_phase IN('customer','charge') AND NOT EXISTS(SELECT 1 FROM billing.payment_identity_attestations x
   WHERE x.organization_id=org_id AND x.payment_id=p_payment AND x.consumed_binding_id=b.id AND x.expires_at>clock_timestamp()
    AND x.authority_sha256=b.authority_sha256 AND x.identity_sha256=b.identity_sha256) THEN
   RAISE EXCEPTION 'PAYMENT_NATIVE_IDENTITY_REQUIRED' USING ERRCODE='EN850';END IF;
  IF p_phase='customer' THEN
   IF b.customer_state<>'sending' OR b.customer_token IS DISTINCT FROM p_customer_token OR p_customer_token IS NULL
    OR b.customer_transport_started_at IS NOT NULL THEN RAISE EXCEPTION 'PAYMENT_CUSTOMER_ALREADY_DISPATCHED' USING ERRCODE='EN850';END IF;
   UPDATE billing.payment_execution_bindings SET customer_transport_started_at=clock_timestamp() WHERE organization_id=org_id AND id=b.id;
  ELSIF p_phase='customer_lookup' THEN
   IF b.customer_state NOT IN('sending','unknown') OR b.customer_token IS DISTINCT FROM p_customer_token OR p_customer_token IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_EXECUTION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
  ELSE
   SELECT x.id,x.transport_started_at INTO attempt FROM billing.payment_attempts x WHERE x.organization_id=org_id AND x.payment_id=p_payment
    AND x.id=p_attempt AND x.execution_binding_id=b.id FOR UPDATE NOWAIT;
   IF attempt.id IS NULL THEN RAISE EXCEPTION 'PAYMENT_EXECUTION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
   IF p_phase='charge' THEN
    IF attempt.transport_started_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM billing.payments p
     WHERE p.organization_id=org_id AND p.id=p_payment AND p.status='sending') THEN
     RAISE EXCEPTION 'PAYMENT_ATTEMPT_ALREADY_DISPATCHED' USING ERRCODE='EN850';END IF;
    UPDATE billing.payment_attempts SET transport_started_at=clock_timestamp() WHERE organization_id=org_id AND id=attempt.id;
   ELSIF p_phase='lookup' THEN
    UPDATE billing.payment_attempts SET lookup_started_at=coalesce(lookup_started_at,clock_timestamp()) WHERE organization_id=org_id AND id=attempt.id;
   END IF;
  END IF;
 END IF;
 PERFORM set_config('billing.payment_org',coalesce(prior,''),true);RETURN true;
EXCEPTION WHEN OTHERS THEN PERFORM set_config('billing.payment_org',coalesce(prior,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION billing.admit_payment_transport(uuid,uuid,uuid,text,text,text,text,text,uuid,text,text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing.admit_payment_transport(uuid,uuid,uuid,text,text,text,text,text,uuid,text,text,uuid,uuid) TO ensemus_app;
--> statement-breakpoint

CREATE FUNCTION billing.check_payment_execution_attempt() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE prior text:=current_setting('billing.payment_org',true);b record;actual record;
BEGIN
 IF TG_RELID<>'billing.payment_attempts'::regclass OR TG_OP NOT IN('INSERT','UPDATE') THEN
  RAISE EXCEPTION 'PAYMENT_EXECUTION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 IF TG_OP='UPDATE' THEN
  IF NEW.execution_binding_id IS NOT NULL AND NEW.outcome IN('succeeded','declined') AND NEW.transport_started_at IS NULL AND NEW.lookup_started_at IS NULL THEN
   RAISE EXCEPTION 'PAYMENT_TRANSPORT_UNCONFIRMED' USING ERRCODE='EN850';END IF;
  IF NEW.execution_binding_id IS DISTINCT FROM OLD.execution_binding_id OR(OLD.lookup_started_at IS NOT NULL AND NEW.lookup_started_at IS DISTINCT FROM OLD.lookup_started_at)
    OR(NEW.lookup_started_at IS DISTINCT FROM OLD.lookup_started_at AND current_setting('billing.payment_org',true) IS DISTINCT FROM NEW.organization_id::text) OR(OLD.transport_started_at IS NOT NULL
    AND NEW.transport_started_at IS DISTINCT FROM OLD.transport_started_at)
    OR(NEW.transport_started_at IS DISTINCT FROM OLD.transport_started_at AND current_setting('billing.payment_org',true) IS DISTINCT FROM NEW.organization_id::text) THEN
   RAISE EXCEPTION 'PAYMENT_EXECUTION_IMMUTABLE' USING ERRCODE='EN850';END IF;
  RETURN NEW;
 END IF;
 IF session_user<>'ensemus_app' OR app.current_actor_type() IS DISTINCT FROM 'service'
  OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() OR NEW.execution_binding_id IS NULL OR NEW.transport_started_at IS NOT NULL OR NEW.lookup_started_at IS NOT NULL THEN
  RAISE EXCEPTION 'PAYMENT_NATIVE_IDENTITY_REQUIRED' USING ERRCODE='EN850';END IF;
 PERFORM set_config('billing.payment_org',NEW.organization_id::text,true);
 SELECT x.* INTO b FROM billing.payment_execution_bindings x
  WHERE x.organization_id=NEW.organization_id AND x.payment_id=NEW.payment_id AND x.id=NEW.execution_binding_id FOR SHARE NOWAIT;
 IF b.id IS NULL OR b.customer_state<>'confirmed' OR NOT EXISTS(
   SELECT 1 FROM billing.billing_accounts a JOIN billing.payment_customer_bindings c ON c.organization_id=a.organization_id AND c.account_id=a.id
    WHERE a.organization_id=NEW.organization_id AND a.processor=b.processor AND a.processor_account_namespace_sha256=b.account_namespace_sha256
     AND a.customer_ref_hash=b.customer_ref_hash AND c.processor=b.processor AND c.account_namespace_sha256=b.account_namespace_sha256 AND c.customer_ref_hash=b.customer_ref_hash
  ) OR NOT EXISTS(SELECT 1 FROM billing.payment_identity_attestations a WHERE a.organization_id=NEW.organization_id
   AND a.payment_id=NEW.payment_id AND a.consumed_binding_id=b.id AND a.expires_at>clock_timestamp()
   AND a.authority_sha256=b.authority_sha256 AND a.identity_sha256=b.identity_sha256) THEN
  RAISE EXCEPTION 'PAYMENT_NATIVE_IDENTITY_REQUIRED' USING ERRCODE='EN850';END IF;
 SELECT * INTO actual FROM billing.payment_connection_snapshot(b.billing_organization_id,b.connection_id,b.processor,b.adapter_version,b.api_origin);
 IF actual."authoritySha256" IS DISTINCT FROM b.authority_sha256 THEN RAISE EXCEPTION 'PAYMENT_EXECUTION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 PERFORM set_config('billing.payment_org',coalesce(prior,''),true);RETURN NEW;
EXCEPTION WHEN OTHERS THEN PERFORM set_config('billing.payment_org',coalesce(prior,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION billing.check_payment_execution_attempt() FROM PUBLIC;
CREATE TRIGGER payment_attempt_execution_guard BEFORE INSERT OR UPDATE ON billing.payment_attempts FOR EACH ROW EXECUTE FUNCTION billing.check_payment_execution_attempt();

CREATE FUNCTION billing.keep_payment_identity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_RELID<>'billing.payment_identity_attestations'::regclass OR TG_OP<>'UPDATE' OR current_user<>'ensemus_migrator'
  OR session_user<>'ensemus_app' OR app.current_actor_type() IS DISTINCT FROM 'service'
  OR OLD.consumed_binding_id IS NOT NULL OR NEW.consumed_binding_id IS NULL
  OR(to_jsonb(NEW)-'consumed_binding_id') IS DISTINCT FROM(to_jsonb(OLD)-'consumed_binding_id') THEN
  RAISE EXCEPTION 'PAYMENT_NATIVE_IDENTITY_IMMUTABLE' USING ERRCODE='EN850';END IF;
 IF NOT EXISTS(SELECT 1 FROM billing.payment_execution_bindings b WHERE b.organization_id=NEW.organization_id AND b.id=NEW.consumed_binding_id
  AND b.payment_id=NEW.payment_id AND b.authority_sha256=NEW.authority_sha256 AND b.identity_sha256=NEW.identity_sha256 AND b.account_namespace_sha256=NEW.account_namespace_sha256) THEN
  RAISE EXCEPTION 'PAYMENT_NATIVE_IDENTITY_IMMUTABLE' USING ERRCODE='EN850';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION billing.keep_payment_identity() FROM PUBLIC;
CREATE TRIGGER payment_identity_change BEFORE UPDATE ON billing.payment_identity_attestations FOR EACH ROW EXECUTE FUNCTION billing.keep_payment_identity();

CREATE FUNCTION billing.keep_payment_execution() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_RELID<>'billing.payment_execution_bindings'::regclass OR TG_OP<>'UPDATE' OR current_user<>'ensemus_migrator'
  OR session_user<>'ensemus_app' OR app.current_actor_type() IS DISTINCT FROM 'service'
  OR(to_jsonb(NEW)-ARRAY['customer_state','customer_token','customer_ref_hash','customer_started_at','customer_transport_started_at','customer_finished_at'])
   IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['customer_state','customer_token','customer_ref_hash','customer_started_at','customer_transport_started_at','customer_finished_at'])
  OR(OLD.customer_token IS NOT NULL AND NEW.customer_token IS DISTINCT FROM OLD.customer_token)
  OR(OLD.customer_started_at IS NOT NULL AND NEW.customer_started_at IS DISTINCT FROM OLD.customer_started_at)
  OR(OLD.customer_transport_started_at IS NOT NULL AND NEW.customer_transport_started_at IS DISTINCT FROM OLD.customer_transport_started_at)
  OR(OLD.customer_state='confirmed' AND NEW IS DISTINCT FROM OLD)
  OR NOT((OLD.customer_state='new' AND NEW.customer_state IN('sending','confirmed'))
    OR(OLD.customer_state='sending' AND NEW.customer_state IN('sending','unknown','confirmed'))
    OR(OLD.customer_state='unknown' AND NEW.customer_state IN('unknown','confirmed'))) THEN
  RAISE EXCEPTION 'PAYMENT_EXECUTION_IMMUTABLE' USING ERRCODE='EN850';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION billing.keep_payment_execution() FROM PUBLIC;
CREATE TRIGGER payment_execution_change BEFORE UPDATE ON billing.payment_execution_bindings FOR EACH ROW EXECUTE FUNCTION billing.keep_payment_execution();

CREATE FUNCTION billing.guard_customer_execution() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_RELID<>'billing.billing_accounts'::regclass OR TG_OP NOT IN('INSERT','UPDATE') THEN
  RAISE EXCEPTION 'PAYMENT_CUSTOMER_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 IF(TG_OP='INSERT' AND NEW.processor_account_namespace_sha256 IS NOT NULL)
  OR(TG_OP='UPDATE' AND NEW.processor_account_namespace_sha256 IS DISTINCT FROM OLD.processor_account_namespace_sha256 AND current_user<>'ensemus_migrator') THEN
  RAISE EXCEPTION 'PAYMENT_CUSTOMER_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION billing.guard_customer_execution() FROM PUBLIC;
CREATE TRIGGER billing_account_execution BEFORE INSERT OR UPDATE ON billing.billing_accounts FOR EACH ROW EXECUTE FUNCTION billing.guard_customer_execution();
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['payment_identity_attestations','payment_execution_bindings','payment_customer_bindings'] LOOP
  EXECUTE format('CREATE TRIGGER payment_evidence_keep BEFORE DELETE OR TRUNCATE ON billing.%I FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change()',t);
 END LOOP;
END $$;
CREATE TRIGGER payment_customer_binding_keep BEFORE UPDATE ON billing.payment_customer_bindings FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();

--> statement-breakpoint
-- Financial control evidence: IDs and immutable hashes only, no webhook body, account reference or config.
-- It retains the originating native attestation/execution lineage; erasure must not discard it as a cache.
CREATE TABLE billing.payment_webhook_bindings (
 organization_id uuid NOT NULL,endpoint_id uuid NOT NULL,origin_organization_id uuid NOT NULL,execution_binding_id uuid NOT NULL,
 connection_id uuid NOT NULL,connection_version bigint NOT NULL,credential_secret_id uuid NOT NULL,signing_secret_id uuid NOT NULL,
 processor text NOT NULL,adapter_version text NOT NULL,api_origin text NOT NULL,config_sha256 text NOT NULL,
 authority_sha256 text NOT NULL,identity_sha256 text NOT NULL,account_namespace_sha256 text NOT NULL,binding_sha256 text NOT NULL,qualified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT payment_webhook_binding_pk PRIMARY KEY(organization_id,endpoint_id),
 CONSTRAINT payment_webhook_binding_endpoint FOREIGN KEY(organization_id,endpoint_id) REFERENCES integrations.webhook_endpoints(organization_id,id),
 CONSTRAINT payment_webhook_binding_execution FOREIGN KEY(origin_organization_id,execution_binding_id) REFERENCES billing.payment_execution_bindings(organization_id,id),
 CONSTRAINT payment_webhook_binding_connection FOREIGN KEY(organization_id,connection_id) REFERENCES integrations.connections(organization_id,id),
 CONSTRAINT payment_webhook_binding_credential FOREIGN KEY(organization_id,credential_secret_id) REFERENCES secrets.sealed_secrets(organization_id,id),
 CONSTRAINT payment_webhook_binding_signing FOREIGN KEY(organization_id,signing_secret_id) REFERENCES secrets.sealed_secrets(organization_id,id),
 CONSTRAINT payment_webhook_binding_hashes CHECK(config_sha256 ~ '^[0-9a-f]{64}$' AND authority_sha256 ~ '^[0-9a-f]{64}$'
  AND identity_sha256 ~ '^[0-9a-f]{64}$' AND account_namespace_sha256 ~ '^[0-9a-f]{64}$' AND binding_sha256 ~ '^[0-9a-f]{64}$')
);
ALTER TABLE billing.payment_webhook_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.payment_webhook_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_fixed_owner ON billing.payment_webhook_bindings TO ensemus_migrator
 USING(organization_id::text=current_setting('billing.payment_org',true)) WITH CHECK(organization_id::text=current_setting('billing.payment_org',true));
REVOKE ALL ON billing.payment_webhook_bindings FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_eraser,ensemus_secrets;
CREATE TRIGGER payment_webhook_binding_keep BEFORE UPDATE OR DELETE OR TRUNCATE ON billing.payment_webhook_bindings FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
CREATE POLICY payment_endpoint_metadata ON integrations.webhook_endpoints FOR SELECT TO ensemus_migrator
 USING(organization_id::text=current_setting('billing.payment_control_org',true));
CREATE POLICY payment_endpoint_lock ON integrations.webhook_endpoints FOR UPDATE TO ensemus_migrator
 USING(organization_id::text=current_setting('billing.payment_control_org',true)) WITH CHECK(false);
CREATE POLICY payment_delivery_metadata ON integrations.webhook_deliveries FOR SELECT TO ensemus_migrator
 USING(organization_id::text=current_setting('billing.payment_control_org',true));
-- Endpoint pinning consumes no new provider call and cannot choose/refresh native identity. It requires a
-- fresh secrets-role attestation already consumed into this exact original execution, after actual I/O.
CREATE FUNCTION billing.qualify_payment_webhook(p_origin_org uuid,p_payment uuid,p_binding uuid,p_endpoint uuid)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE prior text:=current_setting('billing.payment_org',true);control_prior text:=current_setting('billing.payment_control_org',true);
 org_id uuid:=app.current_organization_id();b record;e record;actual record;existing record;
BEGIN
 IF session_user<>'ensemus_app' OR app.current_actor_type() IS DISTINCT FROM 'service' OR org_id IS NULL THEN
  RAISE EXCEPTION 'PAYMENT_EXECUTION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 PERFORM set_config('billing.payment_org',p_origin_org::text,true);
 SELECT x.* INTO b FROM billing.payment_execution_bindings x WHERE x.organization_id=p_origin_org AND x.payment_id=p_payment AND x.id=p_binding FOR SHARE NOWAIT;
 IF b.id IS NULL OR b.billing_organization_id IS DISTINCT FROM org_id OR NOT EXISTS(
  SELECT 1 FROM billing.payment_identity_attestations a WHERE a.organization_id=p_origin_org AND a.payment_id=p_payment
   AND a.consumed_binding_id=b.id AND a.expires_at>clock_timestamp() AND a.authority_sha256=b.authority_sha256 AND a.identity_sha256=b.identity_sha256) THEN
  RAISE EXCEPTION 'PAYMENT_NATIVE_IDENTITY_REQUIRED' USING ERRCODE='EN850';END IF;
 SELECT * INTO actual FROM billing.payment_connection_snapshot(org_id,b.connection_id,b.processor,b.adapter_version,b.api_origin);
 IF actual."authoritySha256" IS DISTINCT FROM b.authority_sha256 THEN RAISE EXCEPTION 'PAYMENT_EXECUTION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 PERFORM set_config('billing.payment_control_org',org_id::text,true);
 SELECT x.id,x.connection_id,x.state,x.signing_secret_id INTO e FROM integrations.webhook_endpoints x
  WHERE x.organization_id=org_id AND x.id=p_endpoint FOR SHARE NOWAIT;
 IF e.id IS NULL OR e.state<>'active' OR e.connection_id IS DISTINCT FROM b.connection_id THEN
  RAISE EXCEPTION 'PAYMENT_EXECUTION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 PERFORM s.id FROM secrets.sealed_secrets s WHERE s.organization_id=org_id AND s.id=e.signing_secret_id
  AND s.revoked_at IS NULL AND s.purpose='webhook_signing' FOR SHARE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_EXECUTION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 PERFORM set_config('billing.payment_org',org_id::text,true);
 SELECT x.* INTO existing FROM billing.payment_webhook_bindings x WHERE x.organization_id=org_id AND x.endpoint_id=p_endpoint;
 IF existing.endpoint_id IS NOT NULL THEN
  IF existing.authority_sha256 IS DISTINCT FROM b.authority_sha256 OR existing.identity_sha256 IS DISTINCT FROM b.identity_sha256
   OR existing.signing_secret_id IS DISTINCT FROM e.signing_secret_id THEN
   RAISE EXCEPTION 'PAYMENT_WEBHOOK_REQUALIFICATION_REQUIRED' USING ERRCODE='EN850';END IF;
 ELSE
  INSERT INTO billing.payment_webhook_bindings(organization_id,endpoint_id,origin_organization_id,execution_binding_id,connection_id,connection_version,
   credential_secret_id,signing_secret_id,processor,adapter_version,api_origin,config_sha256,authority_sha256,identity_sha256,account_namespace_sha256,binding_sha256)
   VALUES(org_id,p_endpoint,p_origin_org,b.id,b.connection_id,b.connection_version,b.credential_secret_id,e.signing_secret_id,b.processor,b.adapter_version,
    b.api_origin,b.config_sha256,b.authority_sha256,b.identity_sha256,b.account_namespace_sha256,b.binding_sha256);
 END IF;
 PERFORM set_config('billing.payment_org',coalesce(prior,''),true);PERFORM set_config('billing.payment_control_org',coalesce(control_prior,''),true);RETURN true;
EXCEPTION WHEN OTHERS THEN
 PERFORM set_config('billing.payment_org',coalesce(prior,''),true);PERFORM set_config('billing.payment_control_org',coalesce(control_prior,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION billing.qualify_payment_webhook(uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing.qualify_payment_webhook(uuid,uuid,uuid,uuid) TO ensemus_app;

CREATE FUNCTION billing.capture_payment_webhook(p_delivery uuid,p_endpoint uuid,p_connection uuid,p_processor text,p_observed_namespace text)
 RETURNS TABLE("connectionVersion" text,"credentialSecretId" uuid,"configSha256" text,"identitySha256" text,"accountNamespaceSha256" text,"bindingSha256" text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE prior text:=current_setting('billing.payment_org',true);control_prior text:=current_setting('billing.payment_control_org',true);
 org_id uuid:=app.current_organization_id();pin record;e record;delivery record;
BEGIN
 IF session_user<>'ensemus_app' OR app.current_actor_type() IS DISTINCT FROM 'service' OR org_id IS NULL THEN
  RAISE EXCEPTION 'PAYMENT_EXECUTION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 PERFORM set_config('billing.payment_org',org_id::text,true);PERFORM set_config('billing.payment_control_org',org_id::text,true);
 SELECT x.* INTO pin FROM billing.payment_webhook_bindings x WHERE x.organization_id=org_id AND x.endpoint_id=p_endpoint;
 -- Missing native observation or an unqualified endpoint is a retained unmatched event, never a guessed route.
 IF pin.endpoint_id IS NOT NULL AND pin.connection_id=p_connection AND pin.processor=p_processor AND pin.account_namespace_sha256=p_observed_namespace THEN
  SELECT x.id,x.state,x.connection_id,x.signing_secret_id,x.previous_signing_secret_id,x.previous_secret_valid_until INTO e FROM integrations.webhook_endpoints x
   WHERE x.organization_id=org_id AND x.id=p_endpoint FOR SHARE NOWAIT;
  SELECT d.id,d.received_at INTO delivery FROM integrations.webhook_deliveries d
   WHERE d.organization_id=org_id AND d.id=p_delivery AND d.endpoint_id=p_endpoint AND d.state='received';
  IF e.id IS NULL OR delivery.id IS NULL OR e.state<>'active' OR e.connection_id IS DISTINCT FROM pin.connection_id
   OR(e.signing_secret_id=pin.signing_secret_id OR(e.previous_signing_secret_id=pin.signing_secret_id
    AND e.previous_secret_valid_until IS NOT NULL AND e.previous_secret_valid_until>=delivery.received_at)) IS NOT TRUE THEN
   RAISE EXCEPTION 'PAYMENT_EXECUTION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
  PERFORM s.id FROM secrets.sealed_secrets s WHERE s.organization_id=org_id AND s.id=pin.signing_secret_id
   AND s.revoked_at IS NULL AND s.purpose='webhook_signing' FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_EXECUTION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
  -- Receipt-only exception: no API credential is lent, replaced or consulted, and no execution is admitted.
  -- The original active endpoint/signing lineage and observed signed merchant remain mandatory.
  PERFORM c.id FROM integrations.connections c WHERE c.organization_id=org_id AND c.id=p_connection
   AND c.state='active' AND c.connector_type='payment_'||pin.processor FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_EXECUTION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
  RETURN QUERY SELECT pin.connection_version::text,pin.credential_secret_id,pin.config_sha256,pin.identity_sha256,pin.account_namespace_sha256,pin.binding_sha256;
 END IF;
 PERFORM set_config('billing.payment_org',coalesce(prior,''),true);PERFORM set_config('billing.payment_control_org',coalesce(control_prior,''),true);
EXCEPTION WHEN OTHERS THEN
 PERFORM set_config('billing.payment_org',coalesce(prior,''),true);PERFORM set_config('billing.payment_control_org',coalesce(control_prior,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION billing.capture_payment_webhook(uuid,uuid,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing.capture_payment_webhook(uuid,uuid,uuid,text,text) TO ensemus_app;

--> statement-breakpoint
ALTER TABLE billing.payment_webhook_events DROP CONSTRAINT payment_webhook_events_provider;
CREATE UNIQUE INDEX payment_webhook_events_provider ON billing.payment_webhook_events(organization_id,processor,account_namespace_sha256,provider_event_id)
 WHERE account_namespace_sha256 IS NOT NULL;
CREATE UNIQUE INDEX payment_webhook_events_unqualified_delivery ON billing.payment_webhook_events(organization_id,source_delivery_id)
 WHERE account_namespace_sha256 IS NULL AND source_delivery_id IS NOT NULL;
CREATE UNIQUE INDEX payment_webhook_events_legacy_provider ON billing.payment_webhook_events(organization_id,processor,provider_event_id)
 WHERE account_namespace_sha256 IS NULL AND source_delivery_id IS NULL;
CREATE POLICY payment_event_metadata ON billing.payment_webhook_events FOR SELECT TO ensemus_migrator
 USING(organization_id::text=current_setting('billing.payment_org',true));
CREATE POLICY payment_customer_route_metadata ON billing.payment_customer_bindings FOR SELECT TO ensemus_migrator
 USING(processor=current_setting('billing.payment_route_processor',true) AND account_namespace_sha256=current_setting('billing.payment_route_identity',true)
  AND customer_ref_hash=current_setting('billing.payment_route_customer',true));
CREATE POLICY payment_target_account_metadata ON billing.billing_accounts FOR SELECT TO ensemus_migrator
 USING(organization_id::text=current_setting('billing.payment_target_org',true) AND id::text=current_setting('billing.payment_target_account',true));

CREATE FUNCTION billing.guard_payment_webhook_identity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE proof record;
BEGIN
 IF TG_RELID<>'billing.payment_webhook_events'::regclass OR TG_OP NOT IN('INSERT','UPDATE') THEN
  RAISE EXCEPTION 'PAYMENT_WEBHOOK_IDENTITY_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 IF TG_OP='UPDATE' THEN
  IF(to_jsonb(NEW)-ARRAY['state','target_organization_id','processed_at']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['state','target_organization_id','processed_at']) THEN
   RAISE EXCEPTION 'PAYMENT_WEBHOOK_IDENTITY_IMMUTABLE' USING ERRCODE='EN850';END IF;
  RETURN NEW;
 END IF;
 IF session_user<>'ensemus_app' OR app.current_actor_type() IS DISTINCT FROM 'service' OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN
  RAISE EXCEPTION 'PAYMENT_WEBHOOK_IDENTITY_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 -- Unqualified historical/native-unsupported events may be retained, but can never acquire a later route.
 IF NEW.execution_identity_sha256 IS NULL THEN
  IF NEW.account_namespace_sha256 IS NOT NULL OR NEW.execution_binding_sha256 IS NOT NULL OR NEW.source_connection_version IS NOT NULL OR NEW.source_api_secret_id IS NOT NULL OR NEW.source_config_sha256 IS NOT NULL THEN
   RAISE EXCEPTION 'PAYMENT_WEBHOOK_IDENTITY_UNCONFIRMED' USING ERRCODE='EN850';END IF;
  RETURN NEW;
 END IF;
 IF NEW.source_delivery_id IS NULL OR NEW.source_endpoint_id IS NULL OR NEW.source_connection_id IS NULL THEN
  RAISE EXCEPTION 'PAYMENT_WEBHOOK_IDENTITY_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 SELECT * INTO proof FROM billing.capture_payment_webhook(NEW.source_delivery_id,NEW.source_endpoint_id,NEW.source_connection_id,NEW.processor,NEW.account_namespace_sha256);
 IF proof."identitySha256" IS NULL OR NEW.execution_identity_sha256 IS DISTINCT FROM proof."identitySha256"
  OR NEW.execution_binding_sha256 IS DISTINCT FROM proof."bindingSha256"
  OR NEW.account_namespace_sha256 IS DISTINCT FROM proof."accountNamespaceSha256"
  OR NEW.source_connection_version::text IS DISTINCT FROM proof."connectionVersion" OR NEW.source_api_secret_id IS DISTINCT FROM proof."credentialSecretId"
  OR NEW.source_config_sha256 IS DISTINCT FROM proof."configSha256" THEN
  RAISE EXCEPTION 'PAYMENT_WEBHOOK_IDENTITY_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION billing.guard_payment_webhook_identity() FROM PUBLIC;
CREATE TRIGGER payment_webhook_identity BEFORE INSERT OR UPDATE ON billing.payment_webhook_events FOR EACH ROW EXECUTE FUNCTION billing.guard_payment_webhook_identity();

CREATE FUNCTION billing.payment_webhook_delivery_committed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE prior text:=current_setting('billing.payment_control_org',true);
BEGIN
 IF TG_RELID<>'billing.payment_webhook_events'::regclass OR TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PAYMENT_WEBHOOK_IDENTITY_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 IF NEW.execution_identity_sha256 IS NULL THEN RETURN NULL;END IF;
 PERFORM set_config('billing.payment_control_org',NEW.organization_id::text,true);
 IF NOT EXISTS(SELECT 1 FROM integrations.webhook_deliveries d WHERE d.organization_id=NEW.organization_id AND d.id=NEW.source_delivery_id
  AND d.endpoint_id=NEW.source_endpoint_id AND d.provider_event_id=NEW.provider_event_id AND d.state='applied') THEN
  RAISE EXCEPTION 'PAYMENT_WEBHOOK_DELIVERY_UNCOMMITTED' USING ERRCODE='EN850';END IF;
 PERFORM set_config('billing.payment_control_org',coalesce(prior,''),true);RETURN NULL;
EXCEPTION WHEN OTHERS THEN PERFORM set_config('billing.payment_control_org',coalesce(prior,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION billing.payment_webhook_delivery_committed() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER payment_webhook_delivery_committed AFTER INSERT ON billing.payment_webhook_events
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION billing.payment_webhook_delivery_committed();

-- Exact event -> original merchant/customer namespace. No arbitrary tenant/hash/body selector.
CREATE FUNCTION billing.payment_customer_event_route(p_event uuid)
 RETURNS TABLE("organizationId" uuid,"accountId" uuid,"paymentId" uuid,"executionBindingId" uuid,processor text,"providerEventId" text,"customerRefHash" text,"accountNamespaceSha256" text,"identitySha256" text,"bindingSha256" text,"webhookBindingSha256" text) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE prior text:=current_setting('billing.payment_org',true);processor_prior text:=current_setting('billing.payment_route_processor',true);
 identity_prior text:=current_setting('billing.payment_route_identity',true);customer_prior text:=current_setting('billing.payment_route_customer',true);
 target_prior text:=current_setting('billing.payment_target_org',true);account_prior text:=current_setting('billing.payment_target_account',true);
 org_id uuid:=app.current_organization_id();e record;pin record;customer record;a record;payment_ids uuid[];original record;
BEGIN
 IF session_user<>'ensemus_app' OR app.current_actor_type() IS DISTINCT FROM 'service' OR org_id IS NULL THEN
  RAISE EXCEPTION 'PAYMENT_WEBHOOK_IDENTITY_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 PERFORM set_config('billing.payment_org',org_id::text,true);
 SELECT x.id,x.processor,x.provider_event_id,x.payment_id,x.processor_payment_ref,x.customer_ref_hash,x.execution_identity_sha256,x.account_namespace_sha256,x.execution_binding_sha256,x.source_endpoint_id INTO e
  FROM billing.payment_webhook_events x WHERE x.organization_id=org_id AND x.id=p_event;
 IF e.id IS NOT NULL AND e.execution_identity_sha256 IS NOT NULL AND e.execution_binding_sha256 IS NOT NULL THEN
  SELECT x.endpoint_id INTO pin FROM billing.payment_webhook_bindings x WHERE x.organization_id=org_id AND x.endpoint_id=e.source_endpoint_id
   AND x.processor=e.processor AND x.account_namespace_sha256=e.account_namespace_sha256
   AND x.identity_sha256=e.execution_identity_sha256 AND x.binding_sha256=e.execution_binding_sha256;
  IF pin.endpoint_id IS NOT NULL THEN
   PERFORM set_config('billing.payment_route_processor',e.processor,true);PERFORM set_config('billing.payment_route_identity',e.account_namespace_sha256,true);
   PERFORM set_config('billing.payment_route_customer',e.customer_ref_hash,true);
   SELECT x.organization_id,x.account_id INTO customer FROM billing.payment_customer_bindings x
    WHERE x.processor=e.processor AND x.account_namespace_sha256=e.account_namespace_sha256 AND x.customer_ref_hash=e.customer_ref_hash;
   IF customer.account_id IS NOT NULL THEN
    PERFORM set_config('billing.payment_target_org',customer.organization_id::text,true);PERFORM set_config('billing.payment_target_account',customer.account_id::text,true);
    SELECT x.id INTO a FROM billing.billing_accounts x WHERE x.organization_id=customer.organization_id AND x.id=customer.account_id
     AND x.processor=e.processor AND x.processor_account_namespace_sha256=e.account_namespace_sha256 AND x.customer_ref_hash=e.customer_ref_hash;
    IF a.id IS NOT NULL THEN
     PERFORM set_config('billing.payment_org',customer.organization_id::text,true);
     SELECT array_agg(candidate.id) INTO payment_ids FROM(
      SELECT p.id FROM billing.payments p JOIN billing.payment_execution_bindings b ON b.organization_id=p.organization_id AND b.payment_id=p.id
       WHERE p.organization_id=customer.organization_id AND p.processor=e.processor AND b.processor=e.processor
        AND b.account_namespace_sha256=e.account_namespace_sha256
        AND((e.payment_id IS NOT NULL AND p.id=e.payment_id) OR(e.payment_id IS NULL AND e.processor_payment_ref IS NOT NULL AND p.processor_payment_ref=e.processor_payment_ref))
       LIMIT 2) candidate;
     IF cardinality(payment_ids)=1 THEN
      SELECT b.id,b.identity_sha256,b.binding_sha256 INTO original FROM billing.payment_execution_bindings b
       WHERE b.organization_id=customer.organization_id AND b.payment_id=payment_ids[1] AND b.account_namespace_sha256=e.account_namespace_sha256;
      IF original.id IS NOT NULL THEN RETURN QUERY SELECT customer.organization_id,a.id,payment_ids[1],original.id,e.processor,e.provider_event_id,
        e.customer_ref_hash,e.account_namespace_sha256,original.identity_sha256,original.binding_sha256,e.execution_binding_sha256;END IF;
     END IF;
    END IF;
   END IF;
  END IF;
 END IF;
 PERFORM set_config('billing.payment_org',coalesce(prior,''),true);PERFORM set_config('billing.payment_route_processor',coalesce(processor_prior,''),true);
 PERFORM set_config('billing.payment_route_identity',coalesce(identity_prior,''),true);PERFORM set_config('billing.payment_route_customer',coalesce(customer_prior,''),true);
 PERFORM set_config('billing.payment_target_org',coalesce(target_prior,''),true);PERFORM set_config('billing.payment_target_account',coalesce(account_prior,''),true);
EXCEPTION WHEN OTHERS THEN
 PERFORM set_config('billing.payment_org',coalesce(prior,''),true);PERFORM set_config('billing.payment_route_processor',coalesce(processor_prior,''),true);
 PERFORM set_config('billing.payment_route_identity',coalesce(identity_prior,''),true);PERFORM set_config('billing.payment_route_customer',coalesce(customer_prior,''),true);
 PERFORM set_config('billing.payment_target_org',coalesce(target_prior,''),true);PERFORM set_config('billing.payment_target_account',coalesce(account_prior,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION billing.payment_customer_event_route(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing.payment_customer_event_route(uuid) TO ensemus_app;

--> statement-breakpoint
-- A GUC is a selector, never the right to mint a transport receipt. The invoker check distinguishes a
-- reviewed fixed metadata function from a direct app/agent UPDATE even if it forges every selector.
CREATE FUNCTION billing.guard_payment_transport_stamps() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_RELID<>'billing.payment_attempts'::regclass OR TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'PAYMENT_TRANSPORT_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 IF NEW.execution_binding_id IS DISTINCT FROM OLD.execution_binding_id OR(
  (NEW.transport_started_at IS DISTINCT FROM OLD.transport_started_at OR NEW.lookup_started_at IS DISTINCT FROM OLD.lookup_started_at)
   AND current_user<>'ensemus_migrator') THEN
  RAISE EXCEPTION 'PAYMENT_TRANSPORT_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION billing.guard_payment_transport_stamps() FROM PUBLIC;
CREATE TRIGGER payment_transport_stamps BEFORE UPDATE ON billing.payment_attempts FOR EACH ROW EXECUTE FUNCTION billing.guard_payment_transport_stamps();

--> statement-breakpoint
-- Applied financial facts retain both their stable provider account namespace and the exact verified
-- source/original execution. A credential/adapter/endpoint rotation cannot spend the same event twice.
ALTER TABLE billing.payment_events ADD COLUMN account_namespace_sha256 text,ADD COLUMN execution_binding_id uuid,ADD COLUMN execution_binding_sha256 text,ADD COLUMN source_execution_binding_sha256 text,
 ADD COLUMN source_webhook_organization_id uuid,ADD COLUMN source_webhook_event_id uuid;
ALTER TABLE billing.payment_events ADD CONSTRAINT payment_events_original_execution FOREIGN KEY(organization_id,payment_id,execution_binding_id)
 REFERENCES billing.payment_execution_bindings(organization_id,payment_id,id);
ALTER TABLE billing.payment_events ADD CONSTRAINT payment_events_verified_source FOREIGN KEY(source_webhook_organization_id,source_webhook_event_id)
 REFERENCES billing.payment_webhook_events(organization_id,id);
ALTER TABLE billing.payment_events DROP CONSTRAINT payment_events_provider;
ALTER TABLE billing.payment_events ADD CONSTRAINT payment_events_provider
 UNIQUE NULLS NOT DISTINCT(organization_id,processor,account_namespace_sha256,provider_event_id);
CREATE POLICY payment_applied_metadata ON billing.payment_events FOR SELECT TO ensemus_migrator
 USING(organization_id::text=current_setting('billing.payment_org',true));
CREATE FUNCTION billing.guard_payment_event_source() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE prior_org text:=current_setting('app.organization_id',true);prior_scope text:=current_setting('billing.payment_org',true);
 resolved record;source_event record;actual_payment record;
BEGIN
 IF TG_RELID<>'billing.payment_events'::regclass OR TG_OP<>'INSERT' OR session_user<>'ensemus_app'
  OR app.current_actor_type() IS DISTINCT FROM 'service' OR NEW.organization_id IS DISTINCT FROM app.current_organization_id()
  OR NEW.source_webhook_organization_id IS NULL OR NEW.source_webhook_event_id IS NULL OR NEW.account_namespace_sha256 IS NULL
  OR NEW.execution_binding_id IS NULL OR NEW.execution_binding_sha256 IS NULL OR NEW.source_execution_binding_sha256 IS NULL OR NEW.payment_id IS NULL THEN
  RAISE EXCEPTION 'PAYMENT_EVENT_SOURCE_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 -- Fixed receipt metadata only; never an arbitrary body/table selector or a provider request.
 PERFORM set_config('app.organization_id',NEW.source_webhook_organization_id::text,true);
 SELECT * INTO resolved FROM billing.payment_customer_event_route(NEW.source_webhook_event_id);
 IF resolved."organizationId" IS DISTINCT FROM NEW.organization_id OR resolved."paymentId" IS DISTINCT FROM NEW.payment_id
  OR resolved.processor IS DISTINCT FROM NEW.processor OR resolved."providerEventId" IS DISTINCT FROM NEW.provider_event_id
  OR resolved."accountNamespaceSha256" IS DISTINCT FROM NEW.account_namespace_sha256 OR resolved."bindingSha256" IS DISTINCT FROM NEW.execution_binding_sha256
  OR resolved."executionBindingId" IS DISTINCT FROM NEW.execution_binding_id OR resolved."webhookBindingSha256" IS DISTINCT FROM NEW.source_execution_binding_sha256 THEN
  RAISE EXCEPTION 'PAYMENT_EVENT_SOURCE_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 PERFORM set_config('billing.payment_org',NEW.source_webhook_organization_id::text,true);
 SELECT e.kind,e.amount_micros,e.currency,e.provider_occurred_at INTO source_event FROM billing.payment_webhook_events e
  WHERE e.organization_id=NEW.source_webhook_organization_id AND e.id=NEW.source_webhook_event_id;
 IF source_event.kind IS DISTINCT FROM NEW.kind OR source_event.amount_micros IS DISTINCT FROM NEW.amount_micros
  OR source_event.currency IS DISTINCT FROM NEW.currency OR source_event.provider_occurred_at IS DISTINCT FROM NEW.provider_occurred_at THEN
  RAISE EXCEPTION 'PAYMENT_EVENT_SOURCE_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 PERFORM set_config('app.organization_id',coalesce(prior_org,''),true);PERFORM set_config('billing.payment_org',NEW.organization_id::text,true);
 SELECT p.invoice_id INTO actual_payment FROM billing.payments p WHERE p.organization_id=NEW.organization_id AND p.id=NEW.payment_id;
 IF actual_payment.invoice_id IS DISTINCT FROM NEW.invoice_id OR EXISTS(SELECT 1 FROM billing.payment_events prior_event
  WHERE prior_event.organization_id=NEW.organization_id AND prior_event.processor=NEW.processor AND prior_event.provider_event_id=NEW.provider_event_id
   AND prior_event.account_namespace_sha256 IS NULL) THEN
  RAISE EXCEPTION 'PAYMENT_EVENT_LEGACY_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 NEW.applied_at:=clock_timestamp();
 PERFORM set_config('billing.payment_org',coalesce(prior_scope,''),true);RETURN NEW;
EXCEPTION WHEN OTHERS THEN
 PERFORM set_config('app.organization_id',coalesce(prior_org,''),true);PERFORM set_config('billing.payment_org',coalesce(prior_scope,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION billing.guard_payment_event_source() FROM PUBLIC;
CREATE TRIGGER payment_event_verified_source BEFORE INSERT ON billing.payment_events FOR EACH ROW EXECUTE FUNCTION billing.guard_payment_event_source();
