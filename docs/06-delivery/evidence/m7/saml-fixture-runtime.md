# Generated SAML fixture qualification

The real browser recovery gate exposed previously unexercised fixture defects after the native form
binding repair. Native ESM needed the pinned CommonJS module through `createRequire`; the generated
IdP then lacked its required schema validator, used a binding URI where the pinned metadata API
expects `post`, and supplied a full PEM certificate where the direct signature helper expects the
normalized certificate body. None of these failures was counted as successful SSO recovery.

The test workspace now pins `@authenio/samlify-node-xmllint` 2.0.0 and its locked `node-xmllint` 1.0.0
dependency. It validates requests against bundled protocol/assertion XML schemas, as required by the
[Samlify installation contract](https://github.com/tngan/samlify#schema-validation). No permissive
validator, production authentication dependency or proof seed was introduced. A semantic comparison
verified that these two packages are the only lockfile dependency additions; existing pins and the
previous lockfile formatting are preserved.

The two focused fixture units passed. They construct a real redirect request, validate it, produce an
RSA-SHA256 assertion, cryptographically verify the signature against the generated IdP metadata,
check request correlation and destination, and pass the exact encoded assertion through the actual
application input fence. Invalid request input is refused. The full joined unit run subsequently
passed **5,548 tests**, with two explicit skips across 244 files; all workspace type checks passed.

The clean native-form preview completed real enrollment and confirmation, SSO configuration, exact
operator review, activation and member admission. The subsequent browser callback still returned
400: process-only diagnostics identified a separate cross-implementation `Request` constructor
failure. The [public-fields replay repair](sso-request-replay-source.md) addresses that product defect.
The subsequent clean production callback passed that input-replay step and reached the native
`account_not_linked` refusal. The existing password account has an unverified local email; the native
library correctly refuses implicit email-based linking. An authenticated, explicit self-link flow
and its browser correlation are being implemented separately. Complete browser recovery acceptance
remains pending; fixture units and successful SSO setup do not qualify sign-in. No assertion, cookie,
setup key or provider credential is recorded in this report.
