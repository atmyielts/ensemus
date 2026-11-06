-- ADR-031 D8 / ID-05. The pinned plugin expects one factor per account. Never resolve duplicates by
-- choosing/removing a secret: an operator must review the existing enrollment before upgrading.
-- The reviewed migration runner supplies the transaction. Block writers through the check/index.
LOCK TABLE identity.two_factors IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM identity.two_factors GROUP BY user_id HAVING count(*)>1) THEN
    RAISE EXCEPTION 'SECOND_FACTOR_DUPLICATES_REVIEW_REQUIRED' USING ERRCODE='EN402';
  END IF;
END $$;
CREATE UNIQUE INDEX two_factors_one_per_user ON identity.two_factors(user_id);
DROP INDEX identity.two_factors_user_idx;
--> statement-breakpoint

-- The plugin's enable path can otherwise UPDATE a competing unverified enrollment. Preserve the
-- first setup key as well as its row: confirmation and recovery-code rotation do not change secret.
-- A lost pending/active secret requires the existing reviewed operator reset, then new enrollment.
CREATE FUNCTION identity.preserve_second_factor_secret() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.secret IS DISTINCT FROM OLD.secret THEN
    RAISE EXCEPTION 'SECOND_FACTOR_SETUP_EXISTS' USING ERRCODE='EN403';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER two_factors_keep_secret BEFORE UPDATE OF secret ON identity.two_factors
  FOR EACH ROW EXECUTE FUNCTION identity.preserve_second_factor_secret();
