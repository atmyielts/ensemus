-- Platform email: account recovery, verification, invitations and notifications by email. Tables only.
-- Who may write them, and how a message may move, are in 0571, which is flagged for human security review.
-- No message text is stored: the mail worker renders each message when it sends it.
--
-- Two queues, because they belong to different owners. Account mail belongs to a person and has no
-- tenant, so it cannot sit in a table with an organization: every such table is tenant content, which the
-- eraser reaches and whose every new row must name the bound tenant (0501, 0518, 0533). Tenant mail is
-- tenant content, and goes when the tenant goes.

CREATE TABLE "platform"."account_mail_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"recipient_address" text,
	"recipient_sha256" text,
	"link_key_id" text,
	"link_wrapped_key" bytea,
	"link_iv" bytea,
	"link_ciphertext" bytea,
	"link_auth_tag" bytea,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"send_before" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"last_code" text,
	"provider_status" integer,
	"message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "account_mail_outbox_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "account_mail_outbox_kind" CHECK ("platform"."account_mail_outbox"."kind" in ('password_reset','email_verification','email_change_confirm','email_change_verify','password_changed')),
	CONSTRAINT "account_mail_outbox_status" CHECK ("platform"."account_mail_outbox"."status" in ('queued','sending','sent','failed','bounced','unknown','suppressed','expired','skipped')),
	CONSTRAINT "account_mail_outbox_idempotency_key_size" CHECK (char_length("platform"."account_mail_outbox"."idempotency_key") between 1 and 200),
	CONSTRAINT "account_mail_outbox_address" CHECK (
		"platform"."account_mail_outbox"."recipient_address" is null
		or (char_length("platform"."account_mail_outbox"."recipient_address") between 3 and 254
			and "platform"."account_mail_outbox"."recipient_address" !~ '[[:space:][:cntrl:]<>,;:"\\]')),
	CONSTRAINT "account_mail_outbox_recipient_sha256" CHECK ("platform"."account_mail_outbox"."recipient_sha256" ~ '^[0-9a-f]{64}$'),
	-- Every account message but the notice of a changed password carries a link, sealed to the worker.
	CONSTRAINT "account_mail_outbox_link_whole" CHECK (
		("platform"."account_mail_outbox"."link_ciphertext" is null) = ("platform"."account_mail_outbox"."link_key_id" is null)
		and ("platform"."account_mail_outbox"."link_ciphertext" is null) = ("platform"."account_mail_outbox"."link_wrapped_key" is null)
		and ("platform"."account_mail_outbox"."link_ciphertext" is null) = ("platform"."account_mail_outbox"."link_iv" is null)
		and ("platform"."account_mail_outbox"."link_ciphertext" is null) = ("platform"."account_mail_outbox"."link_auth_tag" is null)),
	CONSTRAINT "account_mail_outbox_link_size" CHECK (
		"platform"."account_mail_outbox"."link_ciphertext" is null or octet_length("platform"."account_mail_outbox"."link_ciphertext") <= 4096),
	-- A live token and the address it went to never outlive the message. 0571 erases them on settling.
	CONSTRAINT "account_mail_outbox_settled_clean" CHECK (
		"platform"."account_mail_outbox"."status" in ('queued','sending')
		or ("platform"."account_mail_outbox"."link_ciphertext" is null and "platform"."account_mail_outbox"."recipient_address" is null)),
	CONSTRAINT "account_mail_outbox_pending_address" CHECK (
		"platform"."account_mail_outbox"."status" not in ('queued','sending') or "platform"."account_mail_outbox"."recipient_address" is not null),
	CONSTRAINT "account_mail_outbox_attempts" CHECK ("platform"."account_mail_outbox"."attempts" between 0 and 6),
	CONSTRAINT "account_mail_outbox_last_code" CHECK (
		"platform"."account_mail_outbox"."last_code" is null or "platform"."account_mail_outbox"."last_code" ~ '^[A-Z][A-Z0-9_]{2,63}$'),
	CONSTRAINT "account_mail_outbox_provider_status" CHECK (
		"platform"."account_mail_outbox"."provider_status" is null or "platform"."account_mail_outbox"."provider_status" between 100 and 599),
	CONSTRAINT "account_mail_outbox_message_id" CHECK (
		"platform"."account_mail_outbox"."message_id" is null or "platform"."account_mail_outbox"."message_id" ~ '^<[A-Za-z0-9-]{1,64}@[A-Za-z0-9.-]{1,253}>$'),
	CONSTRAINT "account_mail_outbox_sent" CHECK (
		("platform"."account_mail_outbox"."status" = 'sent') = ("platform"."account_mail_outbox"."sent_at" is not null)),
	CONSTRAINT "account_mail_outbox_sending" CHECK (
		"platform"."account_mail_outbox"."status" <> 'sending' or "platform"."account_mail_outbox"."claimed_at" is not null),
	CONSTRAINT "account_mail_outbox_send_before" CHECK (
		"platform"."account_mail_outbox"."send_before" > "platform"."account_mail_outbox"."created_at"
		and "platform"."account_mail_outbox"."send_before" <= "platform"."account_mail_outbox"."created_at" + interval '1 day')
);
--> statement-breakpoint
CREATE TABLE "platform"."mail_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"recipient_membership_id" uuid,
	"recipient_address" text,
	"recipient_sha256" text,
	"notification_id" uuid,
	"notification_kind" text,
	"target_ref" text,
	"reminder_number" integer,
	"invitation_id" uuid,
	"link_key_id" text,
	"link_wrapped_key" bytea,
	"link_iv" bytea,
	"link_ciphertext" bytea,
	"link_auth_tag" bytea,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"send_before" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"last_code" text,
	"provider_status" integer,
	"message_id" text,
	"digest_id" uuid,
	"digest_due_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "mail_outbox_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "mail_outbox_kind" CHECK ("platform"."mail_outbox"."kind" in ('invitation','notification','digest')),
	CONSTRAINT "mail_outbox_status" CHECK ("platform"."mail_outbox"."status" in ('queued','sending','held','sent','failed','bounced','unknown','suppressed','expired','skipped','digested')),
	CONSTRAINT "mail_outbox_idempotency_key_size" CHECK (char_length("platform"."mail_outbox"."idempotency_key") between 1 and 200),
	-- An invitation goes to the address invited. Everything else goes to a member, looked up when sent.
	CONSTRAINT "mail_outbox_recipient" CHECK (
		("platform"."mail_outbox"."kind" = 'invitation') = ("platform"."mail_outbox"."recipient_membership_id" is null)),
	CONSTRAINT "mail_outbox_notification" CHECK (
		("platform"."mail_outbox"."kind" = 'notification')
		= ("platform"."mail_outbox"."notification_id" is not null and "platform"."mail_outbox"."notification_kind" is not null and "platform"."mail_outbox"."target_ref" is not null)),
	CONSTRAINT "mail_outbox_invitation" CHECK (
		("platform"."mail_outbox"."kind" = 'invitation') = ("platform"."mail_outbox"."invitation_id" is not null)),
	-- Only an invitation carries a link with a token in it.
	CONSTRAINT "mail_outbox_invitation_link" CHECK (
		"platform"."mail_outbox"."kind" = 'invitation' or "platform"."mail_outbox"."link_ciphertext" is null),
	CONSTRAINT "mail_outbox_address" CHECK (
		"platform"."mail_outbox"."recipient_address" is null
		or (char_length("platform"."mail_outbox"."recipient_address") between 3 and 254
			and "platform"."mail_outbox"."recipient_address" !~ '[[:space:][:cntrl:]<>,;:"\\]')),
	CONSTRAINT "mail_outbox_recipient_sha256" CHECK (
		"platform"."mail_outbox"."recipient_sha256" is null or "platform"."mail_outbox"."recipient_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "mail_outbox_notification_kind" CHECK (
		"platform"."mail_outbox"."notification_kind" is null or "platform"."mail_outbox"."notification_kind" ~ '^[a-z][a-z0-9_.]{0,127}$'),
	CONSTRAINT "mail_outbox_target_ref" CHECK (
		"platform"."mail_outbox"."target_ref" is null or char_length("platform"."mail_outbox"."target_ref") between 1 and 300),
	CONSTRAINT "mail_outbox_reminder_number" CHECK (
		"platform"."mail_outbox"."reminder_number" is null or "platform"."mail_outbox"."reminder_number" between 1 and 100),
	CONSTRAINT "mail_outbox_link_whole" CHECK (
		("platform"."mail_outbox"."link_ciphertext" is null) = ("platform"."mail_outbox"."link_key_id" is null)
		and ("platform"."mail_outbox"."link_ciphertext" is null) = ("platform"."mail_outbox"."link_wrapped_key" is null)
		and ("platform"."mail_outbox"."link_ciphertext" is null) = ("platform"."mail_outbox"."link_iv" is null)
		and ("platform"."mail_outbox"."link_ciphertext" is null) = ("platform"."mail_outbox"."link_auth_tag" is null)),
	CONSTRAINT "mail_outbox_link_size" CHECK (
		"platform"."mail_outbox"."link_ciphertext" is null or octet_length("platform"."mail_outbox"."link_ciphertext") <= 4096),
	CONSTRAINT "mail_outbox_settled_clean" CHECK (
		"platform"."mail_outbox"."status" in ('queued','sending','held')
		or ("platform"."mail_outbox"."link_ciphertext" is null and "platform"."mail_outbox"."recipient_address" is null)),
	CONSTRAINT "mail_outbox_attempts" CHECK ("platform"."mail_outbox"."attempts" between 0 and 6),
	CONSTRAINT "mail_outbox_last_code" CHECK (
		"platform"."mail_outbox"."last_code" is null or "platform"."mail_outbox"."last_code" ~ '^[A-Z][A-Z0-9_]{2,63}$'),
	CONSTRAINT "mail_outbox_provider_status" CHECK (
		"platform"."mail_outbox"."provider_status" is null or "platform"."mail_outbox"."provider_status" between 100 and 599),
	CONSTRAINT "mail_outbox_message_id" CHECK (
		"platform"."mail_outbox"."message_id" is null or "platform"."mail_outbox"."message_id" ~ '^<[A-Za-z0-9-]{1,64}@[A-Za-z0-9.-]{1,253}>$'),
	CONSTRAINT "mail_outbox_sent" CHECK (
		("platform"."mail_outbox"."status" = 'sent') = ("platform"."mail_outbox"."sent_at" is not null)),
	CONSTRAINT "mail_outbox_sending" CHECK (
		"platform"."mail_outbox"."status" <> 'sending' or "platform"."mail_outbox"."claimed_at" is not null),
	CONSTRAINT "mail_outbox_held" CHECK (
		"platform"."mail_outbox"."status" <> 'held' or "platform"."mail_outbox"."digest_due_at" is not null),
	CONSTRAINT "mail_outbox_digested" CHECK (
		("platform"."mail_outbox"."status" = 'digested') = ("platform"."mail_outbox"."digest_id" is not null)),
	CONSTRAINT "mail_outbox_send_before" CHECK (
		"platform"."mail_outbox"."send_before" > "platform"."mail_outbox"."created_at"
		and "platform"."mail_outbox"."send_before" <= "platform"."mail_outbox"."created_at" + interval '8 days')
);
--> statement-breakpoint
CREATE TABLE "platform"."mail_suppressions" (
	"address_sha256" text PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_suppressions_address_sha256" CHECK ("platform"."mail_suppressions"."address_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "mail_suppressions_reason" CHECK ("platform"."mail_suppressions"."reason" in ('RECIPIENT_REFUSED'))
);
--> statement-breakpoint
CREATE TABLE "platform"."mail_unsubscribe_tokens" (
	"token_sha256" text PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"topic" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_unsubscribe_tokens_token_sha256" CHECK ("platform"."mail_unsubscribe_tokens"."token_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "mail_unsubscribe_tokens_topic" CHECK ("platform"."mail_unsubscribe_tokens"."topic" in ('approvals','answers','billing','support','activity')),
	CONSTRAINT "mail_unsubscribe_tokens_expiry" CHECK (
		"platform"."mail_unsubscribe_tokens"."expires_at" > "platform"."mail_unsubscribe_tokens"."created_at"
		and "platform"."mail_unsubscribe_tokens"."expires_at" <= "platform"."mail_unsubscribe_tokens"."created_at" + interval '90 days')
);
--> statement-breakpoint
CREATE TABLE "org"."notification_preferences" (
	"organization_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"topic" text NOT NULL,
	"delivery" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_organization_id_membership_id_topic_pk" PRIMARY KEY("organization_id","membership_id","topic"),
	CONSTRAINT "notification_preferences_topic" CHECK ("org"."notification_preferences"."topic" in ('approvals','answers','billing','support','activity')),
	CONSTRAINT "notification_preferences_delivery" CHECK ("org"."notification_preferences"."delivery" in ('immediate','daily','off'))
);
--> statement-breakpoint
ALTER TABLE "platform"."mail_outbox" ADD CONSTRAINT "mail_outbox_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."mail_unsubscribe_tokens" ADD CONSTRAINT "mail_unsubscribe_tokens_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."notification_preferences" ADD CONSTRAINT "notification_preferences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."notification_preferences" ADD CONSTRAINT "notification_preferences_organization_id_membership_id_memberships_organization_id_id_fk" FOREIGN KEY ("organization_id","membership_id") REFERENCES "org"."memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_mail_outbox_due_idx" ON "platform"."account_mail_outbox" USING btree ("next_attempt_at") WHERE "platform"."account_mail_outbox"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "account_mail_outbox_sending_idx" ON "platform"."account_mail_outbox" USING btree ("claimed_at") WHERE "platform"."account_mail_outbox"."status" = 'sending';--> statement-breakpoint
CREATE INDEX "account_mail_outbox_recipient_idx" ON "platform"."account_mail_outbox" USING btree ("recipient_sha256","created_at");--> statement-breakpoint
CREATE INDEX "account_mail_outbox_settled_idx" ON "platform"."account_mail_outbox" USING btree ("updated_at") WHERE "platform"."account_mail_outbox"."status" not in ('queued','sending');--> statement-breakpoint
CREATE INDEX "mail_outbox_due_idx" ON "platform"."mail_outbox" USING btree ("next_attempt_at") WHERE "platform"."mail_outbox"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "mail_outbox_sending_idx" ON "platform"."mail_outbox" USING btree ("claimed_at") WHERE "platform"."mail_outbox"."status" = 'sending';--> statement-breakpoint
CREATE INDEX "mail_outbox_held_idx" ON "platform"."mail_outbox" USING btree ("digest_due_at") WHERE "platform"."mail_outbox"."status" = 'held';--> statement-breakpoint
CREATE INDEX "mail_outbox_settled_idx" ON "platform"."mail_outbox" USING btree ("updated_at") WHERE "platform"."mail_outbox"."status" not in ('queued','sending','held');--> statement-breakpoint
CREATE INDEX "mail_outbox_recipient_idx" ON "platform"."mail_outbox" USING btree ("recipient_sha256","created_at");--> statement-breakpoint
CREATE INDEX "mail_outbox_membership_idx" ON "platform"."mail_outbox" USING btree ("organization_id","recipient_membership_id","created_at");--> statement-breakpoint
CREATE INDEX "mail_outbox_organization_idx" ON "platform"."mail_outbox" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "mail_unsubscribe_tokens_member_idx" ON "platform"."mail_unsubscribe_tokens" USING btree ("organization_id","membership_id");
