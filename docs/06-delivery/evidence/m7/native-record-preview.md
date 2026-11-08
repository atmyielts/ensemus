# Built native-record preview, 2026-11-08

This is a bounded **JavaScript-enabled Chrome** journey over the production standalone web build at
`27ada85`, through local HTTPS. It uses the owned fresh 66-migration PostgreSQL database and a separate
owned SeaweedFS/proxy project. No original user data, real provider credentials, external model,
payment processor, Temporal worker or deployed service is used. This is not the full browser suite.

Observed through actual browser forms:

1. Sign up a generated person and create their organization.
2. Create an Equipment record type without entering technical keys. Fill the first field and its
   required/filter checkboxes, then add a second field. Name, sensitivity and checked values remain;
   focus moves to the new field. Save succeeds with Serial and numeric Count fields.
3. Create a restricted record with `Count = 0`; the saved record visibly retains zero and Serial.
4. Type a new name and Serial, and lower sensitivity. The actual server refuses without recent MFA.
   The saved record remains unchanged, while the editor retains all new values and selected Internal
   sensitivity and displays the identity-verification link.
5. Open that link in a second tab, set up a real generated authenticator factor, and confirm its
   time-based code through the actual native form. No assurance row is seeded through SQL.
6. Return to the original tab: the typed name, Serial, sensitivity and zero are still present. Save
   succeeds and the actual record page shows the new name, Serial and Internal sensitivity.

Native CLI snapshots from `12:03:45` through `12:15:30` UTC record this journey under the ignored
`.playwright-cli` directory. Generated setup material is not included in this report. The screenshot
`output/playwright/m8-home-desktop.png` is an actual 1440×1000 baseline capture of the generated account,
not a mockup. It exposed a sidebar footer-height defect; a separate source fix and browser guard now
exist but require a fresh rendered check. A missing favicon also requires a rebuild after its source
asset is added.

No-JavaScript, changed-SSO, repeated version-conflict, foreign-viewer, map, full runtime/replay,
accessibility matrix and provider/production acceptance remain separate gates. The authored browser
regressions must still run; this report does not relabel them as passed.
