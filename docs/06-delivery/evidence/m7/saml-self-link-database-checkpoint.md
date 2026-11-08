# SAML self-link database checkpoint

On 2026-11-08 the disposable `ensemus-m7-source-gate` database applied all 68 registered migrations
from a fresh, ownership-verified volume. The added migration is `0421_saml_self_link_authority.sql`.
The 14 real-role/native-resolver cases passed. They exercise genuine native-created source
accounts/sessions/passwords, explicit guarded selection and refusal paths; setup-owner fixtures
configure the generated provider. This does not qualify a live provider or the built browser flow.

The migration adds fixed functions, scoped policies and two ordered verification triggers. It adds
no table or modeled column. The snapshot retains the freshly audited 196-table model and chains to
0511. The live constraint-name audit found zero missing or renamed constraints. The strict active
portability inventory still matches all 198 installed platform tables, with zero missing or unknown
tables; private verification records remain excluded from portable credentials.

The auth-invoker trigger validates the immutable native source/session/primary tuple. The following
fixed owner trigger checks actual tenant/member/provider metadata and writes scope/finalization
stamps. Helper/owner-trigger execution is unavailable to auth, app and agent callers; actual auth
role TEMP/CREATE/TRIGGER restrictions and mutation refusals are tested. Native password verification
is a trusted configured-verifier operation. SQL revalidates captured fingerprints and locks; it does
not independently perform password verification.

Two additional source/native-adapter principal-switch cases and four browser cases were authored
after this 14-case checkpoint and remain unrun here. They address a valid pending selection as one
person surviving a later native sign-in as another person in the same browser. Parameterized native
callback path coverage is under review. Complete native MFA, collision, browser and current joined
acceptance remain open.

The restore audit also found that the full-dump restore script currently restores private
verification/session state without an explicit invalidation step. Private/nonportable status and a
five-minute expiry are not restore guarantees. Auth invalidation, preserved TOTP enrollment and
recovery-code reuse rules are separate unfinished M6 work; no successful restore claim is made.

The local gate log is `.local-m8-saml-self-link-db-first.log`. The isolated reset proof is
`.local/m7-latest-reset-proof.json`. The generated native XSD fixture emitted two Node listener-limit
warnings during repeated validation; they were not suppressed. No original platform database,
production credential, external identity provider or customer account was changed.

An attempted cleanup of this task's unused `.next/dev` cache was rejected before execution by
automatic approval review with “blocked by policy.” That cache was retained; no alternative deletion
was attempted.
